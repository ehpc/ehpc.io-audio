"""Private content-addressed files; one producer per key, publish only on success."""

import asyncio
import contextvars
import fcntl
import hashlib
import json
import os
import tempfile
from collections.abc import AsyncIterator, Callable, Iterator
from contextlib import asynccontextmanager, contextmanager
from pathlib import Path
from typing import Protocol


class LineageRecorder(Protocol):
    def begin(self, path: Path) -> None: ...
    def complete(self, path: Path, *, leaf: bool) -> None: ...
    def record(self, path: Path) -> None: ...
    def bind(
        self, audio: bytes, title: str | None = None, artist: str | None = None
    ) -> None: ...


lineage_recorder: contextvars.ContextVar[LineageRecorder | None] = (
    contextvars.ContextVar("cache_lineage", default=None)
)
lineage_stack: contextvars.ContextVar[tuple[Path, ...]] = contextvars.ContextVar(
    "cache_lineage_stack", default=()
)


def complete_path(path: Path, *, leaf: bool = True) -> None:
    recorder = lineage_recorder.get()
    if recorder is not None:
        recorder.complete(path, leaf=leaf)


def record_path(path: Path) -> None:
    recorder = lineage_recorder.get()
    if recorder is not None:
        recorder.record(path)


def digest(data: bytes | memoryview) -> str:
    return hashlib.sha256(data).hexdigest()


def cache_key(*identity: object) -> str:
    return digest(json.dumps(identity, sort_keys=True, separators=(",", ":")).encode())


@contextmanager
def locked(path: Path) -> Iterator[None]:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+b") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def cached_bytes(root: Path, key: str, produce: Callable[[], bytes]) -> bytes:
    path = root / f"{key}.bin"
    with locked(root / f"{key}.lock"):
        if path.is_file():
            record_path(path)
            return path.read_bytes()
        recorder = lineage_recorder.get()
        if recorder is not None:
            recorder.begin(path)
        token = lineage_stack.set((*lineage_stack.get(), path))
        try:
            data = produce()
            atomic_write(path, data, complete=False)
            complete_path(path, leaf=False)
        finally:
            lineage_stack.reset(token)
        return data


def atomic_write(path: Path, data: bytes, *, complete: bool = True) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(dir=path.parent, prefix=".pending-")
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        Path(temporary).replace(path)
        record_path(path)
        if complete:
            complete_path(path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def sync_file(path: Path) -> None:
    """Durable local publication, including the rename's parent directory."""
    with path.open("rb") as handle:
        os.fsync(handle.fileno())
    descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


@asynccontextmanager
async def async_locked(path: Path) -> AsyncIterator[None]:
    """Wait without blocking the event loop or leaking work on cancellation."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+b") as handle:
        while True:
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                await asyncio.sleep(0.05)
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)
