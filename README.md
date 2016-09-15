Bum Media Server [![Build Status](https://travis-ci.org/i80and/bum.svg?branch=master)](https://travis-ci.org/i80and/bum)
================

![bum album browser](/doc/img/bum-screenshot.jpg?raw=true)

Installation
============

To compile Bum from source, you need the following:
* OpenBSD (recommended), Linux, or OS X
* Rust 1.9.0 or later
* TagLib
* GStreamer 1.0

To build and start Bum, run the following commands from the repository root:

    cd bum
    cargo build --release
    ./target/release/bum -m ~/Music
