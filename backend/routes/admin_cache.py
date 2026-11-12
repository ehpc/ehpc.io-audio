"""Administrator-only, quiescent eviction of reusable audio artifacts."""

import asyncio
import contextlib
import hashlib
import json
import os
import re
import stat
from dataclasses import dataclass

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, model_validator

from backend import cache_catalog, config, db, drain
from backend.models import JobStatus
from backend.routes.auth import admin
from separator.inference_transport import validate_output_id

router = APIRouter(tags=["admin-cache"])


class AdminCacheSnapshot(cache_catalog.CacheSnapshot):
    busy: bool


_KEY = re.compile(r"[0-9a-f]{64}\Z")


class ClearRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    ids: list[str] | None = Field(default=None, min_length=1)
    all: bool | None = Field(default=None, strict=True)

    @model_validator(mode="after")
    def one_selection(self):
        if (self.ids is None) == (self.all is not True) or self.all is False:
            raise ValueError("Specify either ids or all=true")
        return self


class CacheConflict(Exception):
    pass


@dataclass
class File:
    files: "Files"
    relative: str
    identity: tuple[int, int]
    size: int

    @contextlib.contextmanager
    def open(self):
        with self.files.parent(self.relative) as (directory, name):
            fd = os.open(
                name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory
            )
            with os.fdopen(fd, "rb") as source:
                info = os.fstat(source.fileno())
                if (
                    not stat.S_ISREG(info.st_mode)
                    or (info.st_dev, info.st_ino) != self.identity
                    or info.st_size != self.size
                ):
                    raise CacheConflict("A cache file changed during clearing")
                yield source

    def unlink(self) -> None:
        with self.files.parent(self.relative) as (directory, name):
            current = os.stat(name, dir_fd=directory, follow_symlinks=False)
            if (
                not stat.S_ISREG(current.st_mode)
                or (current.st_dev, current.st_ino) != self.identity
                or current.st_size != self.size
            ):
                raise CacheConflict("A cache file changed during clearing")
            os.unlink(name, dir_fd=directory)
            os.fsync(directory)


@dataclass(frozen=True)
class VerifiedLedgerEntry:
    receipt: File
    artifact: File | None
    failure_job_id: int | None = None


class Files:
    """Open only relative, no-follow paths under the artifact root."""

    def __init__(self, stack: contextlib.ExitStack):
        self.root = os.open(
            config.DATA_DIR, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
        )
        stack.callback(os.close, self.root)
        try:
            self.root = os.open(
                "artifacts",
                os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                dir_fd=self.root,
            )
            stack.callback(os.close, self.root)
        except FileNotFoundError:
            self.root = None

    @contextlib.contextmanager
    def directory(self, parts):
        if self.root is None:
            raise FileNotFoundError
        with contextlib.ExitStack() as stack:
            fd = self.root
            for part in parts:
                fd = os.open(
                    part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd
                )
                stack.callback(os.close, fd)
            yield fd

    @contextlib.contextmanager
    def parent(self, relative):
        parts = relative.split("/")
        if not parts or any(p in {"", ".", ".."} for p in parts):
            raise CacheConflict("Invalid cache path")
        with self.directory(parts[:-1]) as directory:
            yield directory, parts[-1]

    def file(self, relative: str) -> File:
        with self.parent(relative) as (directory, name):
            fd = os.open(
                name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory
            )
            try:
                info = os.fstat(fd)
            finally:
                os.close(fd)
        if not stat.S_ISREG(info.st_mode):
            raise CacheConflict("Unsafe cache file")
        return File(self, relative, (info.st_dev, info.st_ino), info.st_size)


def _read(file: File) -> bytes:
    with file.open() as source:
        return source.read()


def _matches(file: File, sha, size, *, verify_content: bool = True) -> bool:
    if (
        not isinstance(sha, str)
        or not _KEY.fullmatch(sha)
        or type(size) is not int
        or size < 0
        or file.size != size
    ):
        return False
    if not verify_content:
        return True
    with file.open() as source:
        return hashlib.file_digest(source, "sha256").hexdigest() == sha


def _ledger(
    files: Files,
    owners: list[db.StageOwner],
    *,
    verify_content: bool = True,
    only_key: str | None = None,
) -> dict[str, VerifiedLedgerEntry]:
    """Verify durable dispatches, or one specific dispatch when deleting a job."""
    if only_key is not None:
        if not _KEY.fullmatch(only_key):
            raise CacheConflict("Invalid inference key")
        names = [f"{only_key}.json"]
    else:
        try:
            with (
                files.directory(["inference-requests"]) as directory,
                os.scandir(directory) as entries,
            ):
                names = [entry.name for entry in entries]
        except FileNotFoundError:
            names = []
    receipts = {}
    if names:
        for name in names:
            if name.endswith(".lock"):
                continue
            if not name.endswith(".json") or not _KEY.fullmatch(name[:-5]):
                raise CacheConflict("Unknown inference ledger entry")
            key = name[:-5]
            receipt_file = files.file("inference-requests/" + name)
            try:
                receipt = json.loads(_read(receipt_file))
                if not isinstance(receipt, dict):
                    raise ValueError
                output_id = validate_output_id(receipt.get("output_id"))
            except (ValueError, TypeError, UnicodeError):
                raise CacheConflict("Invalid inference receipt") from None
            if (
                receipt.get("cleaned") is not True
                or receipt.get("cleanup_pending") is not False
            ):
                raise CacheConflict(
                    "Inference transfer is unresolved or cleanup is pending"
                )
            if "failure_sha256" in receipt:
                failure_job_id = receipt.get("failure_job_id")
                if type(failure_job_id) is not int or "result_sha256" in receipt:
                    raise CacheConflict("Invalid terminal inference failure")
                failed_job = db.get_job(failure_job_id)
                if failed_job is None or failed_job.status != JobStatus.FAILED:
                    raise CacheConflict("Inference failure has no failed job")
                try:
                    diagnostic = files.file(f"inference-diagnostics/{output_id}.log")
                except FileNotFoundError:
                    raise CacheConflict(
                        "Inference failure diagnostics are missing"
                    ) from None
                if not _matches(
                    diagnostic,
                    receipt.get("failure_sha256"),
                    receipt.get("failure_size"),
                    verify_content=verify_content,
                ):
                    raise CacheConflict("Inference failure diagnostics are invalid")
                try:
                    files.file(f"inference/{key}.bin")
                except FileNotFoundError:
                    pass
                else:
                    raise CacheConflict("Inference failure has a conflicting result")
                receipts[key] = VerifiedLedgerEntry(receipt_file, None, failure_job_id)
            else:
                try:
                    artifact = files.file(f"inference/{key}.bin")
                except FileNotFoundError:
                    raise CacheConflict(
                        "Completed inference artifact is missing"
                    ) from None
                if not _matches(
                    artifact,
                    receipt.get("result_sha256"),
                    receipt.get("result_size"),
                    verify_content=verify_content,
                ):
                    raise CacheConflict("Completed inference artifact is invalid")
                receipts[key] = VerifiedLedgerEntry(receipt_file, artifact)
    for job_id, key, call_id in owners:
        if (
            not isinstance(key, str)
            or not _KEY.fullmatch(key)
            or not isinstance(call_id, str)
            or not call_id
        ):
            raise CacheConflict("Inference ownership is uncertain")
        entry = receipts.get(key)
        if entry is None:
            raise CacheConflict("Inference ownership has no verified receipt")
        if entry.artifact is None and entry.failure_job_id != job_id:
            raise CacheConflict("Inference failure belongs to another job")
    owner_keys = {(job_id, key) for job_id, key, _call_id in owners}
    for key, entry in receipts.items():
        if (
            entry.failure_job_id is not None
            and (entry.failure_job_id, key) not in owner_keys
        ):
            raise CacheConflict("Inference failure has no durable owner")
    return receipts


def _busy() -> bool:
    if (
        drain.state.draining
        or drain.state.active
        or any(not t.done() for t in drain.state.tracked)
    ):
        return True
    busy, owners = db.cache_work_state()
    if busy:
        return True
    if cache_catalog.unsafe_paths():
        return True
    try:
        with contextlib.ExitStack() as stack:
            _ledger(Files(stack), owners, verify_content=False)
    except (CacheConflict, OSError):
        return True
    return False


def _clear(body: ClearRequest) -> dict:
    if (
        drain.state.draining
        or drain.state.active
        or any(not t.done() for t in drain.state.tracked)
    ):
        raise CacheConflict("Cache producers are active or server is draining")
    busy, owners = db.cache_work_state()
    if busy:
        raise CacheConflict("Jobs or searches are queued or running")
    snapshot = cache_catalog.snapshot()
    if snapshot.get("unsafe"):
        raise CacheConflict(
            "Unsafe cache files or directories require operator attention"
        )
    if body.ids is not None and not snapshot["selective_ready"]:
        raise CacheConflict(
            "Historical cache attribution is incomplete; clear all first"
        )
    try:
        if body.all:
            paths = cache_catalog.all_paths()
        elif body.ids is not None:
            paths = cache_catalog.select_paths(body.ids)
        else:
            raise CacheConflict("No cache selection")
    except (KeyError, ValueError):
        if body.all or cache_catalog.unsafe_paths():
            raise CacheConflict(
                "Unsafe cache files or directories require operator attention"
            ) from None
        raise HTTPException(404, "Unknown cache song") from None

    removed: set[str] = set()
    reclaimed = 0
    try:
        with contextlib.ExitStack() as stack:
            files = Files(stack)
            receipts = _ledger(files, owners)
            selected = {path: files.file(path) for path in paths}
            keys = {
                path.split("/")[1][:-4]
                for path in paths
                if re.fullmatch(r"inference/[0-9a-f]{64}\.bin", path)
            }
            # Never treat arbitrary catalog entries as inference receipts or lockfiles.
            if any(
                path.endswith(".lock") or path.startswith("inference-requests/")
                for path in paths
            ):
                raise CacheConflict("Unsafe cache selection")
            if any(key in receipts and receipts[key].artifact is None for key in keys):
                raise CacheConflict("Cannot remove a failed inference ledger")
            for key in keys & receipts.keys():
                artifact = receipts[key].artifact
                chosen = selected[f"inference/{key}.bin"]
                if artifact is None or (artifact.identity, artifact.size) != (
                    chosen.identity,
                    chosen.size,
                ):
                    raise CacheConflict("Inference artifact changed during validation")
            retiring: list[db.RetiringStage] = []
            for job_id, key, call_id in owners:
                if key in keys:
                    if call_id is None:
                        raise CacheConflict("Inference ownership is uncertain")
                    retiring.append((job_id, key, call_id))
            db.retire_cache_stages(retiring, invalidate_search=bool(body.all))
            for key in sorted(keys):
                if key in receipts:
                    receipt = receipts[key].receipt
                    receipt.unlink()
                    reclaimed += receipt.size
            for path, file in sorted(selected.items()):
                # Forget on any attempted unlink, including a failed directory fsync.
                removed.add(path)
                file.unlink()
                reclaimed += file.size
    except (OSError, ValueError) as exc:
        raise CacheConflict("Cache or inference ledger changed or is unsafe") from exc
    finally:
        if removed:
            cache_catalog.forget_paths(removed)
    return {"cleared": len(removed), "reclaimed_bytes": reclaimed}


async def _under_gate(function, *args):
    async with drain.state.gate:
        # Do not release the gate if a cancelled request's thread is still writing.
        task = asyncio.create_task(asyncio.to_thread(function, *args))
        try:
            return await asyncio.shield(task)
        except asyncio.CancelledError:
            while not task.done():
                try:
                    await asyncio.shield(task)
                except asyncio.CancelledError:
                    continue
                except Exception:
                    break
            if not task.cancelled():
                task.exception()
            raise


@router.get("/admin/cache")
async def list_cache(request: Request) -> AdminCacheSnapshot:
    admin(request)

    def read_snapshot() -> AdminCacheSnapshot:
        return {**cache_catalog.snapshot(), "busy": _busy()}

    return await _under_gate(read_snapshot)


@router.post("/admin/cache/clear")
async def clear_cache(body: ClearRequest, request: Request) -> dict:
    admin(request)
    try:
        return await _under_gate(_clear, body)
    except CacheConflict as exc:
        raise HTTPException(409, str(exc)) from None
