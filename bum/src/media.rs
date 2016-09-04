use std;
use std::hash::{Hash,Hasher};
use walkdir::WalkDir;
use tagparser;

const COVER_FILES: [&'static str; 2] = ["cover.jpg", "cover.png"];
const MUSIC_EXTENSIONS: [&'static str; 8] = ["opus", "ogg", "oga", "flac", "mp3", "mp4", "m4a", "wma"];

enum MediaDescriptionType {
    Album,
    Movie
}

// Identified by the file that defines it
pub type AlbumID = String;

// Identified by AlbumID-TrackNo
pub type SongID = String;

pub struct Song {
    pub id: SongID,
    pub title: String,
    pub album_title: String,
    pub track: u32,
    pub disc: u32,
    pub artist: String,
    pub year: Option<u32>,
    pub path: std::path::PathBuf
}

#[derive(Debug)]
pub enum Cover {
    FromFile(std::path::PathBuf),
    FromTags(std::path::PathBuf),
    None
}

pub struct Album {
    pub id: AlbumID,
    pub title: String,
    pub album_artist: String,
    pub year: Option<u32>,
    pub tracks: Vec<SongID>,
    pub cover: Cover
}

pub struct MediaDatabase {
    root: std::path::PathBuf,

    songs: std::collections::BTreeMap<SongID, Song>,
    albums: std::collections::HashMap<AlbumID, Album>,

    index_song_album: std::collections::HashMap<SongID, AlbumID>
}

impl MediaDatabase {
    pub fn load(root: &std::path::Path) -> Result<MediaDatabase, String> {
        let mut db = MediaDatabase {
            root: std::path::PathBuf::from(root),
            songs: std::collections::BTreeMap::new(),
            albums: std::collections::HashMap::new(),
            index_song_album: std::collections::HashMap::new()
        };

        let mut song_prefixes = std::collections::HashMap::new();

        for entry in WalkDir::new(root) {
            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue
            };

            let path = entry.path();
            let extension = match path.extension() {
                Some(ext) => ext,
                None => continue
            };

            if MUSIC_EXTENSIONS.iter().find(|e| **e == extension).is_some() {
                let album_prefix = std::path::PathBuf::from(path.parent().unwrap());
                let mut songs = song_prefixes.entry(album_prefix).or_insert(vec!());
                songs.push(std::path::PathBuf::from(&path));
            }
        }

        // Associate songs with albums
        for (prefix,song_paths) in song_prefixes.iter() {
            let mut songs: Vec<Song> = song_paths.iter().filter_map(|path| {
                db.parse_song(path).ok()
            }).collect();

            // Reverse-order so that we can pop off the end and get a sorted
            // track list.
            songs.sort_by(|a, b| {
                match a.disc.cmp(&b.disc) {
                    std::cmp::Ordering::Equal => (),
                    c => return c.reverse()
                }
                return a.track.cmp(&b.track).reverse();
            });

            db.insert_album(songs, prefix);
        }

        return Ok(db);
    }

    pub fn get_song<'a>(&'a self, song_id: &str) -> Option<&'a Song> {
        return self.songs.get(song_id);
    }

    pub fn get_album_by_song<'a>(&'a self, song_id: &str) -> Option<&'a Album> {
        let album_id = match self.index_song_album.get(song_id) {
            Some(id) => id,
            None => return None
        };

        return self.albums.get(album_id);
    }

    pub fn songs(&self) -> std::collections::btree_map::Values<SongID, Song> {
        return self.songs.values();
    }

    pub fn get_album<'a>(&'a self, album_id: &str) -> Option<&'a Album> {
        return self.albums.get(album_id);
    }

    pub fn albums(&self) -> std::collections::hash_map::Values<AlbumID, Album> {
        return self.albums.values();
    }

    fn parse_song(&self, path: &std::path::Path) -> Result<Song, String> {
        let tags = match tagparser::Tags::new(&path) {
            Ok(t) => t,
            Err(_) => return Err(format!("Failed to parse file {:?}", path))
        };

        let title = match tags.title() {
            Some(x) => x,
            None => return Err(format!("Need valid 'title' in track {:?}", path))
        };

        let album_title = match tags.album() {
            Some(x) => x,
            None => return Err(format!("Need valid 'album' in track {:?}", path))
        };

        let year = tags.year();

        let artist = match tags.artist() {
            Some(a) => a,
            None => return Err(format!("Need valid 'artist' in track {:?}", path)),
        };

        let (track,_) = tags.track();
        let track = track.unwrap_or(0);
        let (disc,_) = tags.disc();
        let disc = disc.unwrap_or(0);

        let mut hasher = std::hash::SipHasher::new();
        artist.hash(&mut hasher);
        title.hash(&mut hasher);

        let id = format!("{}-{}-{}-{}", hasher.finish(), year.unwrap_or(0), track, disc);

        return Ok(Song {
            id: id,
            title: String::from(title),
            album_title: String::from(album_title),
            track: track,
            disc: disc,
            artist: String::from(artist),
            year: year,
            path: std::path::PathBuf::from(path)
        });
    }

    fn insert_album(&mut self, mut songs: Vec<Song>, prefix: &std::path::Path) {
        // Track the artists that appear in an album. If more than half of an
        // album has the same artist, consider that artist the "album artist".
        // Otherwise, fall back to "Various Artists".
        let mut album_artists = std::collections::HashMap::<String, u32>::new();

        // Just use the first year and title we find
        let year = match songs.get(0) {
            Some(song) => song.year,
            None => None
        };

        let title = match songs.get(0) {
            Some(song) => song.album_title.to_owned(),
            None => String::new()
        };

        let mut tracks = Vec::new();

        // Register each song in the database
        while !songs.is_empty() {
            let song = songs.pop().unwrap();
            *(album_artists.entry(song.artist.clone()).or_insert(0)) += 1;

            tracks.push(song.id.clone());
            self.songs.insert(song.id.clone(), song);
        }

        // Find the artist with majority status in this album
        let threshold = tracks.len() as u32 / 2;
        let mut album_artist = None;
        for (artist,n) in album_artists.iter() {
            if *n >= threshold {
                album_artist = Some(artist.clone());
                break;
            }
        }

        let album_artist = match album_artist {
            Some(aa) => aa,
            None => String::from("Various Artists")
        };

        let mut artist_hasher = std::hash::SipHasher::new();
        album_artist.hash(&mut artist_hasher);

        let mut title_hasher = std::hash::SipHasher::new();
        title.hash(&mut title_hasher);

        let album_id = format!("{}-{}-{}", artist_hasher.finish(), title_hasher.finish(), tracks.len());

        for song_id in tracks.iter() {
            self.index_song_album.insert(song_id.clone(), album_id.clone());
        }

        // Try to find a cover image
        let cover_path = COVER_FILES.iter().filter_map(|candidate| {
            let mut cover_path = std::path::PathBuf::from(prefix);
            cover_path.push(candidate);
            return match std::fs::metadata(&cover_path) {
                Ok(_) => Some(cover_path),
                Err(_) => None
            };
        }).next();



        let cover = match cover_path {
            Some(p) => Some(Cover::FromFile(p)),
            None => None
        }.or_else(|| {
            let track = match tracks.get(0) {
                Some(t) => t,
                None => return None
            };

            let song = self.get_song(track).unwrap();
            return match tagparser::Image::load(&song.path) {
                Ok(_) => Some(Cover::FromTags(song.path.clone())),
                Err(_) => None
            }
        }).unwrap_or(Cover::None);

        let album = Album {
            id: album_id,
            title: title,
            album_artist: album_artist,
            year: year,
            tracks: tracks,
            cover: cover
        };

        self.albums.insert(album.id.clone(), album);
    }
}
