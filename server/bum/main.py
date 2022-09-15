import asyncio
import enum
import json
import logging
import mimetypes
import os
import socket
import sys
import time
from pathlib import Path
from typing import AsyncIterable, Iterable, NamedTuple, Optional, Tuple, TypeVar

import pypledge
import tornado.platform.asyncio
import tornado.web

from . import net
from .media import Song
from .media_database import MediaDatabase, TranscodeError
from .net import AsyncSocket, RPCClient, read_message, send_message
from .worker import Worker

logger = logging.getLogger("bum")
CACHE_CONTROL_UNCHANGING = f"public, max-age={60 * 60 * 7}"
CACHE_CONTROL_TRANSIENT = f"public, max-age={60 * 60}"
T = TypeVar("T")


def compressible(mime: str) -> bool:
    return mime.startswith("text/") or mime in (
        "application/javascript",
        "image/svg+xml",
    )


class Image(NamedTuple):
    data: bytes
    etag: str


def chunks(l: list[T], n: int) -> Iterable[list[T]]:
    """Split a list into chunks of at most length n."""
    for i in range(0, len(l), n):
        yield l[i : (i + n)]


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
    TRANSCODE_ERROR = enum.auto()

    def to_http_code(self) -> int:
        if self == self.NO_MATCH:
            return 404
        elif self == self.BAD_METHOD:
            return 500
        elif self == self.DENIED:
            return 403
        elif self == self.INTERNAL:
            return 500
        elif self == self.TRANSCODE_ERROR:
            return 500

        return 200


def start_web(port: int) -> socket.socket:
    child_sock, parent_sock = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM, 0)

    pid = os.fork()
    if pid > 0:
        child_sock.close()
        return parent_sock

    parent_sock.close()
    tornado.platform.asyncio.AsyncIOMainLoop().install()

    hashing_worker = Worker()
    rpc: Optional[RPCClient] = None

    async def get_images(album_ids: list[str], thumbnail: bool) -> AsyncIterable[Image]:
        request_body = json.dumps(album_ids)
        method = CoordinatorMethods.THUMBNAIL if thumbnail else CoordinatorMethods.COVER
        code, result = await rpc.call(method, bytes(request_body, "utf-8"))
        if code != 0:
            raise KeyError("Error getting one or more cover images")

        for i, image_data in enumerate(net.unpack_sequence(result)):
            image_hash = await hashing_worker.hash(image_data)
            image = Image(image_data, '"{}"'.format(image_hash))
            yield image

    class StaticHandler(tornado.web.RequestHandler):
        async def get(self, path: str) -> None:
            if not path:
                path = "index.html"

            code, result = await rpc.call(
                CoordinatorMethods.GET_FILE, bytes(path, "utf-8")
            )
            if code != 0:
                self.set_status(CoordinatorErrorCodes(code).to_http_code())
                self.finish()
                return

            mimetype, _ = mimetypes.guess_type(path)
            if mimetype is None:
                mimetype = "binary/octet-stream"

            if compressible(mimetype) and "gzip" in self.request.headers.get(
                "Accept-Encoding", ""
            ):
                self.set_header("Content-Encoding", "gzip")
                result = await hashing_worker.gzip(result)

            self.set_header("Content-Type", mimetype)
            self.set_header("Vary", "Accept-Encoding")
            self.set_header("Cache-Control", CACHE_CONTROL_TRANSIENT)
            self.write(result)

    class ListSongsHandler(tornado.web.RequestHandler):
        async def get(self) -> None:
            code, result = await rpc.call(CoordinatorMethods.LIST_SONGS, b"")
            if code != 0:
                self.set_status(CoordinatorErrorCodes(code).to_http_code())
                self.finish()
                return

            if "gzip" in self.request.headers.get("Accept-Encoding", ""):
                self.set_header("Content-Encoding", "gzip")
                result = await hashing_worker.gzip(result)

            self.set_header("Content-Type", "application/json")
            self.set_header("Vary", "Accept-Encoding")
            self.set_header("Cache-Control", CACHE_CONTROL_TRANSIENT)
            self.write(result)

    class SongHandler(tornado.web.RequestHandler):
        async def get(self, song_id: str) -> None:
            self.done = False
            self.canceled = False
            self.set_header("Content-Type", "audio/webm")

            # Unfortunately, we can't promise that the transcode will
            # complete successfully.
            self.set_header("Pragma", "no-cache")

            self.message_id = rpc.get_message_id()
            provider = rpc.subscribe(
                CoordinatorMethods.TRANSCODE,
                bytes(song_id, "utf-8"),
                message_id=self.message_id,
            )
            async for code, chunk in provider:
                if code != 0:
                    if self.canceled:
                        return

                    raise TranscodeError(song_id, code)

                if not chunk:
                    break

                self.write(chunk)
                self.flush()

            self.done = True

        def on_connection_close(self) -> None:
            if self.done:
                return

            self.canceled = True
            asyncio.ensure_future(
                rpc.call(
                    CoordinatorMethods.CANCEL_TRANSCODE, b"", message_id=self.message_id
                )
            )

    class ListAlbumsHandler(tornado.web.RequestHandler):
        async def get(self) -> None:
            code, result = await rpc.call(CoordinatorMethods.LIST_ALBUMS, b"")
            if code != 0:
                self.set_status(CoordinatorErrorCodes(code).to_http_code())
                self.finish()
                return

            if "gzip" in self.request.headers.get("Accept-Encoding", ""):
                self.set_header("Content-Encoding", "gzip")
                result = await hashing_worker.gzip(result)

            self.set_header("Content-Type", "application/json")
            self.set_header("Vary", "Accept-Encoding")
            self.set_header("Cache-Control", CACHE_CONTROL_TRANSIENT)
            self.write(result)

    class AlbumHandler(tornado.web.RequestHandler):
        async def get(self, album_id: str) -> None:
            code, result = await rpc.call(
                CoordinatorMethods.ALBUM_DETAILS, bytes(album_id, "utf-8")
            )
            if code != 0:
                self.set_status(CoordinatorErrorCodes(code).to_http_code())
                self.finish()
                return

            if "gzip" in self.request.headers.get("Accept-Encoding", ""):
                self.set_header("Content-Encoding", "gzip")
                result = await hashing_worker.gzip(result)

            self.set_header("Content-Type", "application/json")
            self.set_header("Vary", "Accept-Encoding")
            self.set_header("Cache-Control", CACHE_CONTROL_TRANSIENT)
            self.write(result)

    class AlbumArtHandler(tornado.web.RequestHandler):
        async def get(self, album_id: str) -> None:
            async for image in get_images([album_id], False):
                if len(image.data) == 0:
                    self.set_status(404)
                    self.finish()
                    return

                if self.request.headers.get("If-None-Match", "") == image.etag:
                    self.set_status(304)
                    return

                self.set_header("Content-Type", "image/jpeg")
                self.set_header("Cache-Control", CACHE_CONTROL_UNCHANGING)
                self.set_header("ETag", image.etag)
                self.write(image.data)

                break

    class ThumbnailHandler(tornado.web.RequestHandler):
        async def get(self) -> None:
            raw_album_ids = str(
                self.request.query_arguments.get("ids", [b""])[0], "utf-8"
            )
            album_ids = raw_album_ids.split(",")
            self.set_header("Content-Type", "binary/octet-stream")
            self.set_header("Cache-Control", CACHE_CONTROL_UNCHANGING)

            async for image in get_images(album_ids, True):
                self.write(net.net_u32_t.pack(len(image.data)))
                self.write(image.data)

    app = tornado.web.Application(
        [
            (r"/api/music/songs", ListSongsHandler),
            (r"/api/music/song/([\w\\-]+)/stream", SongHandler),
            (r"/api/music/albums", ListAlbumsHandler),
            (r"/api/music/album/([\w\\-]+)/metadata", AlbumHandler),
            (r"/api/music/album/([\w\\-]+)/cover", AlbumArtHandler),
            (r"/api/music/thumbnail", ThumbnailHandler),
            (r"/(.*)", StaticHandler),
        ]
    )

    async def setup() -> None:
        nonlocal rpc
        rpc = RPCClient(await AsyncSocket.create(child_sock))
        await rpc.run()

    app.listen(port, "127.0.0.1")
    asyncio.ensure_future(setup())
    sandbox(["stdio", "inet", "unix"])
    asyncio.get_event_loop().run_forever()
    assert False


class Coordinator:
    STATIC_ROOT = os.path.realpath(os.environ.get("STATIC_ROOT", "../client/build"))

    def __init__(self, db: MediaDatabase, sock: AsyncSocket) -> None:
        self.db = db
        self.sock = sock

    def list_songs(self) -> bytes:
        songs = {"songs": [s.to_json() for s in self.db.songs.values()]}
        return bytes(json.dumps(songs), "utf-8")

    def list_albums(self) -> bytes:
        albums = {"albums": [a.to_json() for a in self.db.albums.values()]}
        return bytes(json.dumps(albums), "utf-8")

    def get_album(self, album_id: str) -> bytes:
        album = self.db.albums[album_id]
        return bytes(json.dumps(album.to_json()), "utf-8")

    def get_static_file(self, path: str) -> Tuple[CoordinatorErrorCodes, bytes]:
        logger.info("Reading %s", path)
        path = os.path.join(self.STATIC_ROOT, path.lstrip("/"))
        path = os.path.realpath(path)
        if not path.startswith(self.STATIC_ROOT):
            return (CoordinatorErrorCodes.DENIED, b"")

        try:
            with open(path, "rb") as f:
                result = f.read()
        except FileNotFoundError:
            return (CoordinatorErrorCodes.NO_MATCH, b"")
        except PermissionError:
            return (CoordinatorErrorCodes.DENIED, b"")

        return (CoordinatorErrorCodes.OK, result)

    async def transcode(
        self, web_sock: AsyncSocket, message_id: int, song: Song
    ) -> None:
        try:
            async for chunk in self.db.bum_transcode.transcode(message_id, song.path):
                await send_message(
                    web_sock, message_id, CoordinatorErrorCodes.OK, chunk
                )

            await send_message(web_sock, message_id, CoordinatorErrorCodes.OK, b"")
        except TranscodeError:
            await send_message(
                web_sock, message_id, CoordinatorErrorCodes.TRANSCODE_ERROR, b""
            )


def run() -> None:
    logging.basicConfig(level=logging.INFO)
    mimetypes.init()
    if len(sys.argv) < 2:
        sys.exit(1)

    web_raw_sock = start_web(8000)

    sandbox(["stdio", "unix", "proc", "exec", "rpath"])
    db = MediaDatabase(Path(sys.argv[1]))

    async def start() -> None:
        web_sock = await AsyncSocket.create(web_raw_sock)
        coordinator = Coordinator(db, web_sock)
        start = time.time()
        await db.scan()
        logger.info("Done scanning in %fs", time.time() - start)

        while True:
            message_id, method, raw_body = await read_message(web_sock)
            response_body = b""
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
                    response_body = coordinator.get_album(str(raw_body, "utf-8"))
                elif (
                    method == CoordinatorMethods.THUMBNAIL
                    or method == CoordinatorMethods.COVER
                ):
                    response_code = CoordinatorErrorCodes.OK
                    album_ids = json.loads(str(raw_body, "utf-8"))
                    covers: list[Path] = []
                    for album_id in album_ids:
                        album = db.albums.get(album_id, None)
                        if album is not None:
                            covers.append(album.cover_path)
                        else:
                            covers.append(Path(""))
                    thumbnail = method == CoordinatorMethods.THUMBNAIL
                    response_body = await db.get_covers(covers, thumbnail)
                elif method == CoordinatorMethods.TRANSCODE:
                    response_code = CoordinatorErrorCodes.OK
                    song = db.songs[str(raw_body, "utf-8")]
                    asyncio.ensure_future(
                        coordinator.transcode(web_sock, message_id, song)
                    )
                    continue
                elif method == CoordinatorMethods.CANCEL_TRANSCODE:
                    response_code = CoordinatorErrorCodes.OK
                    db.bum_transcode.cancel_transcode(message_id)
                elif method == CoordinatorMethods.GET_FILE:
                    path = str(raw_body, "utf-8")
                    (response_code, response_body) = coordinator.get_static_file(path)
            except KeyError:
                response_code = CoordinatorErrorCodes.NO_MATCH
            except Exception:
                logger.exception("Coordinator error")
                response_code = CoordinatorErrorCodes.INTERNAL

            await send_message(web_sock, message_id, response_code, response_body)

    try:
        asyncio.ensure_future(start())
        asyncio.get_event_loop().run_forever()
    finally:
        db.close()


if __name__ == "__main__":
    run()
