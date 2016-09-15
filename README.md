[![Build Status](https://travis-ci.org/i80and/bum.svg?branch=master)](https://travis-ci.org/i80and/bum)

Bum Media Server
================

![bum album browser](/doc/img/bum-screenshot.jpg?raw=true)

Installation
============

To compile Bum from source, you need the following:
* OpenBSD (recommended), Linux, or OS X
* Rust 1.9.0 or later
* TagLib
* GStreamer 1.0

Build and start Bum in the following way:

    cargo build --release
    ./target/release/bum -m ~/Music
