use std;
use std::error::Error;

pub enum Quality {
    Low = 0,
    Medium = 1,
    High = 2
}

impl Quality {
    pub fn from_int(n: i64) -> Quality {
        if n <= 0 { Quality::Low }
        else if n == 1 { Quality::Medium }
        else { Quality::High }
    }

    pub fn to_int(&self) -> i8 {
        match self {
            &Quality::Low => 0,
            &Quality::Medium => 1,
            &Quality::High => 2
        }
    }
}

pub fn transcode(path: &std::path::Path, quality: Quality) -> Result<std::process::Child, String> {
    let child = std::process::Command::new("./target/debug/bum-transcode")
                                       .arg(quality.to_int().to_string())
                                       .arg(path)
                                       .stdout(std::process::Stdio::piped())
                                       .spawn();

    return match child {
        Ok(c) => Ok(c),
        Err(s) => Err(format!("Error starting transcode helper: {}", s.description()))
    };
}
