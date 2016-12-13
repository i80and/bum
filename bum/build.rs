extern crate gcc;
extern crate pkg_config;

fn get_builder() -> gcc::Config {
    let mut builder = gcc::Config::new();
    builder.flag("-Wall");
    builder.flag("-Wextra");
    builder.flag("-Wshadow");
    builder.flag("-Wno-unused-parameter");

    return builder;
}

fn compile_gstreamer() {
    let gst = pkg_config::find_library("gstreamer-1.0").unwrap();

    let mut builder = get_builder();
    builder.file("src/bum-transcode/bum-transcode.c");
    builder.define("D_REENTRANT", Some("1"));

    for include in gst.include_paths {
        builder.include(include);
    }

    builder.compile("libtranscode.a");
}

fn compile_libtagparse() {
    let taglib = pkg_config::find_library("taglib").unwrap();

    let mut builder = get_builder();
    builder.cpp(true);
    builder.flag("-std=c++98");
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
