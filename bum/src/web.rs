use std::io::{Read, Write};
use std;

use regex;
use queryst;
use hyper;
use url;
use time;
use util;
use serde_json;
pub use hyper::method::Method;

pub struct Args<'a> {
    args: &'a regex::Captures<'a>,
    query: &'a serde_json::Value,
}

impl<'a> Args<'a> {
    pub fn new(args: &'a regex::Captures, query: &'a serde_json::Value) -> Args<'a> {
        return Args {
            args: args,
            query: query,
        };
    }

    pub fn at(&self, i: usize) -> Option<&'a str> {
        return self.args.at(i);
    }

    pub fn param(&self, name: &str) -> Option<&'a str> {
        let val = match self.query.search(name) {
            Some(v) => v,
            None => return None,
        };

        return val.as_str();
    }

    pub fn param_i64(&self, name: &str) -> Option<i64> {
        let val = match self.param(name) {
            Some(v) => v,
            None => return None,
        };

        return match val.parse::<i64>() {
            Ok(v) => Some(v),
            Err(_) => None,
        };
    }
}

pub trait Handler {
    fn handle(&self, req: &hyper::server::Request, mut res: hyper::server::Response, args: &Args);
}

pub struct Router {
    routes: Vec<(regex::Regex, Box<Handler + Sync + Send>)>,
}

impl Router {
    pub fn new() -> Router {
        Router { routes: Vec::new() }
    }

    pub fn add_route<T: Handler + Sync + Send + 'static>(&mut self,
                                                         method: Method,
                                                         path: &str,
                                                         handler: T) {
        let pattern = format!(r"^{} {}$", method.to_string(), path);
        self.routes.push((regex::Regex::new(&pattern).unwrap(), Box::new(handler)));
    }

    fn route_http(&self, req: &hyper::server::Request, mut res: hyper::server::Response) {
        let path = match req.uri {
            hyper::uri::RequestUri::AbsolutePath(ref p) => p,
            _ => panic!("Refused request URI"),
        };

        // Parse into components, and urldecode
        let url = hyper::Url::parse("http://example.com").unwrap().join(path).unwrap();
        let path = url::percent_encoding::percent_decode(path.as_bytes()).decode_utf8_lossy();
        let query = match url.query() {
            Some(q) => q,
            None => "",
        };

        // Create our string to match against route handlers
        let id = format!("{} {}", req.method.to_string(), path);

        // Search for a matching handler
        for &(ref pattern, ref handler) in &self.routes {
            let captures = match pattern.captures(&id) {
                Some(captures) => captures,
                None => continue,
            };

            // Found! Parse the query string, and dispatch.
            let parsed_query = queryst::parse(&query).unwrap();
            let args = Args::new(&captures, &parsed_query);
            return handler.handle(req, res, &args);
        }

        *res.status_mut() = hyper::status::StatusCode::NotFound;
    }
}

pub struct StaticHandler {
    root: std::sync::Arc<std::path::PathBuf>,
}

pub fn should_serve_file(mtime: time::Tm,
                         req: &hyper::server::Request,
                         res: &mut hyper::server::Response)
                         -> bool {
    // Check the If-Modified-Since against our mtime
    let mut should_send = true;
    match req.headers.get::<hyper::header::IfModifiedSince>() {
        Some(&hyper::header::IfModifiedSince(hyper::header::HttpDate(query))) => {
            should_send = query < mtime;
        }
        _ => (),
    }

    res.headers_mut().set(hyper::header::LastModified(hyper::header::HttpDate(mtime)));

    return should_send;
}

pub fn serve_file(mut path: std::path::PathBuf,
                  req: &hyper::server::Request,
                  mut res: hyper::server::Response) {
    let metadata = std::fs::metadata(&path).unwrap();
    if metadata.is_dir() {
        path.push("index.html");
        return serve_file(path, req, res);
    }

    let file = match std::fs::File::open(&path) {
        Ok(m) => m,
        Err(err) => {
            match err.kind() {
                std::io::ErrorKind::PermissionDenied => {
                    *res.status_mut() = hyper::status::StatusCode::Forbidden;
                    return;
                }
                _ => {
                    *res.status_mut() = hyper::status::StatusCode::NotFound;
                    return;
                }
            }
        }
    };

    res.headers_mut().set(hyper::header::ContentLength(metadata.len()));
    let mimetype = util::path_to_mimetype(&path);
    res.headers_mut().set(hyper::header::ContentType(mimetype));

    if !should_serve_file(util::mtime(metadata), req, &mut res) {
        *res.status_mut() = hyper::status::StatusCode::NotModified;
        return;
    }

    let mut reader = std::io::BufReader::new(file);
    let mut buf = [0; 1024];

    *res.status_mut() = hyper::status::StatusCode::Ok;
    let mut res = res.start().unwrap();

    loop {
        let bytes = reader.read(&mut buf).unwrap();
        if bytes == 0 {
            break;
        }
        res.write_all(&buf[0..bytes]).unwrap();
    }
}

impl StaticHandler {
    pub fn new<P: AsRef<std::path::Path>>(root: P) -> StaticHandler {
        let canonical_root = util::canonicalize(root.as_ref()).unwrap();
        return StaticHandler { root: std::sync::Arc::new(canonical_root) };
    }
}

impl Handler for StaticHandler {
    fn handle(&self, req: &hyper::server::Request, mut res: hyper::server::Response, args: &Args) {
        // Get our path request, making sure that it's relative
        let raw_path = std::path::PathBuf::from(args.at(1).unwrap().trim_left_matches('/'));

        // Make the path request relative to our root
        let mut path = (*self.root).clone();
        path.push(raw_path);

        let path = match util::canonicalize(&path) {
            Ok(p) => p,
            Err(_) => {
                *res.status_mut() = hyper::status::StatusCode::NotFound;
                return;
            }
        };

        // Make sure our canonicalized request is underneath our root
        if !path.starts_with(&*self.root) {
            *res.status_mut() = hyper::status::StatusCode::NotFound;
            return;
        }

        return serve_file(path, req, res);
    }
}

impl hyper::server::Handler for Router {
    fn handle(&self, req: hyper::server::Request, mut res: hyper::server::Response) {
        // If the status code is never set, that's an error. We need to make sure
        // that early panics result in a 500.
        *res.status_mut() = hyper::status::StatusCode::InternalServerError;

        self.route_http(&req, res);
    }
}

pub fn listen<T: 'static + hyper::server::Handler>(address: &str,
                                                   router: T)
                                                   -> Result<(), hyper::error::Error> {
    let server = try!(hyper::server::Server::http(address));
    try!(server.handle(router));
    return Ok(());
}
