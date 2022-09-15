import asyncio
import struct
from asyncio import Queue
from io import BytesIO
from socket import socket
from typing import AsyncIterable, Dict, Iterable, NamedTuple, Optional, Tuple, TypeVar

message_header_t = struct.Struct("@III")
net_u32_t = struct.Struct("!L")
T = TypeVar("T")


class ErrorMessage(Exception):
    def __init__(self, code: int) -> None:
        super(ErrorMessage, self).__init__(code)
        self.code = code


class AsyncSocket(NamedTuple):
    reader: asyncio.StreamReader
    writer: asyncio.StreamWriter

    @staticmethod
    async def create(sock: socket) -> "AsyncSocket":
        (reader, writer) = await asyncio.open_connection(sock=sock)
        return AsyncSocket(reader, writer)


async def read_message(sock: AsyncSocket) -> Tuple[int, int, bytes]:
    message_header = await sock.reader.readexactly(message_header_t.size)
    message_id, status, message_length = message_header_t.unpack(message_header)
    message_body = await sock.reader.readexactly(message_length)

    return (message_id, status, message_body)


async def send_message(
    sock: AsyncSocket, message_id: int, method: int, message: bytes
) -> None:
    packed = message_header_t.pack(int(message_id), int(method), len(message))
    sock.writer.write(packed)
    sock.writer.write(message)
    await sock.writer.drain()


class RPCClient:
    def __init__(self, sock: AsyncSocket) -> None:
        self.sock = sock
        self.pending = {}  # type: Dict[int, Queue[Tuple[int, Optional[bytes]]]]
        self.message_counter = 0

    def get_message_id(self) -> int:
        message_id = self.message_counter
        self.message_counter += 1
        return message_id

    async def subscribe(
        self, method: int, message: bytes, message_id: int
    ) -> AsyncIterable[Tuple[int, Optional[bytes]]]:
        await send_message(self.sock, message_id, int(method), message)
        queue = Queue()  # type: Queue[Tuple[int, Optional[bytes]]]
        self.pending[message_id] = queue

        try:
            while True:
                result = await queue.get()
                yield result

                if result[1] is None:
                    return
        finally:
            del self.pending[message_id]

    def cancel(self, code: int, message_id: int) -> None:
        try:
            self.pending[message_id].put_nowait((code, None))
        except KeyError:
            pass

    async def call(
        self, method: int, message: bytes, message_id: int = None
    ) -> Tuple[int, bytes]:
        if message_id is None:
            message_id = self.get_message_id()

        async for result in self.subscribe(method, message, message_id=message_id):
            if result[1] is None:
                return (result[0], b"")

            return (result[0], result[1])

        assert False

    async def run(self) -> None:
        while True:
            message_id, response, body = await read_message(self.sock)
            try:
                self.pending[message_id].put_nowait((response, body))
            except KeyError:
                pass


def pack_sequence(data_sequence: Iterable[bytes]) -> bytes:
    data = BytesIO()
    for item in data_sequence:
        data.write(net_u32_t.pack(len(item)))
        data.write(item)

    return data.getvalue()


def unpack_sequence(data: bytes) -> Iterable[bytes]:
    view = memoryview(data)
    while len(view) > 0:
        (data_size,) = net_u32_t.unpack_from(view)
        data = view[net_u32_t.size : (net_u32_t.size + data_size)].tobytes()
        yield data

        view = view[(net_u32_t.size + data_size) :]
