import struct
from socket import socket
from typing import AsyncIterable, AsyncIterator, Awaitable, Dict, Tuple, List, TypeVar, \
    Optional, NamedTuple
import asyncio
from asyncio import Queue

message_header_t = struct.Struct('@III')
T = TypeVar('T')


class ErrorMessage(Exception):
    def __init__(self, code: int) -> None:
        super(ErrorMessage, self).__init__(code)
        self.code = code


class AsyncSocket(NamedTuple):
    reader: asyncio.StreamReader
    writer: asyncio.StreamWriter

    @staticmethod
    async def create(sock: socket) -> 'AsyncSocket':
        (reader, writer) = await asyncio.open_connection(sock=sock)
        return AsyncSocket(reader, writer)


async def read_message(sock: AsyncSocket) -> Tuple[int, int, bytes]:
    ev = asyncio.get_event_loop()
    message_header = await sock.reader.readexactly(message_header_t.size)
    message_id, status, message_length = message_header_t.unpack(message_header)
    message_body = await sock.reader.readexactly(message_length)

    return (message_id, status, message_body)


async def send_message(sock: AsyncSocket, message_id: int, method: int, message: bytes) -> None:
    packed = message_header_t.pack(int(message_id), int(method), len(message))
    sock.writer.write(packed)
    sock.writer.write(message)
    await sock.writer.drain()


class RPCClient:
    def __init__(self, sock: AsyncSocket) -> None:
        self.sock = sock
        self.pending = {}  # type: Dict[int, Tuple[Queue[Tuple[int, Optional[bytes]]], bool]]
        self.message_counter = 0

    def get_message_id(self) -> int:
        message_id = self.message_counter
        self.message_counter += 1
        return message_id

    async def subscribe(self,
                        method: int,
                        message: bytes,
                        subscribe: bool=True,
                        message_id: int=None) -> AsyncIterable[Tuple[int, Optional[bytes]]]:
        if message_id is None:
            message_id = self.get_message_id()

        await send_message(self.sock, message_id, int(method), message)
        queue = Queue()  # type: Queue[Tuple[int, Optional[bytes]]]
        l = (queue, subscribe)
        self.pending[message_id] = l
        while True:
            result = await queue.get()
            yield result

            if result[1] is None:
                return

    def cancel(self, code: int, message_id: int) -> None:
        l = self.pending[message_id]
        l[0].put_nowait((code, None))
        del self.pending[message_id]

    async def call(self, method: int, message: bytes, message_id: int=None) -> Tuple[int, bytes]:
        async for result in self.subscribe(method, message, subscribe=False, message_id=message_id):
            if result[1] is None:
                return (result[0], b'')

            return (result[0], result[1])

        assert False

    async def run(self) -> None:
        while True:
            message_id, response, body = await read_message(self.sock)

            try:
                l = self.pending[message_id]
                if l[1] and len(body) == 0:
                    l[0].put_nowait((response, None))
                    del self.pending[message_id]
                    continue

                l[0].put_nowait((response, body))
            except KeyError:
                pass
