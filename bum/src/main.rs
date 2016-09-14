#![allow(dead_code)]

extern crate bum_rpc;
#[macro_use] extern crate clap;
extern crate hyper;
extern crate image;
extern crate libc;
extern crate queryst;
extern crate regex;
extern crate resp;
extern crate serde_json;
extern crate time;
extern crate toml;
extern crate url;
extern crate walkdir;

#[macro_use] extern crate pledge;

mod media;
mod tagparser;
mod transcode;
mod util;
mod web;

use std::io::Write;
use pledge::{pledge, Promise};
use serde_json::value::ToJson;
use serde_json::value::Value;
use hyper::mime;
use transcode::Transcoder;

struct SongListEntry<'a> {
    id: &'a str,
    title: &'a str,
    artist: &'a str,
    album_id: &'a str,
}

impl<'a> ToJson for SongListEntry<'a> {
    fn to_json(&self) -> Value {
        let mut d = std::collections::BTreeMap::new();
        d.insert("id".to_string(), self.id.to_json());
        d.insert("title".to_string(), self.title.to_json());
        d.insert("artist".to_string(), self.artist.to_json());
        d.insert("album".to_string(), self.album_id.to_json());

        return Value::Object(d);
    }
}

impl<'a> ToJson for media::Song {
    fn to_json(&self) -> Value {
        let mut d = std::collections::BTreeMap::new();
        d.insert("id".to_string(), self.id.to_json());
        d.insert("title".to_string(), self.title.to_json());
        d.insert("artist".to_string(), self.artist.to_json());

        return Value::Object(d);
    }
}


impl ToJson for media::Album {
    fn to_json(&self) -> Value {
        let mut d = std::collections::BTreeMap::new();
        d.insert("id".to_string(), self.id.to_json());
        d.insert("title".to_string(), self.title.to_json());
        d.insert("album_artist".to_string(), self.album_artist.to_json());
        d.insert("year".to_string(), self.year.to_json());
        d.insert("tracks".to_string(), self.tracks.to_json());
        d.insert("cover".to_string(), self.cover.is_some().to_json());

        return Value::Object(d);
    }
}

struct SongHandler {
    db: std::sync::Arc<media::MediaDatabase>,
}

impl SongHandler {
    fn new(db: &std::sync::Arc<media::MediaDatabase>) -> SongHandler {
        return SongHandler { db: db.clone() };
    }

    fn handle_metadata(&self, song: &media::Song, mut res: hyper::server::Response) {
        res.headers_mut().set(hyper::header::ContentType::json());
        *res.status_mut() = hyper::status::StatusCode::Ok;

        res.send(serde_json::to_string(&song.to_json()).unwrap().as_bytes()).unwrap();
    }

    fn handle_stream(&self,
                     song: &media::Song,
                     quality: transcode::Quality,
                     mut res: hyper::server::Response) {
        let mut transcoder = Transcoder::transcode(&song.path, quality).unwrap();

        let mimetype = mime::Mime(mime::TopLevel::Audio,
                                  mime::SubLevel::Ext(String::from("webm")),
                                  vec![]);
        res.headers_mut().set(hyper::header::ContentType(mimetype));
        *res.status_mut() = hyper::status::StatusCode::Ok;
        let mut res = res.start().unwrap();

        // gstreamer makes very small writes, so this buffer size is ample.
        let mut buf = [0; 1024];
        loop {
            let bytes = transcoder.read(&mut buf);
            if bytes == 0 {
                break;
            }
            match res.write_all(&buf[0..bytes]) {
                Ok(_) => (),
                Err(_) => return,
            }
        }

        res.end().unwrap();
    }
}

impl web::Handler for SongHandler {
    fn handle(&self,
              _: &hyper::server::Request,
              mut res: hyper::server::Response,
              args: &web::Args) {
        let id = args.at(1).unwrap();
        let component = args.at(2).unwrap();

        let song = match self.db.get_song(id) {
            Some(s) => s,
            None => {
                *res.status_mut() = hyper::status::StatusCode::NotFound;
                return;
            }
        };

        match component {
            "metadata" => return self.handle_metadata(song, res),
            "stream" => {
                let quality = match args.param_i64("quality") {
                    Some(i) => transcode::Quality::from_int(i),
                    None => transcode::Quality::Medium,
                };

                return self.handle_stream(song, quality, res);
            }
            _ => panic!("Unknown component {}", component),
        };
    }
}

struct SongListHandler {
    db: std::sync::Arc<media::MediaDatabase>,
}

impl SongListHandler {
    fn new(db: &std::sync::Arc<media::MediaDatabase>) -> SongListHandler {
        return SongListHandler { db: db.clone() };
    }
}

impl web::Handler for SongListHandler {
    fn handle(&self, _: &hyper::server::Request, mut res: hyper::server::Response, _: &web::Args) {
        let mut songs = Vec::new();
        for song in self.db.songs() {
            let album = match self.db.get_album_by_song(&song.id) {
                Some(album) => album,
                None => continue,
            };

            let entry = SongListEntry {
                id: &song.id,
                title: &song.title,
                artist: &song.artist,
                album_id: &album.id,
            };

            songs.push(entry.to_json());
        }

        *res.status_mut() = hyper::status::StatusCode::Ok;
        res.headers_mut().set(hyper::header::ContentType::json());
        res.send(serde_json::to_string(&songs).unwrap().as_bytes()).unwrap();
    }
}

struct AlbumHandler {
    db: std::sync::Arc<media::MediaDatabase>,
}

impl AlbumHandler {
    fn new(db: &std::sync::Arc<media::MediaDatabase>) -> AlbumHandler {
        return AlbumHandler { db: db.clone() };
    }

    fn handle_metadata(&self, album: &media::Album, mut res: hyper::server::Response) {
        *res.status_mut() = hyper::status::StatusCode::Ok;
        res.headers_mut().set(hyper::header::ContentType::json());
        res.send(serde_json::to_string(&album.to_json()).unwrap().as_bytes()).unwrap();
    }

    fn handle_cover(&self,
                   album: &media::Album,
                   req: &hyper::server::Request,
                   mut res: hyper::server::Response,
                   thumbnail: bool) {
        let cover = match album.cover {
            Some(ref cover) => cover,
            None => {
                *res.status_mut() = hyper::status::StatusCode::NotFound;
                return;
            }
        };

        if !web::should_serve_file(cover.mtime, req, &mut res) {
            *res.status_mut() = hyper::status::StatusCode::NotModified;
            return;
        }

        // Serve a thumbnail if requested and possible
        let cover = match thumbnail {
            true => match album.thumbnail {
                Some(ref new_cover) => new_cover,
                None => cover
            },
            _ => cover
        };

        res.headers_mut().set(hyper::header::ContentLength(cover.data.len() as u64));
        res.headers_mut().set(hyper::header::ContentType(cover.mimetype.clone()));
        *res.status_mut() = hyper::status::StatusCode::Ok;
        let mut res = res.start().unwrap();
        res.write_all(&(cover.data)).unwrap();
    }
}

impl web::Handler for AlbumHandler {
    fn handle(&self,
              req: &hyper::server::Request,
              mut res: hyper::server::Response,
              args: &web::Args) {
        let id = args.at(1).unwrap();
        let component = args.at(2).unwrap();

        let album = match self.db.get_album(id) {
            Some(a) => a,
            None => {
                *res.status_mut() = hyper::status::StatusCode::NotFound;
                return;
            }
        };

        match component {
            "metadata" => return self.handle_metadata(album, res),
            "cover" => return self.handle_cover(album, req, res, false),
            "thumbnail" => return self.handle_cover(album, req, res, true),
            _ => panic!("Unknown component {}", component),
        };
    }
}

struct AlbumListHandler {
    db: std::sync::Arc<media::MediaDatabase>,
}

impl AlbumListHandler {
    fn new(db: &std::sync::Arc<media::MediaDatabase>) -> AlbumListHandler {
        return AlbumListHandler { db: db.clone() };
    }
}

impl web::Handler for AlbumListHandler {
    fn handle(&self, _: &hyper::server::Request, mut res: hyper::server::Response, _: &web::Args) {
        let albums = self.db.albums()
                            .map(|album| album.to_json())
                            .collect::<Vec<serde_json::Value>>();

        *res.status_mut() = hyper::status::StatusCode::Ok;
        res.headers_mut().set(hyper::header::ContentType::json());
        res.send(serde_json::to_string(&albums).unwrap().as_bytes()).unwrap();
    }
}

fn main() {
    // Pledge ourselves to limit our exploitable surface area.
    match pledge![Stdio, RPath, Inet, Proc, Exec] {
        Ok(_) | Err(pledge::Error::UnsupportedPlatform) => (),
        _ => panic!("Failed to pledge daemon")
    }

    let matches = clap::App::new("bum")
        .version(&crate_version!()[..])
        .author("Andrew Aldridge <i80and@foxquill.com>")
        .about("Start the bum media server.")
        .args_from_usage("-m --media=[PATH] 'Set the path to search for media [default: ./]'
                               \
                          -l --listen=[HOST] 'Set the host to listen on [default: \
                          127.0.0.1:8080]'")
        .get_matches();

    let media_path = match matches.value_of("media") {
        Some(p) => std::path::PathBuf::from(p),
        None => std::env::current_dir().unwrap(),
    };
    let host = matches.value_of("listen").unwrap_or("127.0.0.1:8080");

    let (db, db_errors) = media::MediaDatabase::load(&media_path);
    for error in db_errors {
        println!("{}", error);
    }
    let db = std::sync::Arc::new(db);

    let mut router = web::Router::new();
    router.add_route(web::Method::Get,
                     r"/api/music/songs",
                     SongListHandler::new(&db));
    router.add_route(web::Method::Get,
                     r"/api/music/song/([\w\\-]+)/(metadata|stream)",
                     SongHandler::new(&db));
    router.add_route(web::Method::Get,
                     r"/api/music/albums",
                     AlbumListHandler::new(&db));
    router.add_route(web::Method::Get,
                     r"/api/music/album/([\w\\-]+)/(metadata|thumbnail|cover)",
                     AlbumHandler::new(&db));
    router.add_route(web::Method::Get,
                     r"/(.*)",
                     web::StaticHandler::new("../client/build"));

    println!("Preparing to listen on {}", host);
    match web::listen(host, router) {
        Err(hyper::error::Error::Io(msg)) => println!("Failed to start server: {}", msg),
        Err(msg) => println!("Failed to start server: {}", msg),
        _ => (),
    }
}
