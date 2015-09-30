use std;
use std::io::Read;
use toml;
use util;
use tagparser;

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
    pub track: u32,
    pub disc: u32,
    pub artist: String,
    pub year: Option<u32>,
    pub path: std::path::PathBuf
}

#[derive(Debug)]
pub struct Album {
    pub id: AlbumID,
    pub title: String,
    pub compiler: String,
    pub year: Option<u32>,
    pub tracks: Vec<SongID>,
    pub cover: Option<std::path::PathBuf>
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
                match file.read_to_string(&mut contents) {
                    Ok(_) => (),
                    Err(_) => {
                        println!("Non-textual file {}", path_str);
                        return;
                    }
                }

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
            Some(&toml::Value::String(ref t)) => t.parse::<u32>().ok(),
            _ => return Err(String::from("Need valid 'year'"))
        };

        let cover = match doc.get("cover") {
            Some(&toml::Value::String(ref path)) => {
                let mut cover = std::path::PathBuf::from(prefix);
                cover.push(path);
                match util::canonicalize(cover.as_ref()) {
                    Ok(p) => Some(p),
                    _ => {
                        println!("Path '{}' not found", &cover.to_string_lossy());
                        None
                    }
                }
            },
            _ => None
        };

        let mut artists = Vec::new();
        let mut songs = match doc.get("tracks") {
            Some(&toml::Value::Array(ref a)) => a.iter().filter_map(|x| {
                let table = match x {
                    &toml::Value::Table(ref t) => t,
                    _ => return None
                };

                let mut song_path = std::path::PathBuf::from(prefix);
                song_path.push(match table.get("path") {
                    Some(&toml::Value::String(ref t)) => t.clone(),
                    _ => return None
                });

                let mut song = match self.parse_song(&song_path, &id) {
                    Ok(s) => s,
                    Err(msg) => {
                        println!("{}", msg);
                        return None;
                    }
                };

                match song.artist.as_ref() {
                    "" => song.artist = default_artist.clone(),
                    _ => ()
                }

                artists.push(song.artist.clone());
                self.index_song_album.insert(song.id.clone(), id.clone());

                return Some(song);
            }).collect(),
            _ => Vec::new()
        };

        // Sort by disc, then track
        songs.sort_by(|a, b| {
            match a.disc.cmp(&b.disc) {
                std::cmp::Ordering::Equal => (),
                c => return c
            }
            return a.track.cmp(&b.track);
        });

        let tracks = songs.iter().map(|song| song.id.clone()).collect();
        for song in songs {
            match self.songs.insert(song.id.clone(), song) {
                Some(ref dup) => { println!("Duplicate ID {}", dup.id); },
                _ => ()
            }
        }

        let compiler = match doc.get("compiler") {
            Some(&toml::Value::String(ref t)) => t.clone(),
            _ => artists.iter().fold(String::new(), |prev, cur| {
                if prev.is_empty() {
                    return cur.clone();
                }

                if prev == *cur { return prev; }
                return String::from("Various Artists");
            })
        };

        let album = Album {
            id: id.clone(),
            title: title,
            compiler: String::from(compiler),
            year: year,
            tracks: tracks,
            cover: cover
        };

        self.albums.insert(album.id.clone(), album);

        return Ok(());
    }

    fn parse_song(&self, path: &std::path::Path, album_id: &AlbumID) -> Result<Song, String> {
        let tags = match tagparser::Tags::new(&path) {
            Ok(t) => t,
            Err(_) => return Err(format!("Failed to parse file {:?}", path))
        };

        let title = match tags.title() {
            Some(x) => x,
            None => return Err(format!("Need valid 'title' in track {:?}", path))
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

        return Ok(Song {
            id: format!("{}-{}-{}", album_id, disc, track),
            title: String::from(title),
            track: track,
            disc: disc,
            artist: String::from(artist),
            year: year,
            path: std::path::PathBuf::from(path)
        });
    }
}
