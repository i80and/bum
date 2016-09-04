use libc;
use std;

use std::os::unix::ffi::OsStrExt;
use std::os::unix::ffi::OsStringExt;

extern {
    pub fn realpath(pathname: *const libc::c_char, resolved: *mut libc::c_char)
                    -> *mut libc::c_char;
}

pub fn canonicalize(raw_path: &std::path::Path) -> std::io::Result<std::path::PathBuf> {
    let path = try!(std::ffi::CString::new(raw_path.as_os_str().as_bytes()));
    let buf;

    unsafe {
        let r = realpath(path.as_ptr(), std::ptr::null_mut());
        if r.is_null() {
            return Err(std::io::Error::last_os_error())
        }
        buf = std::ffi::CStr::from_ptr(r).to_bytes().to_vec();
        libc::free(r as *mut _);
    }
    Ok(std::path::PathBuf::from(std::ffi::OsString::from_vec(buf)))
}
