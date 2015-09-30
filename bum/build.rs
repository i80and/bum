extern crate gcc;
extern crate pkg_config;

fn compile_gstreamer() {
    let gst = pkg_config::find_library("gstreamer-1.0").unwrap();

    let mut builder = gcc::Config::new();
    builder.file("src/bum-transcode/bum-transcode.c");
    builder.define("D_REENTRANT", Some("1"));

    for include in gst.include_paths {
        builder.include(include);
    }

    builder.compile("libtranscode.a");
}

fn compile_libtagparse() {
    let taglib = pkg_config::find_library("taglib").unwrap();

    let mut builder = gcc::Config::new();
    builder.cpp(true);
    builder.flag("-std=c++11");
    builder.file("src/tag-parser/tag-parser.cpp");

    for include in taglib.include_paths {
        builder.include(include);
    }

    builder.compile("libtagparser.a");
}

fn main() {
    compile_gstreamer();
    compile_libtagparse();
}
