"""Secure, bounded identity cache for private uploaded originals."""

import contextlib
import hashlib
import os
import stat
import threading
from collections import OrderedDict
from dataclasses import dataclass

from backend import config

type FileSignature = tuple[int, int, int, int, int]
type DirectorySignature = tuple[int, int]
type CacheKey = tuple[str, int, str, int, int, int, int, int]


@dataclass
class PendingHash:
    lock: threading.Lock
    users: int = 0


_lock = threading.Lock()
_cache: OrderedDict[CacheKey, str] = OrderedDict()
_pending: dict[CacheKey, PendingHash] = {}
_CACHE_LIMIT = 128


def clear_cache():
    with _lock:
        _cache.clear()


def _signature(info: os.stat_result) -> FileSignature:
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def _directory_signature(info: os.stat_result) -> DirectorySignature:
    return (info.st_dev, info.st_ino)


@dataclass
class SourceIdentity:
    digest: str
    name: str
    root: int
    directory: int
    descriptor: int
    root_signature: DirectorySignature
    directory_signature: DirectorySignature
    file_signature: FileSignature
    job_id: int

    def valid(self):
        try:
            flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
            root = os.open(config.UPLOADS_DIR, flags)
            try:
                directory = os.open(str(self.job_id), flags, dir_fd=root)
                try:
                    with os.scandir(directory) as entries:
                        names = [entry.name for entry in entries]
                    path_stat = os.stat(
                        self.name, dir_fd=directory, follow_symlinks=False
                    )
                    return (
                        names == [self.name]
                        and stat.S_ISREG(path_stat.st_mode)
                        and _directory_signature(os.fstat(root)) == self.root_signature
                        and _directory_signature(os.fstat(directory))
                        == self.directory_signature
                        and _directory_signature(os.fstat(self.root))
                        == self.root_signature
                        and _directory_signature(os.fstat(self.directory))
                        == self.directory_signature
                        and _signature(os.fstat(self.descriptor)) == self.file_signature
                        and _signature(path_stat) == self.file_signature
                    )
                finally:
                    os.close(directory)
            finally:
                os.close(root)
        except OSError:
            return False


def _open_identity(stack: contextlib.ExitStack, job_id: int) -> SourceIdentity | None:
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    root = os.open(config.UPLOADS_DIR, flags)
    stack.callback(os.close, root)
    directory = os.open(str(job_id), flags, dir_fd=root)
    stack.callback(os.close, directory)
    with os.scandir(directory) as entries:
        names = [entry.name for entry in entries]
    if len(names) != 1:
        return None
    descriptor = os.open(
        names[0], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory
    )
    stack.callback(os.close, descriptor)
    info = os.fstat(descriptor)
    if not stat.S_ISREG(info.st_mode):
        return None
    identity = SourceIdentity(
        "",
        names[0],
        root,
        directory,
        descriptor,
        _directory_signature(os.fstat(root)),
        _directory_signature(os.fstat(directory)),
        _signature(info),
        job_id,
    )
    if not identity.valid():
        return None
    key: CacheKey = (
        str(config.UPLOADS_DIR),
        job_id,
        names[0],
        *identity.file_signature,
    )
    with _lock:
        pending = _pending.get(key)
        if pending is None:
            pending = PendingHash(threading.Lock())
            _pending[key] = pending
        pending.users += 1
    try:
        with pending.lock:
            with _lock:
                digest = _cache.get(key)
                if digest is not None:
                    _cache.move_to_end(key)
            if digest is None:
                with os.fdopen(os.dup(descriptor), "rb") as stream:
                    digest = hashlib.file_digest(stream, "sha256").hexdigest()
                if identity.valid():
                    with _lock:
                        _cache[key] = digest
                        if len(_cache) > _CACHE_LIMIT:
                            _cache.popitem(last=False)
                else:
                    digest = None
    finally:
        with _lock:
            pending.users -= 1
            if not pending.users:
                del _pending[key]
    if digest is None or not identity.valid():
        return None
    identity.digest = digest
    return identity


@contextlib.contextmanager
def open_source(job_id: int):
    with contextlib.ExitStack() as stack:
        try:
            identity = _open_identity(stack, job_id)
        except OSError:
            identity = None
        yield identity


def source_identity(job):
    with open_source(job.id) as source:
        return (source.digest, source.name) if source is not None else None
