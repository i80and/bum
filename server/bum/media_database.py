import asyncio
import hashlib
import logging
import os
from pathlib import Path
import mimetypes
from typing import AsyncIterable, Optional, Sequence, Tuple, AsyncIterator, Final

import mutagen

from . import net
from .media import Album, Song
from .worker import Worker

logger = logging.getLogger("MediaDatabase")
KB = 1024


class TranscodeError(Exception):
    pass


def get_cover_from_mutagen(mutagen_file: mutagen.FileType) -> Optional[bytes]:
    if isinstance(mutagen_file, mutagen.mp3.MP3):
        pics = mutagen_file.tags.getall("APIC") + mutagen_file.tags.getall("PIC")
        for p in pics:
            if p.type == mutagen.id3.PictureType.COVER_FRONT:
                return p.data
    elif isinstance(mutagen_file, mutagen.flac.FLAC):
        for p in mutagen_file.pictures:
            if p.type == mutagen.id3.PictureType.COVER_FRONT:
                return p.data
    return None


class BumTranscode:
    def __init__(self) -> None:
        self.path = Path("./transcoder2/target/release/transcoder2")
        self.transcoders: dict[int, Optional[asyncio.subprocess.Process]] = {}

    async def get_cover_stream(
        self, paths: Sequence[Path], thumbnail: bool
    ) -> AsyncIterator[Tuple[Path, Optional[bytes]]]:
        method = "get-thumbnails" if thumbnail else "get-cover"
        child = await self.spawn(method, [])

        assert child.stdout is not None
        assert child.stdin is not None

        stdout: Final[asyncio.StreamReader] = child.stdout
        stdin: Final[asyncio.StreamWriter] = child.stdin

        results_queue: asyncio.queues.Queue[
            Optional[Tuple[Path, Optional[bytes]]]
        ] = asyncio.queues.Queue()

        async def feeder_thread_function() -> None:
            def feed(path: Path, data: Optional[bytes]) -> None:
                path_string = bytes(str(path), "utf-8")
                stdin.write(net.net_u32_t.pack(len(path_string)))
                stdin.write(net.net_u32_t.pack(len(data) if data is not None else 0))
                stdin.write(path_string)
                if data is not None:
                    stdin.write(data)

            i = 0
            for path in paths:
                i += 1
                image_type, encoding = mimetypes.guess_type(path)
                if image_type is None:
                    logger.error("Cannot determine file type of %s", path)
                    await results_queue.put((path, None))
                    continue

                if image_type.startswith("image"):
                    feed(path, None)
                else:
                    try:
                        parsed_file = mutagen.File(path)
                    except mutagen.MutagenError as err:
                        logger.error('Error loading %s: "%s"', path, err)
                        await results_queue.put((path, None))
                        continue

                    image = get_cover_from_mutagen(parsed_file)
                    feed(path, image)
            stdin.close()

        async def reader_thread_function() -> None:
            try:
                while True:
                    try:
                        path_len_raw = await stdout.readexactly(4)
                        data_len_raw = await stdout.readexactly(4)

                        path_len = net.net_u32_t.unpack(path_len_raw)[0]
                        data_len = net.net_u32_t.unpack(data_len_raw)[0]

                        path_bytes = await stdout.readexactly(path_len)
                        data_bytes = await stdout.readexactly(data_len)

                        await results_queue.put(
                            (
                                Path(str(path_bytes, "utf-8")),
                                data_bytes if data_bytes else None,
                            )
                        )
                    except asyncio.exceptions.IncompleteReadError as err:
                        if err.partial:
                            logger.error("Suspicious partial read")
                        return
            finally:
                await results_queue.put(None)

        asyncio.create_task(feeder_thread_function())
        asyncio.create_task(reader_thread_function())

        while True:
            result = await results_queue.get()
            if result is None:
                return
            yield result

    async def transcode(self, handle: int, path: Path) -> AsyncIterable[bytes]:
        self.transcoders[handle] = None

        child = await self.spawn("transcode-audio", [path])
        assert child.stdout is not None

        # If we got canceled before we could get started, abort
        if handle not in self.transcoders:
            child.kill()
            return

        self.transcoders[handle] = child
        try:
            while True:
                buf = await child.stdout.read(64 * KB)
                if buf == b"":
                    return

                yield buf
        finally:
            del self.transcoders[handle]
            if await child.wait() != 0:
                raise TranscodeError(path)

    def cancel_transcode(self, handle: int) -> None:
        try:
            child = self.transcoders[handle]
            if child:
                child.kill()
            else:
                del self.transcoders[handle]
        except KeyError:
            pass

    async def spawn(
        self,
        cmd: str,
        cmd_args: Sequence[str | bytes | os.PathLike[str] | os.PathLike[bytes]],
    ) -> asyncio.subprocess.Process:
        args_list: list[str | bytes | os.PathLike[str] | os.PathLike[bytes]] = [
            self.path,
            cmd,
            *cmd_args,
        ]
        return await asyncio.create_subprocess_exec(
            *args_list,
            stdout=asyncio.subprocess.PIPE,
            stderr=None,
            stdin=asyncio.subprocess.PIPE,
        )


class MediaDatabase:
    COVER_FILES = ("cover.jpg", "cover.jpeg", "cover.png", "cover.webp")
    FILE_EXTENSIONS = {
        ".opus",
        ".ogg",
        ".oga",
        ".flac",
        ".mp3",
        ".mp4",
        ".m4a",
        ".wma",
        ".wav",
    }

    class MediaLoadContext:
        def __init__(self) -> None:
            self.album: Optional[Album] = None
            self.current_album_title: Optional[str] = None

    def __init__(self, root: Path) -> None:
        self.root = root
        self.albums: dict[str, Album] = {}
        self.songs: dict[str, Song] = {}

        self.bum_transcode = BumTranscode()

        self.image_cache: dict[Tuple[bool, Path], bytes] = {}

    async def scan(self) -> None:
        logger.debug("Beginning scan")
        paths: list[Path] = []
        for path in self.root.glob("**/*"):
            if path.suffix not in self.FILE_EXTENSIONS:
                continue

            paths.append(path)

        logger.debug("Loading %s files", len(paths))
        await self.load_files(paths)
        logger.debug("Loaded!")

        logger.debug("Caching thumbnails...")
        await self.get_covers(
            [album.cover_path for album in self.albums.values()], True
        )
        logger.debug("Done caching thumbnails!")

    async def load_file(
        self, path: Path, ctx: MediaLoadContext, hashing_worker: Worker
    ) -> None:
        dirname = path.parent

        try:
            data = mutagen.File(path, easy=True)
        except mutagen.MutagenError as err:
            logger.error('Error loading %s: "%s"', path, err)
            return

        raw_disc = data.get("discnumber", [""])[0]
        raw_track = data.get("tracknumber", [""])[0]
        raw_date = ""
        for candidate in ("date", "year"):
            if candidate in data:
                raw_date = data[candidate][0]
        raw_album = data.get("album", [""])[0]
        raw_artist = data.get("artist", [""])[0]
        raw_title = data.get("title", [""])[0]

        try:
            disc_string = raw_disc.split("/")[0] if "/" in raw_disc else raw_disc
            discno = int(disc_string)
        except ValueError:
            discno = 1

        try:
            track_string = raw_track.split("/")[0] if "/" in raw_track else raw_track
            trackno = int(track_string)
        except ValueError:
            trackno = -1

        try:
            year = int(raw_date)
        except ValueError:
            year = 0

        if not ctx.album or ctx.current_album_title != raw_album:
            ctx.current_album_title = raw_album
            hasher = hashlib.blake2b(digest_size=16)
            hasher.update(bytes(raw_album, "utf-8"))
            hasher.update(bytes(raw_artist, "utf-8"))
            album_id = hasher.hexdigest()

            cover_filename = path
            for candidate_filename in self.COVER_FILES:
                candidate_path = dirname.joinpath(candidate_filename)
                if candidate_path.is_file():
                    cover_filename = candidate_path
                    break

            if ctx.album:
                ctx.album.tracks.sort(key=lambda track: self.songs[track].trackno)

            ctx.album = Album(album_id, raw_album, raw_artist, year, [], cover_filename)
            self.albums[ctx.album.id] = ctx.album

        hasher = hashlib.blake2b(digest_size=16)
        hasher.update(bytes(raw_artist, "utf-8"))
        hasher.update(bytes(raw_title, "utf-8"))
        song_id = "{}-{}-{}-{}".format(hasher.hexdigest(), year, trackno, discno)
        song = Song(song_id, path, raw_title, raw_artist, trackno, discno, ctx.album.id)
        self.songs[song.id] = song
        ctx.album.tracks.append(song.id)

    async def load_files(self, paths: list[Path]) -> None:
        ctx = self.MediaLoadContext()
        with Worker() as hashing_worker:
            for path in paths:
                await self.load_file(path, ctx, hashing_worker)

        # Finalize the last album
        if ctx.album:
            ctx.album.tracks.sort(key=lambda track: self.songs[track].trackno)

    async def get_covers(self, paths: Sequence[Path], thumbnail: bool) -> bytes:
        missing: list[Path] = []
        for path in paths:
            if (thumbnail, path) not in self.image_cache:
                missing.append(path)

        new_images: dict[Path, Optional[bytes]] = {}
        async for path, data in self.bum_transcode.get_cover_stream(missing, thumbnail):
            new_images[path] = data

        for path, image in new_images.items():
            if image:
                self.image_cache[(thumbnail, path)] = image

        result = [self.image_cache.get((thumbnail, path), b"") for path in paths]
        packed = net.pack_sequence(result)
        return packed

    def close(self) -> None:
        pass
