"""Private, process-local Kubernetes drain control."""

import asyncio
import contextlib
import errno
import fcntl
import os
import socket
import stat
import tempfile
import threading
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

SOCKET = Path(tempfile.gettempdir()) / f"vocaltools-{os.getuid()}" / "drain.sock"


class DrainDeferred(Exception):
    """An uncached inference stage must be resumed by the next worker."""


class DrainState:
    def __init__(self) -> None:
        self._owner_lock = threading.Lock()
        self._owned = False
        self.workers: list[asyncio.Task[None]] = []
        self.tracked: set[asyncio.Task[Any]] = set()
        self.active = 0
        self.reset()

    def acquire_lifespan(self) -> bool:
        with self._owner_lock:
            if self._owned:
                return False
            self._owned = True
            return True

    def release_lifespan(self) -> None:
        with self._owner_lock:
            self._owned = False

    def reset(self) -> None:
        if (
            self.active
            or any(not task.done() for task in self.workers)
            or any(not task.done() for task in self.tracked)
        ):
            raise RuntimeError("Cannot reset drain state while work is active")
        self.draining = False
        self.gate = asyncio.Lock()
        self.dispatch_lock = threading.Lock()
        self.active = 0
        self.idle = asyncio.Event()
        self.idle.set()
        self.changed = asyncio.Event()
        self.workers = []
        self.tracked = set()
        self.stop_search: asyncio.Event | None = None
        self.search_done: asyncio.Event | None = None
        self._failed = False

    async def enter(self) -> bool:
        if self.draining:
            return False
        async with self.gate:
            if self.draining:
                return False
            self.active += 1
            self.idle.clear()
            return True

    def leave(self) -> None:
        self.active -= 1
        if not self.active:
            self.idle.set()

    @contextlib.contextmanager
    def dispatch(self) -> Iterator[None]:
        with self.dispatch_lock:
            if self.draining:
                raise DrainDeferred()
            yield

    def _dispatch_barrier(self) -> None:
        with self.dispatch_lock:
            pass

    async def begin(self) -> None:
        if not self.draining:
            self.draining = True
            self.changed.set()
        if self.stop_search is not None:
            self.stop_search.set()
        # Claims already inside the gate and dispatches already holding the
        # lock must finish their check-and-start sections before drain proceeds.
        async with self.gate:
            pass
        await asyncio.to_thread(self._dispatch_barrier)

    def track(self, task: asyncio.Task[Any]) -> None:
        self.tracked.add(task)

        def completed(done: asyncio.Task[Any]) -> None:
            self.tracked.discard(done)
            if not done.cancelled():
                done.exception()

        task.add_done_callback(completed)

    def fail_drain(self) -> None:
        self._failed = True

    async def wait(self) -> None:
        await self.idle.wait()
        while self.tracked:
            await asyncio.gather(*self.tracked, return_exceptions=True)
        results = await asyncio.gather(*self.workers, return_exceptions=True)
        if self.search_done is not None:
            await self.search_done.wait()
        errors = [result for result in results if isinstance(result, BaseException)]
        if errors:
            raise BaseExceptionGroup("Drain worker failures", errors)
        if self._failed:
            raise RuntimeError("Drain cannot confirm all inference has completed")


state = DrainState()


@dataclass(frozen=True)
class _SocketOwner:
    path: Path
    device: int
    inode: int
    lock_fd: int


_socket_owners: dict[asyncio.AbstractServer, _SocketOwner] = {}


def cleanup_socket(server: asyncio.AbstractServer) -> None:
    owned = _socket_owners.pop(server, None)
    if owned is None:
        return
    try:
        try:
            current = owned.path.lstat()
        except FileNotFoundError:
            return
        if stat.S_ISSOCK(current.st_mode) and (current.st_dev, current.st_ino) == (
            owned.device,
            owned.inode,
        ):
            owned.path.unlink()
    finally:
        os.close(owned.lock_fd)


async def serve(*, start_serving: bool = True) -> asyncio.AbstractServer:
    async def handle(
        reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        try:
            if await reader.readline() == b"drain\n":
                await state.begin()
                await state.wait()
                writer.write(b"drained\n")
                await writer.drain()
        finally:
            writer.close()
            await writer.wait_closed()

    SOCKET.parent.mkdir(mode=0o700, exist_ok=True)
    parent = SOCKET.parent.lstat()
    if (
        not stat.S_ISDIR(parent.st_mode)
        or parent.st_uid != os.getuid()
        or stat.S_IMODE(parent.st_mode) != 0o700
    ):
        raise RuntimeError("Drain socket directory is not private and owned")
    lock_fd = os.open(SOCKET.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        locked_parent = os.fstat(lock_fd)
        if (locked_parent.st_dev, locked_parent.st_ino) != (
            parent.st_dev,
            parent.st_ino,
        ):
            raise RuntimeError("Drain socket directory changed during startup")
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise RuntimeError("Drain socket is already in use") from exc
        try:
            existing = SOCKET.lstat()
        except FileNotFoundError:
            pass
        else:
            if not stat.S_ISSOCK(existing.st_mode) or existing.st_uid != os.getuid():
                raise RuntimeError("Drain socket path is not an owned socket")
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as probe:
                try:
                    probe.connect(str(SOCKET))
                except OSError as exc:
                    if exc.errno != errno.ECONNREFUSED:
                        raise
                else:
                    raise RuntimeError("Drain socket is already in use")
            current = SOCKET.lstat()
            if (current.st_dev, current.st_ino) != (existing.st_dev, existing.st_ino):
                raise RuntimeError("Drain socket changed during stale socket check")
            SOCKET.unlink()
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            listener.bind(str(SOCKET))
            SOCKET.chmod(0o600)
            bound = SOCKET.lstat()
            listener.listen()
            listener.setblocking(False)
            server = await asyncio.start_unix_server(
                handle, sock=listener, start_serving=start_serving
            )
            _socket_owners[server] = _SocketOwner(
                SOCKET, bound.st_dev, bound.st_ino, lock_fd
            )
        except BaseException:
            listener.close()
            raise
    except BaseException:
        os.close(lock_fd)
        raise
    return server


def main() -> None:
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.connect(str(SOCKET))
        client.sendall(b"drain\n")
        with client.makefile("rb") as response:
            if response.readline() != b"drained\n":
                raise RuntimeError("Drain did not complete")


if __name__ == "__main__":
    main()
