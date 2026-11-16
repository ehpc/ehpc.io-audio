"""Admin regeneration: prove source identity, then enqueue ordinary owned jobs."""

import contextlib
import hashlib
import os
import shutil
import stat
from collections.abc import Callable, Iterator, Sequence
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import BinaryIO, Protocol, TypedDict

from backend import cache_catalog, config, db, drain


class SourceSelection(Protocol):
    song_id: str
    job_id: int


@dataclass
class RetrySelection:
    song_id: str
    job_id: int


class Candidate(TypedDict):
    job_id: int
    options: dict[str, object]


class CacheSong(cache_catalog.CacheSong):
    candidates: list[Candidate]


class AdminCacheSnapshot(TypedDict):
    songs: list[CacheSong]
    unattributed_bytes: int
    selective_ready: bool
    unsafe: bool
    busy: bool


class RegenerationResponse(TypedDict):
    jobs: list[db.RegenerationStatus]


@dataclass
class PreparedRegeneration:
    song_id: str
    job: db.SourceJob
    filename: str
    digest: str
    source: BinaryIO
    metadata: BinaryIO | None
    metadata_digest: str | None


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


def candidates(snapshot: cache_catalog.CacheSnapshot, busy: bool) -> AdminCacheSnapshot:
    visible = {song["id"] for song in snapshot["songs"]}
    digests = cache_catalog.song_digests(visible)
    reverse = {digest: ident for ident, digest in digests.items()}
    result: dict[str, list[Candidate]] = {ident: [] for ident in visible}
    for job in db.completed_jobs():
        try:
            with _source(job) as (_, source, _):
                ident = reverse.get(_digest(source))
                options = job.options
        except (OSError, ValueError):
            continue
        if ident is not None:
            result[ident].append({"job_id": job.id, "options": asdict(options)})
    return {
        **snapshot,
        "busy": busy,
        "songs": [
            {**song, "candidates": result[song["id"]]} for song in snapshot["songs"]
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


def enqueue(selection: Sequence[SourceSelection]) -> list[db.RegenerationStatus]:
    if drain.state.draining:
        raise ValueError("Server is draining")
    ids = [item.job_id for item in selection]
    if len(set(ids)) != len(ids):
        raise ValueError("Duplicate job selection")
    snapshot = cache_catalog.snapshot()
    visible = {song["id"] for song in snapshot["songs"]}
    digests = cache_catalog.song_digests(visible)
    return _enqueue(selection, digests)


def retry(job_id: int, session_id: str) -> db.RegenerationStatus:
    origin = db.regeneration_origin(job_id)
    if origin is None:
        raise ValueError("Regeneration snapshot unavailable")
    song_id, digest = origin
    return _enqueue([RetrySelection(song_id, job_id)], {song_id: digest}, session_id)[0]


def _enqueue(
    selection: Sequence[SourceSelection],
    digests: dict[str, str],
    retry_owner: str | None = None,
) -> list[db.RegenerationStatus]:
    if drain.state.draining:
        raise ValueError("Server is draining")
    created: list[Path] = []
    sidecars: list[Path] = []
    with contextlib.ExitStack() as stack:
        items: list[PreparedRegeneration] = []
        for item in selection:
            if item.song_id not in digests:
                raise LookupError("Unknown cached song")
            job = db.source_job(item.job_id, completed=retry_owner is None)
            if job is None or (
                retry_owner is not None and job.session_id != retry_owner
            ):
                raise ValueError("Completed original job unavailable")
            try:
                _ = job.options  # Validate before any mutation.
                filename, source, metadata = stack.enter_context(_source(job))
                digest = _digest(source)
                metadata_digest = _digest(metadata) if metadata is not None else None
            except (OSError, ValueError) as exc:
                raise ValueError("Original source unavailable") from exc
            if digest != digests[item.song_id]:
                raise ValueError("Job does not belong to selected song")
            if retry_owner is not None and db.regeneration_snapshot(job.id) != (
                filename,
                digest,
            ):
                raise ValueError("Regeneration source snapshot changed")
            items.append(
                PreparedRegeneration(
                    item.song_id,
                    job,
                    filename,
                    digest,
                    source,
                    metadata,
                    metadata_digest,
                )
            )

        def install(job_id: int, item: PreparedRegeneration) -> None:
            directory = config.UPLOADS_DIR / str(job_id)
            directory.mkdir(parents=True, exist_ok=False)
            created.append(directory)
            _copy_verified(item.source, directory / item.filename, item.digest)
            _sync_directory(directory)
            _sync_directory(config.UPLOADS_DIR)
            if item.job.source_type == "url":
                root = config.DATA_DIR / "source-metadata"
                root.mkdir(parents=True, exist_ok=True)
                _sync_directory(root)
                path = root / f"{job_id}.json"
                if item.metadata is not None:
                    assert item.metadata_digest is not None
                    _copy_verified(
                        item.metadata, path, item.metadata_digest, sidecars.append
                    )
                    _sync_directory(root)
                elif path.exists() or path.is_symlink():
                    raise ValueError("Unexpected existing metadata")

        try:
            new_ids = (
                db.enqueue_regenerations(items, install)
                if retry_owner is None
                else db.enqueue_regenerations(items, install, require_completed=False)
            )
        except BaseException:
            for path in sidecars:
                path.unlink(missing_ok=True)
            for directory in created:
                shutil.rmtree(directory)
            raise
    return [
        record for record in db.regeneration_status() if record["job_id"] in new_ids
    ]
