use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std;

use hyper::mime;
use time;

pub fn path_to_mimetype(path: &Path) -> mime::Mime {
    let mut mimetype = mime::Mime(mime::TopLevel::Application,
                                  mime::SubLevel::Ext(String::from("octet-stream")),
                                  vec![]);
    match path.extension() {
        Some(ext) => {
            mimetype = match &*(ext.to_string_lossy()) {
                "html" => mime::Mime(mime::TopLevel::Text, mime::SubLevel::Html, vec![]),
                "json" => mime::Mime(mime::TopLevel::Application, mime::SubLevel::Json, vec![]),
                "png" => mime::Mime(mime::TopLevel::Image, mime::SubLevel::Png, vec![]),
                "jpg" | "jpeg" => mime::Mime(mime::TopLevel::Image, mime::SubLevel::Jpeg, vec![]),
                "txt" => mime::Mime(mime::TopLevel::Text, mime::SubLevel::Plain, vec![]),
                "css" => mime::Mime(mime::TopLevel::Text, mime::SubLevel::Css, vec![]),
                "js" => {
                    mime::Mime(mime::TopLevel::Application,
                               mime::SubLevel::Javascript,
                               vec![])
                }
                "toml" => mime::Mime(mime::TopLevel::Text, mime::SubLevel::Plain, vec![]),
                _ => mimetype,
            }
        }
        _ => (),
    }

    return mimetype;
}

pub fn mtime(metadata: std::fs::Metadata) -> time::Tm {
    return time::at(time::Timespec::new(metadata.mtime(), metadata.mtime_nsec() as i32));
}

lazy_static! {
    static ref CURRENT_EXE: PathBuf = {
        std::env::current_exe().expect("Failed to get path to bum binary")
    };
}

fn get_current_exe() -> &'static Path {
    return &*CURRENT_EXE;
}

pub fn get_helper(name: &str) -> Result<PathBuf, ()> {
    let dir = match get_current_exe().parent() {
        Some(path) => path,
        None => return Err(())
    };

    return Ok(dir.join(name));
}

pub fn init_get_helper() {
    get_current_exe();
}
