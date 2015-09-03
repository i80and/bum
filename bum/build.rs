extern crate gcc;
extern crate pkg_config;

fn main() {
    let gst = pkg_config::find_library("gstreamer-1.0").unwrap();

    let mut builder = gcc::Config::new();
    builder.file("src/bum-transcode/bum-transcode.c");
    builder.define("D_REENTRANT", Some("1"));

    for include in gst.include_paths {
        builder.include(include);
    }

    builder.compile("libtranscode.a");
}
