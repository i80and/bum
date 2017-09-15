import asyncio
import concurrent.futures
import enum
import hashlib
import json
import logging
import mimetypes
import os
import socket
import struct
import sys
import time
from asyncio import Future
from typing import Any, AsyncGenerator, AnyStr, Optional, Tuple, TypeVar, Iterable, List, Dict, \
    Union, AsyncIterator, AsyncIterable, NamedTuple

import pypledge
import tornado.platform.asyncio
import tornado.web

from bum.net import AsyncSocket, RPCClient, send_message, read_message
from bum.media import Song, Album, TagsStanza

logger = logging.getLogger('bum')
u64_t = struct.Struct('=Q')
u32_t = struct.Struct('=L')
net_u32_t = struct.Struct('!L')
KB = 1024
T = TypeVar('T')


class HashingWorker:
    def __init__(self) -> None:
        self.pool = concurrent.futures.ThreadPoolExecutor(max_workers=1)

    async def hash(self, data: bytes, digest_size: int=16) -> str:
        future = self.pool.submit(self._hash, data, digest_size)
        return await asyncio.wrap_future(future)

    def close(self) -> None:
        self.pool.shutdown()

    def __enter__(self) -> 'HashingWorker':
        return self

    def __exit__(self, *args: Any) -> bool:
        self.close()
        return False

    @staticmethod
    def _hash(data: bytes, digest_size: int) -> str:
        return hashlib.blake2b(data, digest_size=digest_size).hexdigest()


class Image(NamedTuple):
    data: bytes
    etag: str


def chunks(l: List[T], n: int) -> Iterable[List[T]]:
    """Split a list into chunks of at most length n."""
    for i in range(0, len(l), n):
        yield l[i:(i + n)]


def sandbox(pledges: Iterable[str]) -> None:
    try:
        pypledge.pledge(pledges)
    except OSError:
        pass


class CoordinatorMethods(enum.IntEnum):
    LIST_SONGS = 0
    LIST_ALBUMS = enum.auto()
    ALBUM_DETAILS = enum.auto()
    THUMBNAIL = enum.auto()
    COVER = enum.auto()
    TRANSCODE = enum.auto()
    GET_FILE = enum.auto()
    CANCEL_TRANSCODE = enum.auto()


class CoordinatorErrorCodes(enum.IntEnum):
    OK = 0
    NO_MATCH = enum.auto()
    BAD_METHOD = enum.auto()
    DENIED = enum.auto()
    INTERNAL = enum.auto()

    def to_http_code(self) -> int:
        if self == self.NO_MATCH:
            return 404
        elif self == self.BAD_METHOD:
            return 500
        elif self == self.DENIED:
            return 403
        elif self == self.INTERNAL:
            return 500

        return 200


class BumTranscode:
    def __init__(self) -> None:
        self.path = './transcoder/build/bum-transcode'
        self.transcoders = {}  # type: Dict[int, asyncio.subprocess.Process]

    async def get_tags(self, paths: List[str]) -> AsyncGenerator[Tuple[TagsStanza, str], None]:
        for path_chunks in chunks(paths, 100):
            child = await self.spawn('get-tags', path_chunks)
            assert child.stdout is not None
            output = await child.stdout.read()

            for line, path in zip(output.split(b'\n'), path_chunks):
                if not line:
                    continue

                yield (TagsStanza(*line.split(b'\x1c')), path)

    async def get_cover_stream(self, paths: List[str], thumbnail: bool) -> bytes:
        method = 'get-thumbnails' if thumbnail else 'get-cover'
        child = await self.spawn(method, paths)
        assert child.stdout is not None
        output = await child.stdout.read()

        return output

    async def transcode(self, handle: int, path: AnyStr) -> AsyncIterable[bytes]:
        child = await self.spawn('transcode-audio', [path])
        assert child.stdout is not None
        self.transcoders[handle] = child
        try:
            while True:
                buf = await child.stdout.read(64 * KB)
                if buf == b'':
                    return

                yield buf
        finally:
            del self.transcoders[handle]

    def cancel_transcode(self, handle: int) -> None:
        try:
            self.transcoders[handle].kill()
        except KeyError:
            pass

    async def spawn(self, cmd: str, cmd_args: List[Any]) -> asyncio.subprocess.Process:
        args_list = [self.path, cmd] + cmd_args
        return await asyncio.create_subprocess_exec(
            *args_list,
            stdout=asyncio.subprocess.PIPE,
            stderr=None,
            stdin=asyncio.subprocess.PIPE)

bum_transcode = BumTranscode()


class MediaDatabase:
    COVER_FILES = ('cover.jpg', 'cover.png')
    FILE_EXTENSIONS = {'.opus', '.ogg', '.oga', '.flac', '.mp3', '.mp4', '.m4a', '.wma', '.wav'}

    class MediaLoadContext:
        def __init__(self) -> None:
            self.album = None  # type: Optional[Album]
            self.current_album_title_bytes = None  # type: Optional[bytes]

    def __init__(self, root: str) -> None:
        self.root = root
        self.albums = {}  # type: Dict[str, Album]
        self.songs = {}  # type: Dict[str, Song]

    async def scan(self) -> None:
        paths = []  # type: List[str]
        for root, dirs, files in os.walk(self.root):
            for filename in files:
                _, ext = os.path.splitext(filename)
                if ext not in self.FILE_EXTENSIONS:
                    continue

                paths.append(os.path.join(root, filename))

        await self.load_files(paths)

    async def load_file(self,
                        path: str,
                        stanza: TagsStanza,
                        ctx: MediaLoadContext,
                        hashing_worker: HashingWorker) -> None:
        dirname = os.path.dirname(path)

        try:
            disc_string = stanza.disc_string.split(b'/')[0] \
                if b'/' in stanza.disc_string else stanza.disc_string
            discno = int(disc_string)
        except ValueError:
            discno = 1

        try:
            track_string = stanza.track_string.split(b'/')[0] \
                if b'/' in stanza.track_string else stanza.track_string
            trackno = int(track_string)
        except ValueError:
            trackno = -1

        try:
            year = int(stanza.date_string)
        except ValueError:
            year = 0

        if not ctx.album or ctx.current_album_title_bytes != stanza.album:
            ctx.current_album_title_bytes = stanza.album
            hasher = hashlib.blake2b(digest_size=16)
            hasher.update(stanza.album)
            hasher.update(stanza.artist)
            album_id = hasher.hexdigest()

            cover_filename = path
            for candidate_filename in self.COVER_FILES:
                candidate_path = os.path.join(dirname, candidate_filename)
                if os.path.isfile(candidate_path):
                    cover_filename = candidate_path
                    break

            ctx.album = Album(album_id,
                              str(stanza.album, 'utf-8'),
                              str(stanza.artist, 'utf-8'),
                              year, [], cover_filename)
            self.albums[ctx.album.id] = ctx.album

        hasher = hashlib.blake2b(digest_size=16)
        hasher.update(stanza.artist)
        hasher.update(stanza.title)
        song_id = '{}-{}-{}-{}'.format(hasher.hexdigest(), year, trackno, discno)
        song = Song(song_id,
                    path,
                    str(stanza.title, 'utf-8'),
                    str(stanza.artist, 'utf-8'), trackno, discno, ctx.album.id)
        self.songs[song.id] = song
        ctx.album.tracks.append(song.id)

    async def load_files(self, paths: List[str]) -> None:
        ctx = self.MediaLoadContext()
        with HashingWorker() as hashing_worker:
            async for stanza, path in bum_transcode.get_tags(paths):
                await self.load_file(path, stanza, ctx, hashing_worker)


def start_web(port: int) -> socket.socket:
    child_sock, parent_sock = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM, 0)

    pid = os.fork()
    if pid > 0:
        child_sock.close()
        return parent_sock

    parent_sock.close()
    tornado.platform.asyncio.AsyncIOMainLoop().install()

    hashing_worker = HashingWorker()
    image_cache = {}  # type: Dict[Tuple[bool, str], Image]
    rpc = None  # type: Optional[RPCClient]

    async def get_images(album_ids: List[str], thumbnail: bool) -> AsyncIterable[Image]:
        missing = []  # type: List[str]

        for album_id in album_ids:
            key = (thumbnail, album_id)
            if key in image_cache:
                yield image_cache[key]
            elif album_id:
                missing.append(album_id)

        if not missing:
            return

        request_body = json.dumps(missing)
        method = CoordinatorMethods.THUMBNAIL if thumbnail else CoordinatorMethods.COVER
        code, result = await rpc.call(method, bytes(request_body, 'utf-8'))
        if code != 0:
            raise KeyError('Error getting one or more cover images')

        view = memoryview(result)
        i = 0
        while len(view) > 0:
            image_size, = u32_t.unpack_from(view)
            image_data = view[u32_t.size:(u32_t.size + image_size)].tobytes()
            image_hash = await hashing_worker.hash(image_data)
            image = Image(image_data, '"{}"'.format(image_hash))
            image_cache[(thumbnail, missing[i])] = image
            yield image

            i += 1
            view = view[(u32_t.size + image_size):]

    class MainHandler(tornado.web.RequestHandler):
        async def get(self, path: str) -> None:
            if not path:
                path = 'index.html'

            code, result = await rpc.call(CoordinatorMethods.GET_FILE, bytes(path, 'utf-8'))
            if code != 0:
                self.set_status(CoordinatorErrorCodes(code).to_http_code())
                self.finish()
                return

            self.write(result)
            file_type, _ = mimetypes.guess_type(path)
            if file_type is None:
                file_type = 'binary/octet-stream'

            self.set_header('Content-Type', file_type)

    class ListSongsHandler(tornado.web.RequestHandler):
        async def get(self) -> None:
            code, result = await rpc.call(CoordinatorMethods.LIST_SONGS, b'')
            if code != 0:
                self.set_status(CoordinatorErrorCodes(code).to_http_code())
                self.finish()
                return

            self.write(result)
            self.set_header('Content-Type', 'application/json')

    class SongHandler(tornado.web.RequestHandler):
        async def get(self, song_id: str) -> None:
            self.set_header('Content-Type', 'audio/webm')

            self.message_id = rpc.get_message_id()
            provider = rpc.subscribe(CoordinatorMethods.TRANSCODE,
                                     bytes(song_id, 'utf-8'),
                                     message_id=self.message_id)
            async for _, chunk in provider:
                self.write(chunk)
                self.flush()

        def on_connection_close(self) -> None:
            rpc.cancel(self.message_id)
            asyncio.ensure_future(
                rpc.call(CoordinatorMethods.CANCEL_TRANSCODE, b'', message_id=self.message_id))

    class ListAlbumsHandler(tornado.web.RequestHandler):
        async def get(self) -> None:
            code, result = await rpc.call(CoordinatorMethods.LIST_ALBUMS, b'')
            if code != 0:
                self.set_status(CoordinatorErrorCodes(code).to_http_code())
                self.finish()
                return

            self.write(result)
            self.set_header('Content-Type', 'application/json')

    class AlbumHandler(tornado.web.RequestHandler):
        async def get(self, album_id: str) -> None:
            code, result = await rpc.call(CoordinatorMethods.ALBUM_DETAILS,
                                          bytes(album_id, 'utf-8'))
            if code != 0:
                self.set_status(CoordinatorErrorCodes(code).to_http_code())
                self.finish()
                return

            self.write(result)
            self.set_header('Content-Type', 'application/json')

    class AlbumArtHandler(tornado.web.RequestHandler):
        async def get(self, album_id: str) -> None:
            async for image in get_images([album_id], False):
                if len(image.data) == 0:
                    self.set_status(404)
                    self.finish()
                    return

                if self.request.headers.get('If-None-Match', '') == image.etag:
                    self.set_status(304)
                    return

                self.set_header('Content-Type', 'image/jpeg')
                self.set_header('Cache-Control', 'public, max-age=15768000')
                self.set_header('ETag', image.etag)
                self.write(image.data)

                break

    class ThumbnailHandler(tornado.web.RequestHandler):
        async def get(self) -> None:
            raw_album_ids = str(self.request.query_arguments.get('ids', [b''])[0], 'utf-8')
            album_ids = raw_album_ids.split(',')
            self.set_header('Content-Type', 'binary/octet-stream')

            async for image in get_images(album_ids, True):
                self.write(net_u32_t.pack(len(image.data)))
                self.write(image.data)

    app = tornado.web.Application([
        (r'/api/music/songs', ListSongsHandler),
        (r'/api/music/song/([\w\\-]+)/stream', SongHandler),
        (r'/api/music/albums', ListAlbumsHandler),
        (r'/api/music/album/([\w\\-]+)/metadata', AlbumHandler),
        (r'/api/music/album/([\w\\-]+)/cover', AlbumArtHandler),
        (r'/api/music/thumbnail', ThumbnailHandler),
        (r'/(.*)', MainHandler)
    ])

    async def setup() -> None:
        nonlocal rpc
        rpc = RPCClient(await AsyncSocket.create(child_sock))
        await rpc.run()

    app.listen(port, '127.0.0.1')
    asyncio.ensure_future(setup())
    sandbox(['stdio', 'inet', 'unix'])
    asyncio.get_event_loop().run_forever()
    assert False


class Coordinator:
    STATIC_ROOT = os.path.realpath(os.environ.get('STATIC_ROOT', '../client/build'))

    def __init__(self, db: MediaDatabase, sock: AsyncSocket) -> None:
        self.db = db
        self.sock = sock

    def list_songs(self) -> bytes:
        songs = {}  # type: Dict[str, object]
        for song in self.db.songs.values():
            songs[song.id] = song.to_json()

        return bytes(json.dumps(songs), 'utf-8')

    def list_albums(self) -> bytes:
        albums = {}  # type: Dict[str, object]
        for album in self.db.albums.values():
            albums[album.id] = album.to_json()

        return bytes(json.dumps(albums), 'utf-8')

    def get_album(self, album_id: str) -> bytes:
        album = self.db.albums[album_id]
        return bytes(json.dumps(album.to_json()), 'utf-8')

    def get_static_file(self, path: str) -> Tuple[CoordinatorErrorCodes, bytes]:
        logger.info('Reading %s', path)
        path = os.path.join(self.STATIC_ROOT, path.lstrip('/'))
        path = os.path.realpath(path)
        if not path.startswith(self.STATIC_ROOT):
            return (CoordinatorErrorCodes.DENIED, b'')

        try:
            with open(path, 'rb') as f:
                result = f.read()
        except FileNotFoundError:
            return (CoordinatorErrorCodes.NO_MATCH, b'')
        except PermissionError:
            return (CoordinatorErrorCodes.DENIED, b'')

        return (CoordinatorErrorCodes.OK, result)

    async def transcode(self, web_sock: AsyncSocket, message_id: int, song: Song):
        async for chunk in bum_transcode.transcode(message_id, song.path):
            await send_message(web_sock, message_id, CoordinatorErrorCodes.OK, chunk)

        await send_message(web_sock, message_id, CoordinatorErrorCodes.OK, b'')


def run() -> None:
    logging.basicConfig(level=logging.INFO)
    if len(sys.argv) < 2:
        sys.exit(1)

    web_raw_sock = start_web(8000)

    sandbox(['stdio', 'unix', 'proc', 'exec', 'rpath'])
    db = MediaDatabase(sys.argv[1])

    async def start() -> None:
        web_sock = await AsyncSocket.create(web_raw_sock)
        coordinator = Coordinator(db, web_sock)
        start = time.time()
        await db.scan()
        logger.info('Done scanning in %fs', time.time() - start)

        while True:
            message_id, method, raw_body = await read_message(web_sock)
            response_body = b''
            response_code = CoordinatorErrorCodes.BAD_METHOD

            try:
                if method == CoordinatorMethods.LIST_SONGS:
                    response_code = CoordinatorErrorCodes.OK
                    response_body = coordinator.list_songs()
                elif method == CoordinatorMethods.LIST_ALBUMS:
                    response_code = CoordinatorErrorCodes.OK
                    response_body = coordinator.list_albums()
                elif method == CoordinatorMethods.ALBUM_DETAILS:
                    response_code = CoordinatorErrorCodes.OK
                    response_body = coordinator.get_album(str(raw_body, 'utf-8'))
                elif method == CoordinatorMethods.THUMBNAIL or method == CoordinatorMethods.COVER:
                    response_code = CoordinatorErrorCodes.OK
                    album_ids = json.loads(str(raw_body, 'utf-8'))
                    covers = []  # type: List[str]
                    for album_id in album_ids:
                        album = db.albums.get(album_id, None)
                        if album is not None:
                            covers.append(album.cover_path)
                        else:
                            covers.append('')
                    thumbnail = (method == CoordinatorMethods.THUMBNAIL)
                    response_body = await bum_transcode.get_cover_stream(covers, thumbnail)
                elif method == CoordinatorMethods.TRANSCODE:
                    response_code = CoordinatorErrorCodes.OK
                    song = db.songs[str(raw_body, 'utf-8')]
                    asyncio.ensure_future(coordinator.transcode(web_sock, message_id, song))
                    continue
                elif method == CoordinatorMethods.CANCEL_TRANSCODE:
                    response_code = CoordinatorErrorCodes.OK
                    bum_transcode.cancel_transcode(message_id)
                elif method == CoordinatorMethods.GET_FILE:
                    path = str(raw_body, 'utf-8')
                    (response_code, response_body) = coordinator.get_static_file(path)
            except KeyError:
                response_code = CoordinatorErrorCodes.NO_MATCH
            except Exception as err:
                logger.exception('Coordinator error')
                response_code = CoordinatorErrorCodes.INTERNAL

            await send_message(web_sock, message_id, response_code, response_body)

    asyncio.ensure_future(start())
    asyncio.get_event_loop().run_forever()

if __name__ == '__main__':
    run()
