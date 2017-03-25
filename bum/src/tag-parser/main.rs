extern crate libc;
extern crate resp;
extern crate bum_rpc;

#[macro_use] extern crate pledge;
use pledge::{pledge, Promise, ToPromiseString};

use std::ffi::{CString, CStr};
use libc::{size_t, c_char, c_int};

fn convert_c_string(c_str: *const c_char) -> Result<String, std::str::Utf8Error> {
    if c_str.is_null() {
        Ok(String::new())
    } else {
        let bytes = unsafe { CStr::from_ptr(c_str) };
        let str = String::from(std::str::from_utf8(bytes.to_bytes())?);
        Ok(str)
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

struct Image(RawImage);

impl Image {
    fn new(inner: RawImage) -> Image {
        Image(inner)
    }

    fn load(path: &str) -> Result<Image, ()> {
        let path_str = CString::new(path).unwrap();
        let mut image = RawImage {
            mime_type: std::ptr::null(),
            data: std::ptr::null(),
            len: 0,
        };

        unsafe {
            match taglib_get_cover(path_str.as_ptr(), &mut image) {
                0 => Ok(Image::new(image)),
                _ => Err(()),
            }
        }
    }

    fn as_slice(&self) -> &[u8] {
        let &Image(ref raw) = self;
        unsafe { std::slice::from_raw_parts(raw.data, raw.len as usize) }
    }

    fn get_mime_type(&self) -> Result<String, std::str::Utf8Error> {
        let &Image(ref raw) = self;
        convert_c_string(raw.mime_type)
    }

    fn as_resp(&self) -> Result<resp::Value, ()> {
        let mimetype = match self.get_mime_type() {
            Ok(s) => resp::Value::String(s),
            Err(_) => return Err(())
        };
        let data = resp::Value::BufBulk(self.as_slice().to_owned());
        let body = vec![mimetype, data];
        Ok(resp::Value::Array(body))
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

fn load_tags(path: &str) -> Result<Vec<(String, String)>, ()> {
    let path_str = CString::new(path).unwrap();
    let mut result = Vec::new();
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

            result.push((key, value));
        }

        taglib_free(properties);

        Ok(result)
    }
}

fn main() {
    match pledge![Stdio, RPath, WPath] {
        Ok(_) | Err(pledge::Error::UnsupportedPlatform) => (),
        _ => panic!("Failed to pledge tag parser")
    }

    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    let mut rpc = bum_rpc::RPCInterface::new(stdin.lock());
    rpc.read_loop(|command, args| {
        let result = match command {
            "tags" => {
                let path = match args.get(0) {
                    Some(&resp::Value::String(ref path)) => path,
                    _ => panic!("Illegal tags request")
                };

                match load_tags(path) {
                    Err(_) => Err(()),
                    Ok(tags) => {
                        let tag_pairs = tags.iter().map(|&(ref k, ref v)| {
                            resp::Value::Bulk(format!("{}:{}", k, v))
                        }).collect::<Vec<resp::Value>>();
                        Ok(resp::Value::Array(tag_pairs))
                    }
                }
            },
            "cover" => {
                let path = match args.get(0) {
                    Some(&resp::Value::String(ref path)) => path,
                    _ => panic!("Illegal cover request")
                };

                match Image::load(path).and_then(|img| img.as_resp()) {
                    Err(_) => Err(()),
                    Ok(value) => Ok(value)
                }
            },
            _ => panic!("Illegal command: \"{}\"", command)
        };

        let value = match result {
            Ok(value) => value,
            Err(_) => resp::Value::Error("Error".to_owned())
        };

        bum_rpc::write(&mut stdout, &value);
    });
}
