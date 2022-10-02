import asyncio
import concurrent
import hashlib


class Worker:
    def __init__(self) -> None:
        self.pool = concurrent.futures.ThreadPoolExecutor(max_workers=1)

    async def hash(self, data: bytes, digest_size: int = 16) -> str:
        future = self.pool.submit(self._hash, data, digest_size)
        return await asyncio.wrap_future(future)

    def close(self) -> None:
        self.pool.shutdown()

    def __enter__(self) -> "Worker":
        return self

    def __exit__(self, *args: object) -> None:
        self.close()

    @staticmethod
    def _hash(data: bytes, digest_size: int) -> str:
        return hashlib.blake2b(data, digest_size=digest_size).hexdigest()
