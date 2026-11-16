"""Song-level regeneration and durable legacy source-snapshot retries."""

import contextlib
import hashlib
import os
import shutil
import stat
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO, TypedDict

from backend import cache_catalog, config, db, drain


class CacheSong(cache_catalog.CacheSong):
    regenerable: bool
    matched_jobs: int
    unavailable_reason: str | None


class AdminCacheSnapshot(TypedDict):
    songs: list[CacheSong]
    unattributed_bytes: int
    selective_ready: bool
    unsafe: bool
    busy: bool
    unmatched_completed_jobs: int


class RegenerationResponse(TypedDict):
    operations: list[db.RegenerationStatus]


@dataclass
class PreparedRegeneration:
    song_id: str
    job: db.SourceJob
    filename: str
    digest: str
    metadata_digest: str | None


@dataclass
class PreparedSong:
    song_id: str
    title: str | None
    digest: str
    items: list[PreparedRegeneration]


def _regular(directory: int, name: str) -> BinaryIO:
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    stream = os.fdopen(fd, "rb")
    if not stat.S_ISREG(os.fstat(fd).st_mode):
        stream.close()
        raise ValueError("Unsafe source file")
    return stream


def _digest(stream: BinaryIO) -> str:
    stream.seek(0)
    hasher = hashlib.sha256()
    while block := stream.read(1024 * 1024):
        hasher.update(block)
    value = hasher.hexdigest()
    stream.seek(0)
    return value


@contextlib.contextmanager
def _source(job: db.SourceJob) -> Iterator[tuple[str, BinaryIO, BinaryIO | None]]:
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    with contextlib.ExitStack() as stack:
        root = os.open(config.UPLOADS_DIR, flags)
        stack.callback(os.close, root)
        directory = os.open(str(job.id), flags, dir_fd=root)
        stack.callback(os.close, directory)
        names = os.listdir(directory)  # noqa: PTH208 - must use the verified dir fd
        if len(names) != 1 or names[0] in {"", ".", ".."}:
            raise ValueError("Original source unavailable")
        filename = names[0]
        if job.source_type == "upload" and filename != job.source_value:
            raise ValueError("Original source unavailable")
        source = stack.enter_context(_regular(directory, filename))
        if os.fstat(source.fileno()).st_size == 0:
            raise ValueError("Original source unavailable")
        metadata = None
        if job.source_type == "url":
            try:
                root = os.open(config.DATA_DIR / "source-metadata", flags)
            except FileNotFoundError:
                pass
            else:
                stack.callback(os.close, root)
                with contextlib.suppress(FileNotFoundError):
                    metadata = stack.enter_context(_regular(root, f"{job.id}.json"))
        yield filename, source, metadata


def _discover(digests: dict[str, str]) -> tuple[dict[str, list[db.SourceJob]], int]:
    reverse = {digest: ident for ident, digest in digests.items()}
    result: dict[str, list[db.SourceJob]] = {ident: [] for ident in digests}
    unavailable = 0
    for job in db.completed_jobs():
        try:
            with _source(job) as (_, source, _):
                ident = reverse.get(_digest(source))
                _ = job.options
        except (OSError, ValueError):
            unavailable += 1
            continue
        if ident is not None:
            result[ident].append(job)
    return result, unavailable


def candidates(snapshot: cache_catalog.CacheSnapshot, busy: bool) -> AdminCacheSnapshot:
    visible = {song["id"] for song in snapshot["songs"]}
    matches, unavailable = _discover(cache_catalog.song_digests(visible))
    return {
        **snapshot,
        "busy": busy,
        "unmatched_completed_jobs": unavailable,
        "songs": [
            {
                **song,
                "regenerable": bool(matches[song["id"]]),
                "matched_jobs": len(matches[song["id"]]),
                "unavailable_reason": None
                if matches[song["id"]]
                else "No completed job with a verified original is available",
            }
            for song in snapshot["songs"]
        ],
    }


def _copy_verified(
    source: BinaryIO,
    path: Path,
    expected: str,
    on_create: Callable[[Path], None] | None = None,
) -> None:
    source.seek(0)
    digest = hashlib.sha256()
    with path.open("xb") as output:
        if on_create is not None:
            on_create(path)
        while block := source.read(1024 * 1024):
            digest.update(block)
            output.write(block)
        output.flush()
        os.fsync(output.fileno())
    if digest.hexdigest() != expected:
        raise ValueError("Original source changed during copying")


def _sync_directory(path: Path) -> None:
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


@contextlib.contextmanager
def _installer() -> Iterator[Callable[[int, PreparedRegeneration], None]]:
    created: list[Path] = []
    sidecars: list[Path] = []

    def install(job_id: int, item: PreparedRegeneration) -> None:
        with _source(item.job) as (filename, source, metadata):
            if filename != item.filename or (metadata is None) != (
                item.metadata_digest is None
            ):
                raise ValueError("Original source changed during preparation")
            directory = config.UPLOADS_DIR / str(job_id)
            directory.mkdir(parents=True, exist_ok=False)
            created.append(directory)
            _copy_verified(source, directory / item.filename, item.digest)
            _sync_directory(directory)
            _sync_directory(config.UPLOADS_DIR)
            if item.job.source_type == "url":
                root = config.DATA_DIR / "source-metadata"
                root.mkdir(parents=True, exist_ok=True)
                _sync_directory(config.DATA_DIR)
                _sync_directory(root)
                path = root / f"{job_id}.json"
                if metadata is not None:
                    assert item.metadata_digest is not None
                    _copy_verified(
                        metadata, path, item.metadata_digest, sidecars.append
                    )
                    _sync_directory(root)
                elif path.exists() or path.is_symlink():
                    raise ValueError("Unexpected existing metadata")

    try:
        yield install
    except BaseException:
        for path in sidecars:
            path.unlink(missing_ok=True)
        for directory in created:
            shutil.rmtree(directory)
        raise


def _prepare_source(
    song_id: str, job: db.SourceJob, expected: str
) -> PreparedRegeneration:
    try:
        _ = job.options
        with _source(job) as (filename, source, metadata):
            digest = _digest(source)
            metadata_digest = _digest(metadata) if metadata is not None else None
    except (OSError, ValueError) as exc:
        raise ValueError("Original source unavailable") from exc
    if digest != expected:
        raise ValueError("Job does not belong to selected song")
    return PreparedRegeneration(song_id, job, filename, digest, metadata_digest)


def prepare(ids: list[str]) -> list[int]:
    if drain.state.draining:
        raise ValueError("Server is draining")
    if len(set(ids)) != len(ids):
        raise ValueError("Duplicate song selection")
    snapshot = cache_catalog.snapshot()
    visible = {song["id"]: song for song in snapshot["songs"]}
    if any(ident not in visible for ident in ids):
        raise LookupError("Unknown cached song")
    digests = cache_catalog.song_digests(set(ids))
    matches, _unavailable = _discover(digests)
    if any(not matches[ident] for ident in ids):
        raise ValueError("No completed job with a verified original is available")
    songs = [
        PreparedSong(
            ident,
            visible[ident]["title"],
            digests[ident],
            [_prepare_source(ident, job, digests[ident]) for job in matches[ident]],
        )
        for ident in ids
    ]
    with _installer() as install:
        return db.prepare_song_regenerations(songs, install)


class RetryStatus(TypedDict):
    job_id: int
    status: str
    position: int


def retry(job_id: int, session_id: str) -> RetryStatus:
    if drain.state.draining:
        raise ValueError("Server is draining")
    origin = db.regeneration_origin(job_id)
    job = db.source_job(job_id, completed=False)
    if origin is None or job is None or job.session_id != session_id:
        raise ValueError("Regeneration snapshot unavailable")
    song_id, digest = origin
    item = _prepare_source(song_id, job, digest)
    if db.regeneration_snapshot(job.id) != (item.filename, item.digest):
        raise ValueError("Regeneration source snapshot changed")
    with _installer() as install:
        new_id = db.enqueue_snapshot_retry([item], install)[0]
    return {"job_id": new_id, "status": "queued", "position": db.queue_position(new_id)}
