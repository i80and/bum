use std::error::Error;
use std::io::Read;
use std::process::Child;
use std;

use util;

pub enum Quality {
    Low = 0,
    Medium = 1,
    High = 2,
}

impl Quality {
    pub fn from_int(n: i64) -> Quality {
        if n <= 0 {
            Quality::Low
        } else if n == 1 {
            Quality::Medium
        } else {
            Quality::High
        }
    }

    pub fn to_int(&self) -> i8 {
        match *self {
            Quality::Low => 0,
            Quality::Medium => 1,
            Quality::High => 2,
        }
    }
}

pub struct Transcoder {
    child: Child
}

impl Transcoder {
    pub fn transcode(path: &std::path::Path, quality: Quality) -> Result<Transcoder, String> {
        let child_path = util::get_helper("bum-transcode").unwrap();
        let child = std::process::Command::new(child_path)
            .arg(quality.to_int().to_string())
            .arg(path)
            .stdout(std::process::Stdio::piped())
            .spawn();

        let child = match child {
            Ok(c) => c,
            Err(s) => return Err(format!("Error starting transcode helper: {}", s.description())),
        };

        return Ok(Transcoder {
            child: child
        });
    }

    pub fn read(&mut self, mut buf: &mut [u8]) -> usize {
        let stdout = self.child.stdout.as_mut().unwrap();
        let bytes_read = stdout.read(&mut buf).unwrap();

        return bytes_read;
    }
}

impl Drop for Transcoder {
    fn drop(&mut self) {
        // Closing the child's stdout ensures that when it tries to write data,
        // it gets SIGPIPE and exits.
        self.child.stdout = None;

        match self.child.wait() {
            Ok(v) if !v.success() => error!("Transcoding failed"),
            _ => (),
        }
    }
}
