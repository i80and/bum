import asyncio
import enum
import hashlib
import json
import logging
import mimetypes
import os
import socket
import struct
from asyncio import Future
from typing import Any, AsyncGenerator, AnyStr, Optional, Tuple, TypeVar, Iterable, List, Dict, \
    Union, AsyncIterator, AsyncIterable, NamedTuple

from tornado.iostream import IOStream
import pypledge
import tornado.ioloop
import tornado.locks
import tornado.gen
import tornado.process
import tornado.web

logger = logging.getLogger('bum')
message_header_t = struct.Struct('@III')
u32_t = struct.Struct('=L')
net_u32_t = struct.Struct('!L')
KB = 1024
T = TypeVar('T')


class Song(NamedTuple):
    id: str
    path: str
    title: str
    artist: str
    trackno: int
    discno: int
    album: str


class Album(NamedTuple):
    id: str
    title: str
    album_artist: str
    year: int
    tracks: List[str]
    cover_path: str


class TagsStanza(NamedTuple):
    hash: bytes
    title: bytes
    artist: bytes
    album: bytes
    track_string: bytes
    disc_string: bytes
    date_string: bytes


class Image(NamedTuple):
    data: bytes
    etag: str


def sandbox(pledges: Iterable[str]) -> None:
    try:
        pypledge.pledge(pledges)
    except OSError:
        pass


class AsyncCallback(AsyncIterator[T]):
    __slots__ = ('condition', 'value')

    def __init__(self) -> None:
        self.condition = tornado.locks.Condition()
        self.value = None  # type: Optional[T]

    def __call__(self, value: Optional[T]) -> None:
        self.value = value
        self.condition.notify()

    def stop(self) -> None:
        self(None)

    def __aiter__(self) -> AsyncIterator[T]:
        return self

    async def __anext__(self) -> T:
        await self.condition.wait()
        if self.value is None:
            raise StopAsyncIteration

        return self.value


async def read_message(sock: IOStream) -> Tuple[int, int, bytes]:
    message_header = await sock.read_bytes(message_header_t.size)
    message_id, status, message_length = message_header_t.unpack(message_header)
    message_body = await sock.read_bytes(message_length)

    return (message_id, status, message_body)


async def send_message(sock: IOStream, message_id: int, method: int, message: bytes) -> None:
    packed = message_header_t.pack(int(message_id), int(method), len(message))
    await sock.write(packed)
    await sock.write(message)


def chunks(l: List[T], n: int) -> Iterable[List[T]]:
    """Split a list into chunks of at most length n."""
    for i in range(0, len(l), n):
        yield l[i:(i + n)]


def song_to_json(song: Song) -> object:
    return {
        'id': song.id,
        'title': song.title,
        'artist': song.artist,
        'album_id': song.album
    }


def album_to_json(album: Album) -> object:
    return {
        'id': album.id,
        'title': album.title,
        'album_artist': album.album_artist,
        'year': album.year,
        'tracks': album.tracks,
    }


class CoordinatorMethods(enum.IntEnum):
    LIST_SONGS = 0
    LIST_ALBUMS = enum.auto()
    ALBUM_DETAILS = enum.auto()
    THUMBNAIL = enum.auto()
    COVER = enum.auto()
    TRANSCODE = enum.auto()
    GET_FILE = enum.auto()


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

    async def get_tags(self, paths: List[str]) -> AsyncGenerator[Tuple[TagsStanza, str], None]:
        for path_chunks in chunks(paths, 100):
            child = self.spawn('get-tags', path_chunks)
            output = await child.stdout.read_until_close()

            for line, path in zip(output.split(b'\n'), path_chunks):
                if not line:
                    continue

                yield (TagsStanza(*line.split(b'\x1c')), path)

    async def get_cover_stream(self, paths: List[str], thumbnail: bool) -> bytes:
        method = 'get-thumbnails' if thumbnail else 'get-cover'
        child = self.spawn(method, paths)
        output = await child.stdout.read_until_close()

        return output

    def transcode(self, path: AnyStr, cb: AsyncCallback) -> None:
        def streaming_callback(b: bytes) -> None:
            cb(b)

        def exit_callback(status: int) -> None:
            cb.stop()

        child = self.spawn('transcode-audio', [path])
        child.set_exit_callback(exit_callback)
        child.stdout.read_until_close(streaming_callback=cb)

    def spawn(self, cmd: str, cmd_args: List[Any]) -> tornado.process.Subprocess:
        args_list = [self.path, cmd] + cmd_args
        return tornado.process.Subprocess(args_list, stdout=tornado.process.Subprocess.STREAM)

bum_transcode = BumTranscode()


class MediaDatabase:
    COVER_FILES = ('cover.jpg', 'cover.png')
    FILE_EXTENSIONS = {'.opus', '.ogg', '.oga', '.flac', '.mp3', '.mp4', '.m4a', '.wma', '.wav'}

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

    async def load_files(self, paths: List[str]) -> None:
        album = None  # type: Optional[Album]
        current_album_title_bytes = None  # type: Optional[bytes]

        async for stanza, path in bum_transcode.get_tags(paths):
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

            if not album or current_album_title_bytes != stanza.album:
                current_album_title_bytes = stanza.album
                hasher = hashlib.md5()
                hasher.update(stanza.album)
                hasher.update(stanza.artist)
                album_id = hasher.hexdigest()

                cover_filename = path
                for candidate_filename in self.COVER_FILES:
                    candidate_path = os.path.join(dirname, candidate_filename)
                    if os.path.isfile(candidate_path):
                        cover_filename = candidate_path
                        break

                album = Album(album_id,
                              str(stanza.album, 'utf-8'),
                              str(stanza.artist, 'utf-8'),
                              year, [], cover_filename)
                self.albums[album.id] = album

            song = Song(str(stanza.hash, 'utf-8'),
                        path,
                        str(stanza.title, 'utf-8'),
                        str(stanza.artist, 'utf-8'), trackno, discno, album.id)
            self.songs[song.id] = song
            album.tracks.append(song.id)


class RPCClient:
    def __init__(self, sock: IOStream) -> None:
        self.sock = sock
        self.pending = {}  # type: Dict[int, Tuple[AsyncCallback[Tuple[int, bytes]], bool]]
        self.message_counter = 0

    async def subscribe(self,
                        method: int,
                        message: bytes,
                        subscribe: bool=True) -> AsyncIterable[Tuple[int, bytes]]:
        message_id = self.message_counter
        self.message_counter += 1

        await send_message(self.sock, message_id, int(method), message)
        condition = tornado.locks.Condition()
        sub = AsyncCallback()  # type: AsyncCallback[Tuple[int, bytes]]
        l = (sub, subscribe)
        self.pending[message_id] = l
        async for result in sub:
            yield result

    async def call(self, method: int, message: bytes) -> Tuple[int, bytes]:
        async for result in self.subscribe(method, message, subscribe=False):
            return result

        assert False

    async def run(self) -> None:
        while True:
            message_id, response, body = await read_message(self.sock)
            l = self.pending[message_id]
            if l[1] and len(body) == 0:
                del self.pending[message_id]
                l[0].stop()
                continue

            l[0]((response, body))


def start_web(port: int) -> IOStream:
    child_sock, parent_sock = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM, 0)

    pid = os.fork()
    if pid > 0:
        child_sock.close()
        return IOStream(parent_sock)

    parent_sock.close()
    stream = IOStream(child_sock)
    sandbox(['stdio', 'inet', 'unix'])

    image_cache = {}  # type: Dict[Tuple[bool, str], Image]
    rpc = RPCClient(stream)

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
            hasher = hashlib.md5()
            hasher.update(image_data)
            image = Image(image_data, '"{}"'.format(hasher.hexdigest()))
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

            provider = rpc.subscribe(CoordinatorMethods.TRANSCODE, bytes(song_id, 'utf-8'))
            async for _, chunk in provider:
                self.write(chunk)
                self.flush()

        def on_connection_close(self) -> None:
            pass

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

    app.listen(port, '127.0.0.1')
    tornado.ioloop.IOLoop.current().spawn_callback(rpc.run)
    tornado.ioloop.IOLoop.current().start()


class Coordinator:
    def __init__(self, db: MediaDatabase, sock: IOStream) -> None:
        self.db = db
        self.sock = sock

    def list_songs(self) -> bytes:
        songs = {}  # type: Dict[str, object]
        for song in self.db.songs.values():
            songs[song.id] = song_to_json(song)

        return bytes(json.dumps(songs), 'utf-8')

    def list_albums(self) -> bytes:
        albums = {}  # type: Dict[str, object]
        for album in self.db.albums.values():
            albums[album.id] = album_to_json(album)

        return bytes(json.dumps(albums), 'utf-8')

    def get_album(self, album_id: str) -> bytes:
        album = self.db.albums[album_id]
        return bytes(json.dumps(album_to_json(album)), 'utf-8')

    def get_static_file(self, path: str) -> Tuple[CoordinatorErrorCodes, bytes]:
        logger.info('Reading %s', path)
        root = '/Users/andrew/Documents/bum/client/build'
        path = os.path.join(root, path.lstrip('/'))
        path = os.path.realpath(path)
        if not path.startswith(root):
            return (CoordinatorErrorCodes.DENIED, b'')

        try:
            with open(path, 'rb') as f:
                result = f.read()
        except FileNotFoundError:
            return (CoordinatorErrorCodes.NO_MATCH, b'')
        except PermissionError:
            return (CoordinatorErrorCodes.DENIED, b'')

        return (CoordinatorErrorCodes.OK, result)

    async def transcode(self, web_sock: IOStream, message_id: int, song: Song):
        print('FOO')
        cb = AsyncCallback()  # type: AsyncCallback[bytes]
        bum_transcode.transcode(song.path, cb)
        async for chunk in cb:
            await send_message(web_sock, message_id, CoordinatorErrorCodes.OK, chunk)

        await send_message(web_sock, message_id, CoordinatorErrorCodes.OK, b'')


def run() -> None:
    logging.basicConfig(level=logging.INFO)
    web_sock = start_web(8000)

    sandbox(['stdio', 'unix', 'proc', 'exec', 'rpath'])
    db = MediaDatabase('/Users/andrew/Music')
    coordinator = Coordinator(db, web_sock)

    async def start() -> None:
        await db.scan()
        logger.info('Done scanning')

        while True:
            message_id, method, raw_body = await read_message(web_sock)
            print(method)
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
                elif method == CoordinatorMethods.GET_FILE:
                    path = str(raw_body, 'utf-8')
                    (response_code, response_body) = coordinator.get_static_file(path)
            except KeyError:
                response_code = CoordinatorErrorCodes.NO_MATCH
            except Exception as err:
                logger.exception('Coordinator error')
                response_code = CoordinatorErrorCodes.INTERNAL

            await send_message(web_sock, message_id, response_code, response_body)

    tornado.ioloop.IOLoop.current().spawn_callback(start)
    tornado.ioloop.IOLoop.current().start()

if __name__ == '__main__':
    run()
