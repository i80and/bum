import json
import os
import socket
import sqlite3
import struct
from typing import Iterable, Tuple, List

import pypledge
import tornado.ioloop
import tornado.process
import tornado.web

message_header_t = struct.Struct('@BI')


def sandbox(pledges: Iterable[str]) -> None:
    try:
        pypledge.pledge(pledges)
    except OSError:
        pass


async def read_message(sock: tornado.iostream.IOStream) -> Tuple[int, bytes]:
    message_header = await sock.read_bytes(message_header_t.size)
    method, message_length = message_header_t.unpack(message_header)
    message_body = await sock.read_bytes(message_length)

    return (method, message_body)


async def send_message(sock: tornado.iostream.IOStream, method: int, message: bytes) -> None:
    packed = message_header_t.pack(method, len(message))
    await sock.write(packed)
    await sock.write(message)


def start_web() -> tornado.iostream.IOStream:
    child_sock, parent_sock = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM, 0)

    pid = os.fork()
    if pid > 0:
        child_sock.close()
        return tornado.iostream.IOStream(parent_sock)

    parent_sock.close()
    stream = tornado.iostream.IOStream(child_sock)
    sandbox(['stdio', 'inet', 'unix'])

    async def loop() -> None:
        while True:
            print(await read_message(stream))

    tornado.ioloop.IOLoop.current().spawn_callback(loop)
    tornado.ioloop.IOLoop.current().start()


def run() -> None:
    web_sock = start_web()
    sandbox(['stdio', 'unix', 'proc', 'exec'])

    async def foo():
        while True:
            method, body = await read_message(stream)

    tornado.ioloop.IOLoop.current().spawn_callback(foo)
    tornado.ioloop.IOLoop.current().start()

if __name__ == '__main__':
    run()
