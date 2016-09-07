extern crate resp;
use std::io::{BufRead, Write};

pub struct RPCInterface<In> where In : BufRead {
    stream_in: In,
    line_buf: Vec<u8>,
    decoder: resp::Decoder,
}

impl<In> RPCInterface<In> where In : BufRead {
    pub fn new(stream_in: In) -> RPCInterface<In> {
        return RPCInterface {
            stream_in: stream_in,
            line_buf: Vec::new(),
            decoder: resp::Decoder::with_buf_bulk()
        };
    }

    pub fn read_value(&mut self) -> Option<resp::Value> {
        loop {
            self.line_buf.clear();
            match self.stream_in.read_until('\n' as u8, &mut self.line_buf) {
                Err(_) => return None,
                Ok(0) => return None,
                Ok(_) => ()
            }

            self.decoder.feed(&self.line_buf).unwrap();
            return match self.decoder.read() {
                Some(val) => Some(val),
                None => continue
            }
        }
    }

    pub fn read_loop<F>(&mut self, mut handler: F) where F : FnMut(&str, &[resp::Value]) {
        while match self.read_value() {
            Some(resp::Value::Array(ref args)) => {
                if args.len() == 0 {
                    panic!("Empty method call");
                }

                let method = match args[0] {
                    resp::Value::String(ref method) => method,
                    _ => panic!("Bad method call method type: \"{:?}\"", args[0])
                };
                handler(method, &args[1..]);
                true
            },
            None => false,
            v @ _ => panic!("Bad method call: \"{:?}\"", v)
        } {}
    }
}

pub fn write<Out>(stream: &mut Out, value: &resp::Value) where Out : Write {
    stream.write_all(&resp::encode(value)).unwrap();
    stream.flush().unwrap();
}

pub fn call<Out>(stream: &mut Out, method: &str, mut args: Vec<resp::Value>) where Out : Write {
    let mut array = vec![resp::Value::String(method.to_owned())];
    array.append(&mut args);
    write(stream, &resp::Value::Array(array));
}

pub fn value_to_string(value: resp::Value) -> Result<String, ()> {
    return match value {
        resp::Value::String(s) => Ok(s),
        resp::Value::Bulk(s) => Ok(s),
        resp::Value::BufBulk(buf) => match String::from_utf8(buf) {
            Ok(s) => Ok(s),
            Err(_) => Err(())
        },
        _ => Err(())
    };
}
