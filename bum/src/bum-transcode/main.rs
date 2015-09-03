extern crate libc;

use libc::c_int;
use std::os::unix::io::AsRawFd;

extern {
    fn transcode_music(infd: c_int, quality: c_int) -> c_int;
    fn transcode_init();
}

fn usage(code: i32) -> ! {
    println!("bum-transcode [quality: 0-2] [path]");
    std::process::exit(code);
}

fn main() {
    let args: Vec<String> = std::env::args().collect();

    let quality = args.get(1).unwrap_or_else(|| { usage(1); })
                      .parse::<c_int>().unwrap_or_else(|_| { usage(1); });
    let path = std::path::PathBuf::from(args.get(2).unwrap_or_else(|| usage(1)));
    let file = match std::fs::File::open(&path) {
        Ok(f) => f,
        Err(err) => panic!("Failed to open {}: {}", path.to_string_lossy(), err)
    };

    let fd = file.as_raw_fd();

    unsafe {
        transcode_init();
        let result = transcode_music(fd, quality);

        match result {
            i if i == 0 => (),
            _ => panic!("Transcoding error")
        }
    }
}
