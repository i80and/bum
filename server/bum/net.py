import struct
from socket import socket
from typing import AsyncIterable, AsyncIterator, Awaitable, Dict, Tuple, List, TypeVar, \
    Optional, NamedTuple
import asyncio

message_header_t = struct.Struct('@III')
T = TypeVar('T')


class AsyncSocket(NamedTuple):
    reader: asyncio.StreamReader
    writer: asyncio.StreamWriter

    def write(self, data: bytes) -> None:
        self.writer.write(data)

    async def flush(self) -> None:
        await self.writer.drain()

    def read_bytes(self, n_bytes: int) -> Awaitable[bytes]:
        return self.reader.readexactly(n_bytes)

    @staticmethod
    async def create(sock: socket) -> 'AsyncSocket':
        (reader, writer) = await asyncio.open_connection(sock=sock)
        return AsyncSocket(reader, writer)


async def read_message(sock: AsyncSocket) -> Tuple[int, int, bytes]:
    ev = asyncio.get_event_loop()
    message_header = await sock.read_bytes(message_header_t.size)
    message_id, status, message_length = message_header_t.unpack(message_header)
    message_body = await sock.read_bytes(message_length)

    return (message_id, status, message_body)


async def send_message(sock: AsyncSocket, message_id: int, method: int, message: bytes) -> None:
    packed = message_header_t.pack(int(message_id), int(method), len(message))
    sock.write(packed)
    sock.write(message)
    await sock.flush()


class RPCClient:
    def __init__(self, sock: AsyncSocket) -> None:
        self.sock = sock
        self.pending = {}  # type: Dict[int, Tuple[asyncio.Queue[Tuple[int, bytes]], bool]]
        self.message_counter = 0

    async def subscribe(self,
                        method: int,
                        message: bytes,
                        subscribe: bool=True) -> AsyncIterable[Tuple[int, bytes]]:
        message_id = self.message_counter
        self.message_counter += 1

        await send_message(self.sock, message_id, int(method), message)
        queue = asyncio.Queue()
        l = (queue, subscribe)
        self.pending[message_id] = l
        while True:
            result = await queue.get()
            if result is None:
                return

            yield result

    async def call(self, method: int, message: bytes) -> Tuple[int, bytes]:
        async for result in self.subscribe(method, message, subscribe=False):
            return result

        assert False

    async def run(self) -> None:
        while True:
            message_id, response, body = await read_message(self.sock)

            l = self.pending[message_id]
            if l[1] and len(body) == 0:
                del self.pending[message_id]
                l[0].put_nowait(None)
                continue

            l[0].put_nowait((response, body))
