use byteorder::{BigEndian, ReadBytesExt, WriteBytesExt};
use gstreamer::prelude::*;
use std::env;
use std::error::Error;
use std::fs;
use std::io::{self, Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::str;

use scoped_threadpool::Pool;
use std::sync::mpsc::channel;
use std::sync::mpsc::{Receiver, Sender};

const THUMBNAIL_SIZE: usize = 200;
const FULLSIZE_WIDTH: usize = 2048;

enum TranscodeFormat {
    WebM,
    Ogg,
}

impl TranscodeFormat {
    fn parse(s: &str) -> Result<Self, ()> {
        match s {
            "webm" => Ok(TranscodeFormat::WebM),
            "ogg" => Ok(TranscodeFormat::Ogg),
            _ => Err(()),
        }
    }

    fn get_element_definitions(&self) -> &'static str {
        match self {
            TranscodeFormat::WebM => "audioresample ! opusenc bitrate=128000 ! webmmux",
            TranscodeFormat::Ogg => "vorbisenc quality=0.5 ! oggmux",
        }
    }
}

fn remove_image(
    pad: &gstreamer::Pad,
    parent: Option<&gstreamer::Object>,
    event: gstreamer::Event,
) -> bool {
    if let gstreamer::EventView::Tag(t) = event.view() {
        let mut tags = t.tag_owned();
        // gst_event_parse_tag(event, &tags);
        tags.make_mut().remove::<gstreamer::tags::Image>();
        let event2 = gstreamer::event::Tag::new(tags);
        return pad.event_default(parent, event2);
    }

    pad.event_default(parent, event)
}

fn transcode_audio(format: TranscodeFormat, path: &Path) {
    gstreamer::init().unwrap();
    let pipeline = gstreamer::parse_launch(&format!(
        "
        filesrc name=src ! decodebin ! queue ! audioconvert name=converter !
        {} ! fdsink name=sink fd=1
    ",
        format.get_element_definitions()
    ))
    .expect("Failed to create reencoding pipeline");

    let pipeline = pipeline.dynamic_cast::<gstreamer::Pipeline>().unwrap();

    let src = pipeline.by_name("src").unwrap();
    src.set_property(
        "location",
        path.to_str().expect("Only stringy paths can be used"),
    );

    let converter = pipeline.by_name("converter").unwrap();
    let converter_sink = converter.static_pad("sink").unwrap();

    unsafe {
        converter_sink.set_event_function(remove_image);
    }

    pipeline.set_state(gstreamer::State::Playing).unwrap();

    /* Wait until error or EOS */
    let bus = pipeline.bus().unwrap();
    for msg in bus.iter_timed(gstreamer::ClockTime::NONE) {
        use gstreamer::MessageView;

        match msg.view() {
            MessageView::Eos(..) => break,
            MessageView::Error(err) => {
                eprintln!(
                    "Error from {:?}: {} ({:?})",
                    err.src().map(|s| s.path_string()),
                    err.error(),
                    err.debug()
                );
                break;
            }
            _ => (),
        }
    }

    /* Free resources */
    pipeline.set_state(gstreamer::State::Null).unwrap();
}

fn get_target_size(width: usize, height: usize, thumbnail: bool) -> (usize, usize) {
    if thumbnail {
        // Thumbnails must FIT WITHIN a 200x200 box
        let ratio = if width > height {
            THUMBNAIL_SIZE as f64 / width as f64
        } else {
            THUMBNAIL_SIZE as f64 / height as f64
        };

        (
            (width as f64 * ratio) as usize,
            (height as f64 * ratio) as usize,
        )
    } else {
        // Full covers must be at most 2048 pixels wide
        let ratio = FULLSIZE_WIDTH as f64 / width as f64;
        (
            (width as f64 * ratio) as usize,
            (height as f64 * ratio) as usize,
        )
    }
}

fn compress(
    path: &Path,
    thumbnail: bool,
    data: Option<&Vec<u8>>,
) -> Result<Vec<u8>, Box<dyn Error>> {
    let (format, img) = match data {
        Some(data) => {
            let reader = image::io::Reader::new(Cursor::new(data)).with_guessed_format()?;
            (reader.format(), reader.decode()?)
        }
        None => {
            let reader = image::io::Reader::open(path)?.with_guessed_format()?;
            (reader.format(), reader.decode()?)
        }
    };
    let width = img.width() as usize;
    let height = img.height() as usize;

    let (resized_width, resized_height) = get_target_size(width, height, thumbnail);

    // Avoid recompressing if it's already a jpeg and we don't need to rescale
    if resized_width >= width && format == Some(image::ImageFormat::Jpeg) {
        eprintln!("DEBUG: Not compressing {}", path.to_string_lossy());
        return Ok(fs::read(path)?);
    }

    let resized_img = img.resize(
        resized_width as u32,
        resized_height as u32,
        image::imageops::FilterType::CatmullRom,
    );

    let rgb8 = resized_img.into_rgb8();
    let rgb8_data = rgb8.as_raw();
    let (resized_width, resized_height) = rgb8.dimensions();
    let resized_width = resized_width as usize;
    let resized_height = resized_height as usize;

    let mut comp = mozjpeg::Compress::new(mozjpeg::ColorSpace::JCS_RGB);
    comp.set_scan_optimization_mode(mozjpeg::ScanMode::Auto);

    comp.set_size(resized_width, resized_height);
    comp.set_mem_dest();
    comp.set_optimize_scans(true);
    comp.set_use_scans_in_trellis(true);
    comp.start_compress();

    let row_stride = resized_width * rgb8.sample_layout().channels as usize;
    for line in 0..resized_height {
        comp.write_scanlines(&rgb8_data[line * row_stride..(line + 1) * row_stride]);
    }
    comp.finish_compress();

    comp.data_to_vec()
        .map_err(|_| Box::from("data_to_vec failed"))
}

type CoverMessage = Option<(PathBuf, Option<Vec<u8>>)>;

fn get_covers(paths: &[&Path], thumbnail: bool) {
    let mut pool = Pool::new(num_cpus::get_physical() as u32);

    let (tx, rx): (Sender<CoverMessage>, Receiver<CoverMessage>) = channel();

    for path in paths {
        tx.send(Some((path.into(), None))).unwrap();
    }

    std::thread::spawn(move || {
        let mut stdin = io::stdin().lock();
        let mut path_buf: Vec<u8> = vec![];
        loop {
            path_buf.clear();

            let path_len = match stdin.read_u32::<BigEndian>() {
                Err(ref e) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
                Err(e) => panic!("Unexpected error reading: {}", e),
                Ok(binary) => binary,
            };
            let data_len = stdin.read_u32::<BigEndian>().unwrap();

            stdin
                .by_ref()
                .take(path_len as u64)
                .read_to_end(&mut path_buf)
                .unwrap();

            let data_buf: Option<Vec<u8>> = match data_len {
                0 => None,
                _ => {
                    let mut buf = vec![];
                    stdin
                        .by_ref()
                        .take(data_len as u64)
                        .read_to_end(&mut buf)
                        .unwrap();
                    Some(buf)
                }
            };

            let path_string = str::from_utf8(&path_buf).unwrap();
            tx.send(Some((path_string.into(), data_buf))).unwrap();
        }
    });

    pool.scoped(|scope| {
        while let Ok(Some((path, maybe_data))) = rx.recv() {
            scope.execute(move || {
                let path_string = path.to_string_lossy();
                let data = match compress(&path, thumbnail, maybe_data.as_ref()) {
                    Ok(data) => data,
                    Err(msg) => {
                        eprintln!("Error processing {}: {}", path_string, msg);
                        vec![]
                    }
                };

                let mut stdout = io::stdout().lock();
                // 8 byte entry header
                stdout
                    .write_u32::<BigEndian>(path_string.len() as u32)
                    .unwrap();
                stdout.write_u32::<BigEndian>(data.len() as u32).unwrap();
                stdout.write_all(path_string.as_bytes()).unwrap();
                stdout.write_all(&data).unwrap();
            });
        }
    });
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let command = &args[1];

    let get_paths = || args[2..].iter().map(Path::new).collect::<Vec<&Path>>();

    match command.as_ref() {
        "transcode-audio" => {
            let format = TranscodeFormat::parse(&args[2])
                .expect("Requested format must be either 'webm' or 'ogg'");
            let path = Path::new(&args[3]);
            transcode_audio(format, path);
        }
        "get-thumbnails" => {
            get_covers(&get_paths(), true);
        }
        "get-cover" => {
            get_covers(&get_paths(), false);
        }
        _ => {
            panic!("Unexpected command")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_get_target_size() {
        assert_eq!(
            get_target_size(THUMBNAIL_SIZE, THUMBNAIL_SIZE, true),
            (THUMBNAIL_SIZE, THUMBNAIL_SIZE)
        );
        assert_eq!(
            get_target_size(THUMBNAIL_SIZE * 2, THUMBNAIL_SIZE, true),
            (THUMBNAIL_SIZE, THUMBNAIL_SIZE / 2)
        );
        assert_eq!(
            get_target_size(THUMBNAIL_SIZE / 2, THUMBNAIL_SIZE, true),
            (THUMBNAIL_SIZE / 2, THUMBNAIL_SIZE)
        );

        assert_eq!(
            get_target_size(FULLSIZE_WIDTH, FULLSIZE_WIDTH, false),
            (FULLSIZE_WIDTH, FULLSIZE_WIDTH)
        );
        assert_eq!(
            get_target_size(FULLSIZE_WIDTH * 2, FULLSIZE_WIDTH, false),
            (FULLSIZE_WIDTH, FULLSIZE_WIDTH / 2)
        );
        assert_eq!(
            get_target_size(FULLSIZE_WIDTH / 2, FULLSIZE_WIDTH, false),
            (FULLSIZE_WIDTH, FULLSIZE_WIDTH * 2)
        );
        assert_eq!(
            get_target_size(FULLSIZE_WIDTH, FULLSIZE_WIDTH * 2, false),
            (FULLSIZE_WIDTH, FULLSIZE_WIDTH * 2)
        );
        assert_eq!(
            get_target_size(FULLSIZE_WIDTH * 2, FULLSIZE_WIDTH * 4, false),
            (FULLSIZE_WIDTH, FULLSIZE_WIDTH * 2)
        );
    }
}
