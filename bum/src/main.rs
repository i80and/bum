#![allow(dead_code)]
#![allow(unused_variables)]

extern crate hyper;
extern crate queryst;
extern crate regex;
extern crate rustc_serialize;
extern crate time;
extern crate toml;
extern crate url;
extern crate libc;

use rustc_serialize::json;
use rustc_serialize::json::ToJson;
use std::io::Write;
use std::io::Read;
use hyper::mime;

mod web;
mod util;
mod media;
mod transcode;

struct SongListEntry<'a> {
    id: &'a str,
    title: &'a str,
    album_id: &'a str
}

struct AlbumListEntry<'a> {
    id: &'a str,
    title: &'a str,
    artist: &'a str,
    year: &'a str
}

impl<'a> json::ToJson for SongListEntry<'a> {
    fn to_json(&self) -> json::Json {
        let mut d = std::collections::BTreeMap::new();
        d.insert("id".to_string(), self.id.to_json());
        d.insert("title".to_string(), self.title.to_json());
        d.insert("album".to_string(), self.album_id.to_json());

        return json::Json::Object(d);
    }
}

impl<'a> json::ToJson for AlbumListEntry<'a> {
    fn to_json(&self) -> json::Json {
        let mut d = std::collections::BTreeMap::new();
        d.insert("id".to_string(), self.id.to_json());
        d.insert("title".to_string(), self.title.to_json());
        d.insert("artist".to_string(), self.artist.to_json());
        d.insert("year".to_string(), self.year.to_json());

        return json::Json::Object(d);
    }
}

impl json::ToJson for media::Album {
    fn to_json(&self) -> json::Json {
        let mut d = std::collections::BTreeMap::new();
        d.insert("id".to_string(), self.id.to_json());
        d.insert("title".to_string(), self.title.to_json());
        d.insert("artist".to_string(), self.artist.to_json());
        d.insert("year".to_string(), self.year.to_json());
        d.insert("tracks".to_string(), self.tracks.to_json());

        return json::Json::Object(d);
    }
}

struct SongHandler {
    db: std::sync::Arc<media::MediaDatabase>
}

impl SongHandler {
    fn new(db: &std::sync::Arc<media::MediaDatabase>) -> SongHandler {
        return SongHandler {
            db: db.clone()
        };
    }

    fn handle_metadata(&self, song: &media::Song, mut res: hyper::server::Response) {
        res.headers_mut().set(hyper::header::ContentType::json());
        *res.status_mut() = hyper::status::StatusCode::Ok;
        res.send(b"{}").unwrap();
    }

    fn handle_stream(&self, song: &media::Song, quality: transcode::Quality, mut res: hyper::server::Response) {
        let mut transcoder = transcode::transcode(&song.path, quality).unwrap();

        let mimetype = mime::Mime(mime::TopLevel::Audio, mime::SubLevel::Ext(String::from("webm")), vec![]);
        res.headers_mut().set(hyper::header::ContentType(mimetype));
        *res.status_mut() = hyper::status::StatusCode::Ok;
        let mut res = res.start().unwrap();

        // gstreamer makes very small writes, so this buffer size is ample.
        let mut buf = [0; 1024];
        let mut transcoder_stream = transcoder.stdout.unwrap();
        loop {
            let bytes = transcoder_stream.read(&mut buf).unwrap();
            if bytes == 0 { break; }
            res.write_all(&buf[0..bytes]).unwrap();
        }

        res.end().unwrap();

        // Move the stream back so we can collect the child
        transcoder.stdout = Some(transcoder_stream);
        transcoder.wait().unwrap();
    }

    fn handle_cover(&self, song: &media::Song, mut res: hyper::server::Response) {
        res.headers_mut().set(hyper::header::ContentType::json());
        *res.status_mut() = hyper::status::StatusCode::NotFound;
    }
}

impl web::Handler for SongHandler {
    fn handle(&self, req: &hyper::server::Request, mut res: hyper::server::Response, args: &web::Args) {
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
                    None => transcode::Quality::Medium
                };

                return self.handle_stream(song, quality, res);
            },
            "cover" => return self.handle_cover(song, res),
            _ => panic!("Unknown component {}", component)
        };
    }
}

struct SongListHandler {
    db: std::sync::Arc<media::MediaDatabase>
}

impl SongListHandler {
    fn new(db: &std::sync::Arc<media::MediaDatabase>) -> SongListHandler {
        return SongListHandler {
            db: db.clone()
        };
    }
}

impl web::Handler for SongListHandler {
    fn handle(&self, req: &hyper::server::Request, mut res: hyper::server::Response, args: &web::Args) {
        let mut songs = Vec::new();
        for song in self.db.songs() {
            let album = match self.db.get_album_by_song(&song.id) {
                Some(album) => album,
                None => continue
            };

            let entry = SongListEntry {
                id: &song.id,
                title: &song.title,
                album_id: &album.id
            };

            songs.push(entry.to_json());
        }

        *res.status_mut() = hyper::status::StatusCode::Ok;
        res.headers_mut().set(hyper::header::ContentType::json());
        res.send(json::encode(&songs).unwrap().as_bytes()).unwrap();
    }
}

struct AlbumHandler {
    db: std::sync::Arc<media::MediaDatabase>
}

impl AlbumHandler {
    fn new(db: &std::sync::Arc<media::MediaDatabase>) -> AlbumHandler {
        return AlbumHandler {
            db: db.clone()
        };
    }
}

impl web::Handler for AlbumHandler {
    fn handle(&self, req: &hyper::server::Request, mut res: hyper::server::Response, args: &web::Args) {
        let id = args.at(1).unwrap();
        let component = args.at(2).unwrap();

        let album = match self.db.get_album(id) {
            Some(a) => a,
            None => {
                *res.status_mut() = hyper::status::StatusCode::NotFound;
                return;
            }
        };

        *res.status_mut() = hyper::status::StatusCode::Ok;
        res.headers_mut().set(hyper::header::ContentType::json());
        res.send(json::encode(&album.to_json()).unwrap().as_bytes()).unwrap();
    }
}

struct AlbumListHandler {
    db: std::sync::Arc<media::MediaDatabase>
}

impl AlbumListHandler {
    fn new(db: &std::sync::Arc<media::MediaDatabase>) -> AlbumListHandler {
        return AlbumListHandler {
            db: db.clone()
        };
    }
}

impl web::Handler for AlbumListHandler {
    fn handle(&self, req: &hyper::server::Request, mut res: hyper::server::Response, args: &web::Args) {
        let mut albums = Vec::new();
        for album in self.db.albums() {
            let entry = AlbumListEntry {
                id: &album.id,
                title: &album.title,
                artist: &album.artist,
                year: &album.year,
            };

            albums.push(entry.to_json());
        }

        *res.status_mut() = hyper::status::StatusCode::Ok;
        res.headers_mut().set(hyper::header::ContentType::json());
        res.send(json::encode(&albums).unwrap().as_bytes()).unwrap();
    }
}

fn main() {
    let db = std::sync::Arc::new(media::MediaDatabase::load(&std::env::current_dir().unwrap()).unwrap());

    let mut router = web::Router::new();
    router.add_route(web::Method::Get, r"/api/music/songs", SongListHandler::new(&db));
    router.add_route(web::Method::Get, r"/api/music/song/([\w\\-]+)/(metadata|stream|cover)", SongHandler::new(&db));
    router.add_route(web::Method::Get, r"/api/music/albums", AlbumListHandler::new(&db));
    router.add_route(web::Method::Get, r"/api/music/album/([\w\\-]+)/(metadata|cover)", AlbumHandler::new(&db));
    router.add_route(web::Method::Get, r"/(.*)", web::StaticHandler::new("../client/build"));

    web::listen("127.0.0.1:8080", router);
}
