use std::os::unix::fs::MetadataExt;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::ffi::OsStringExt;
use std::path::Path;
use std;

use hyper::mime;
use libc;
use time;

extern "C" {
    pub fn realpath(pathname: *const libc::c_char,
                    resolved: *mut libc::c_char)
                    -> *mut libc::c_char;
}

pub fn canonicalize(raw_path: &std::path::Path) -> std::io::Result<std::path::PathBuf> {
    let path = try!(std::ffi::CString::new(raw_path.as_os_str().as_bytes()));
    let buf;

    unsafe {
        let r = realpath(path.as_ptr(), std::ptr::null_mut());
        if r.is_null() {
            return Err(std::io::Error::last_os_error());
        }
        buf = std::ffi::CStr::from_ptr(r).to_bytes().to_vec();
        libc::free(r as *mut _);
    }
    Ok(std::path::PathBuf::from(std::ffi::OsString::from_vec(buf)))
}

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
