use std;
use std::io::Read;
use toml;
use util;

enum MediaDescriptionType {
    Album,
    Movie
}

// Identified by the file that defines it
pub type AlbumID = String;

// Identified by AlbumID-TrackNo
pub type SongID = String;

#[derive(Debug)]
pub struct Song {
    pub id: SongID,
    pub title: String,
    pub artist: String,
    pub path: std::path::PathBuf
}

#[derive(Debug)]
pub struct Album {
    pub id: AlbumID,
    pub title: String,
    pub year: String,
    pub tracks: Vec<SongID>
}

#[derive(Debug)]
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

        util::visit_dirs(root, &mut |dirname, entry| {
            let path = entry.path();
            let extension = match path.extension() {
                Some(ext) => ext,
                None => return
            };

            let path_str = path.to_str().unwrap();

            if extension == "toml" {
                let mut contents = String::new();
                let mut file = std::fs::File::open(path_str).unwrap();
                file.read_to_string(&mut contents).unwrap();

                let mut parser = toml::Parser::new(&contents);
                let parsed = match parser.parse() {
                    Some(p) => p,
                    None => {
                        println!("Error parsing {}: {:?}", path_str, parser.errors);
                        return;
                    }
                };

                let media_type = match parsed.get("type") {
                    Some(&toml::Value::String(ref t)) => t,
                    _ => {
                        println!("No type field: {}", path_str);
                        return;
                    }
                };

                let media_type = match media_type.as_ref() {
                    "album" => MediaDescriptionType::Album,
                    "movie" => MediaDescriptionType::Movie,
                    _ => {
                        println!("Unknown media type for {}: {}", path_str, media_type);
                        return;
                    }
                };

                let album_id = match path.file_stem() {
                    Some(id) => id,
                    None => {
                        println!("Invalid album ID: {}", path_str);
                        return;
                    }
                };

                let album_id = match album_id.to_str() {
                    Some(id) => String::from(id),
                    None => {
                        println!("Invalid album ID: {}", path_str);
                        return;
                    }
                };

                match media_type {
                    MediaDescriptionType::Album => db.parse_album(dirname, &album_id, &parsed).unwrap(),
                    MediaDescriptionType::Movie => ()
                };
            }
        }).unwrap();

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

    fn parse_album(&mut self, prefix: &std::path::Path,
                              id: &AlbumID,
                              doc: &toml::Table) -> Result<(), String> {
        let title = match doc.get("title") {
            Some(&toml::Value::String(ref t)) => t.clone(),
            _ => return Err(String::from("Need valid 'title'"))
        };

        let default_artist = match doc.get("artist") {
            Some(&toml::Value::String(ref t)) => t.clone(),
            _ => String::new()
        };

        let year = match doc.get("year") {
            Some(&toml::Value::String(ref t)) => t.clone(),
            _ => return Err(String::from("Need valid 'year'"))
        };

        let mut i = 0;
        let tracks = match doc.get("tracks") {
            Some(&toml::Value::Array(ref a)) => a.iter().filter_map(|x| {
                let table = match x {
                    &toml::Value::Table(ref t) => t,
                    _ => return None
                };

                let song_id = format!("{}-{}", id, i);
                i += 1;

                let mut song = match self.parse_song(prefix, &song_id, table) {
                    Ok(s) => s,
                    Err(_) => return None
                };

                match song.artist.as_ref() {
                    "" => song.artist = default_artist.clone(),
                    _ => ()
                }

                let result = Some(song.id.clone());
                self.index_song_album.insert(song.id.clone(), id.clone());
                self.songs.insert(song.id.clone(), song);

                return result;
            }).collect(),
            _ => Vec::new()
        };

        let album = Album {
            id: id.clone(),
            title: title,
            year: year,
            tracks: tracks
        };

        self.albums.insert(album.id.clone(), album);

        return Ok(());
    }

    fn parse_song(&self, prefix: &std::path::Path,
                         id: &SongID,
                         doc: &toml::Table) -> Result<Song, String> {
        let title = match doc.get("title") {
            Some(&toml::Value::String(ref t)) => t.clone(),
            _ => return Err(String::from("Need valid 'title'"))
        };

        let artist = match doc.get("artist") {
            Some(&toml::Value::String(ref t)) => t.clone(),
            _ => String::new()
        };

        let mut path = std::path::PathBuf::from(prefix);
        path.push(match doc.get("path") {
            Some(&toml::Value::String(ref t)) => t.clone(),
            _ => return Err(String::from("Need valid 'path'"))
        });

        return Ok(Song {
            id: id.clone(),
            title: title,
            artist: artist,
            path: path
        });
    }
}
