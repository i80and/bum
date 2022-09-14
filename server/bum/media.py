from typing import List, NamedTuple


class Song(NamedTuple):
    id: str
    path: str
    title: str
    artist: str
    trackno: int
    discno: int
    album: str

    def to_json(self) -> object:
        return {
            "id": self.id,
            "title": self.title,
            "artist": self.artist,
            "album_id": self.album,
        }


class Album(NamedTuple):
    id: str
    title: str
    album_artist: str
    year: int
    tracks: List[str]
    cover_path: str

    def to_json(self) -> object:
        return {
            "id": self.id,
            "title": self.title,
            "album_artist": self.album_artist,
            "year": self.year,
            "tracks": self.tracks,
        }
