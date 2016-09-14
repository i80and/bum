use std::collections::HashMap;
use std::error::Error;
use std::io;
use std::path::Path;
use std::process;
use std;

use hyper::mime;
use resp;
use time;

use bum_rpc;
use media::Cover;
use util;

pub struct Tags {
    tags: HashMap<String, String>,
}

impl Tags {
    pub fn title<'a>(&'a self) -> Option<&'a str> {
        return match self.tags.get("TITLE") {
            Some(s) => Some(s),
            None => None,
        };
    }

    pub fn artist<'a>(&'a self) -> Option<&'a str> {
        return match self.tags.get("ARTIST") {
            Some(s) => Some(s),
            None => None,
        };
    }

    pub fn album<'a>(&'a self) -> Option<&'a str> {
        return match self.tags.get("ALBUM") {
            Some(s) => Some(s),
            None => None,
        };
    }

    pub fn year(&self) -> Option<u32> {
        return match self.tags.get("DATE") {
            Some(s) => s.parse::<u32>().ok().and_then(|t| Some(t)),
            None => None,
        };
    }

    pub fn track<'a>(&'a self) -> (Option<u32>, Option<u32>) {
        let track_str = match self.tags.get("TRACKNUMBER") {
            Some(s) => s,
            None => return (None, None),
        };

        let mut tracks = track_str.split('/').take(2);
        let cur_track = match tracks.next() {
            Some(s) => s.parse::<u32>().ok().and_then(|t| Some(t)),
            None => None,
        };

        let n_tracks = match tracks.next() {
            Some(s) => s.parse::<u32>().ok().and_then(|t| Some(t)),
            None => None,
        };

        return (cur_track, n_tracks);
    }

    pub fn disc<'a>(&'a self) -> (Option<u32>, Option<u32>) {
        let disc_str = match self.tags.get("DISCNUMBER") {
            Some(s) => s,
            None => return (None, None),
        };

        let mut discs = disc_str.split('/').take(2);
        let cur_disc = match discs.next() {
            Some(s) => s.parse::<u32>().ok().and_then(|t| Some(t)),
            None => None,
        };

        let n_discs = match discs.next() {
            Some(s) => s.parse::<u32>().ok().and_then(|t| Some(t)),
            None => None,
        };

        return (cur_disc, n_discs);
    }
}

pub struct Server {
    rpc: bum_rpc::RPCInterface<io::BufReader<process::ChildStdout>>,
    child_stdin: process::ChildStdin,
}

impl Server {
    pub fn start() -> Result<Server, String> {
        let child = process::Command::new("./target/debug/bum-tags")
        .stdout(process::Stdio::piped())
        .stdin(process::Stdio::piped())
        .spawn();

        return match child {
            Ok(c) =>  Ok(Server {
                rpc: bum_rpc::RPCInterface::new(io::BufReader::new(c.stdout.unwrap())),
                child_stdin: c.stdin.unwrap()
            }),
            Err(s) => Err(format!("Error starting tagparser helper: {}", s.description())),
        };
    }

    pub fn load_tags(&mut self, path: &Path) -> Result<Tags, String> {
        let path_str = match path.to_str() {
            Some(s) => s.to_owned(),
            None => return Err("Cannot treat path as string".to_owned())
        };

        bum_rpc::call(&mut self.child_stdin,
                      "tags",
                      vec![resp::Value::String(path_str)]);
        match self.rpc.read_value() {
            Some(resp::Value::Array(array)) => {
                let mut hashmap = HashMap::with_capacity(array.len());
                for element in array {
                    let element = match bum_rpc::value_to_string(element) {
                        Ok(s) => s,
                        Err(_) => return Err(format!("Bad response from tagserver"))
                    };

                    let pos = match element.find(':') {
                        Some(p) => p,
                        None => return Err("Bad response from tagserver".to_owned())
                    };
                    let (k, v) = element.split_at(pos);
                    let v = &v[1..];
                    hashmap.insert(k.to_owned(), v.to_owned());
                }

                Ok(Tags {
                    tags: hashmap
                })
            }
            Some(resp::Value::Error(msg)) => return Err(msg),
            None => Err(format!("No response from tagserver")),
            _ => return Err(format!("Bad response from tagserver"))
        }
    }

    pub fn load_cover(&mut self, path: &Path) -> Result<Cover, String> {
        let path_str = match path.to_str() {
            Some(s) => s.to_owned(),
            None => return Err("Cannot treat path as string".to_owned())
        };

        bum_rpc::call(&mut self.child_stdin,
                      "cover",
                      vec![resp::Value::String(path_str)]);
        match self.rpc.read_value() {
            Some(resp::Value::Array(mut array)) => {
                let data = match array.pop() {
                    Some(resp::Value::BufBulk(data)) => data,
                    _ => return Err("Bad data response from tagserver".to_owned())
                };

                let mimetype = match array.pop() {
                    Some(resp::Value::String(mimetype)) => mimetype,
                    _ => return Err("Bad mimetype response from tagserver".to_owned())
                };

                let mimetype: mime::Mime = match mimetype.parse() {
                    Ok(m) => m,
                    Err(_) => {
                        return Err("Error parsing mimetype response from tagserver".to_owned())
                    }
                };

                let mtime = match std::fs::metadata(path) {
                    Ok(metadata) => util::mtime(metadata),
                    Err(_) => time::now_utc()
                };

                return Ok(Cover {
                    mimetype: mimetype,
                    data: data,
                    mtime: mtime,
                });
            }
            Some(resp::Value::Error(msg)) => return Err(msg),
            None => Err("No response from tagserver loading cover".to_owned()),
            _ => return Err("Bad response from tagserver".to_owned())
        }
    }
}
