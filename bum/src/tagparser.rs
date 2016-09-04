extern crate libc;
use libc::{size_t, c_char, c_int};
use std;
use std::ffi::{CString, CStr};

fn convert_c_string(c_str: *const c_char) -> Result<String, std::str::Utf8Error> {
    if c_str.is_null() {
        return Ok(String::new());
    } else {
        let bytes = unsafe { CStr::from_ptr(c_str) };
        let str = String::from(try!(std::str::from_utf8(bytes.to_bytes())));
        return Ok(str);
    }
}

#[repr(C)]
struct Field {
    key: *const c_char,
    value: *const c_char,
}

#[repr(C)]
struct Properties {
    n_fields: size_t,
    fields: *mut Field,
}

#[repr(C)]
struct RawImage {
    mime_type: *const c_char,
    data: *const u8,
    len: size_t,
}

pub struct Image(RawImage);

impl Image {
    fn new(inner: RawImage) -> Image {
        return Image(inner);
    }

    pub fn load(path: &std::path::Path) -> Result<Image, ()> {
        let path_str = CString::new(path.to_str().unwrap()).unwrap();
        let mut image = RawImage {
            mime_type: std::ptr::null(),
            data: std::ptr::null(),
            len: 0,
        };

        unsafe {
            return match taglib_get_cover(path_str.as_ptr(), &mut image) {
                0 => Ok(Image::new(image)),
                _ => Err(()),
            };
        }
    }

    pub fn as_slice(&self) -> &[u8] {
        let &Image(ref raw) = self;
        return unsafe { std::slice::from_raw_parts(raw.data, raw.len as usize) };
    }

    pub fn get_mime_type(&self) -> Result<String, std::str::Utf8Error> {
        let &Image(ref raw) = self;
        return convert_c_string(raw.mime_type);
    }
}

impl Drop for Image {
    fn drop(&mut self) {
        let &mut Image(ref mut raw) = self;
        unsafe {
            taglib_image_free(raw);
        }
    }
}


extern "C" {
    fn taglib_open(path: *const c_char) -> *mut Properties;
    fn taglib_get_cover(path: *const c_char, out: *mut RawImage) -> c_int;
    fn taglib_image_free(image: *mut RawImage);
    fn taglib_free(properties: *mut Properties);
}

pub struct Tags {
    tags: std::collections::HashMap<String, String>,
}

impl Tags {
    pub fn new(path: &std::path::Path) -> Result<Tags, ()> {
        let path_str = CString::new(path.to_str().unwrap()).unwrap();
        let mut result = std::collections::HashMap::new();
        unsafe {
            let properties = taglib_open(path_str.as_ptr());
            if properties.is_null() {
                return Err(());
            }

            for i in 0..(*properties).n_fields {
                let field = (*properties).fields.offset(i as isize);
                let key = match convert_c_string((*field).key) {
                    Ok(s) => s,
                    Err(_) => continue,
                };

                let value = match convert_c_string((*field).value) {
                    Ok(s) => s,
                    Err(_) => continue,
                };

                result.insert(key, value);
            }

            taglib_free(properties);
        }

        return Ok(Tags { tags: result });
    }

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
