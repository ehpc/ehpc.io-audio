import asyncio
import contextlib
import fcntl
import hashlib
import json
import os
import shutil
import stat
import tempfile
from dataclasses import fields
from pathlib import Path
from typing import Annotated, BinaryIO

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import Response, StreamingResponse
from pydantic import TypeAdapter, ValidationError

from backend import (
    auth_store,
    config,
    coverage,
    db,
    events,
    library,
    regeneration,
    song_projection,
    source_identity,
)
from backend.models import JobDTO, JobRecord, JobStatus, job_progress, job_to_dto
from backend.routes import admin_cache
from backend.routes.auth import cookie_name
from backend.routes.results import _tracked_thread
from backend.session import get_session_id
from separator.options import SeparationOptions, parse_mixes

router = APIRouter(tags=["jobs"])
_FORM_FIELDS = {"url", "file", *(field.name for field in fields(SeparationOptions))}


async def _to_dto(job: JobRecord) -> JobDTO:
    position = (
        await asyncio.to_thread(db.queue_position, job.id)
        if job.status == JobStatus.QUEUED
        else None
    )
    song_id = await asyncio.to_thread(library.song_for_work, job.id, job.session_id)
    return job_to_dto(job, position, song_id)


@router.post("/jobs")
async def submit_job(
    request: Request,
    session_id: Annotated[str, Depends(get_session_id)],
    url: Annotated[str | None, Form()] = None,
    file: Annotated[UploadFile | None, File()] = None,
    extract_vocals: Annotated[bool, Form()] = False,
    extract_instruments: Annotated[bool, Form()] = False,
    extract_lyrics: Annotated[bool, Form()] = False,
    detect_pitch: Annotated[bool, Form()] = False,
    extract_pitched_lyrics: Annotated[bool, Form()] = False,
    mixes: Annotated[str, Form()] = "[]",
    decrowd: Annotated[bool, Form()] = False,
    decrowd_vocals: Annotated[bool, Form()] = False,
    dereverb: Annotated[bool, Form()] = False,
    genders: Annotated[bool, Form()] = False,
    lead_backing: Annotated[bool, Form()] = False,
    drums: Annotated[bool, Form()] = False,
    pitch_semitones: Annotated[float, Form(allow_inf_nan=False)] = 0.0,
    tempo_percent: Annotated[float, Form(gt=0, allow_inf_nan=False)] = 100.0,
) -> dict:
    if set(await request.form()) - _FORM_FIELDS:
        raise HTTPException(422, "unsupported form field")
    has_url = bool(url and url.strip())
    has_file = file is not None and bool(file.filename)
    if has_url == has_file:
        raise HTTPException(400, "provide exactly one of url or file")

    try:
        mix_specs = parse_mixes(json.loads(mixes))
    except (ValueError, TypeError) as exc:
        raise HTTPException(422, str(exc)) from exc

    options = SeparationOptions(
        extract_vocals=extract_vocals,
        extract_instruments=extract_instruments,
        extract_lyrics=extract_lyrics,
        detect_pitch=detect_pitch,
        extract_pitched_lyrics=extract_pitched_lyrics,
        mixes=mix_specs,
        decrowd=decrowd,
        decrowd_vocals=decrowd_vocals,
        dereverb=dereverb,
        genders=genders,
        lead_backing=lead_backing,
        drums=drums,
        pitch_semitones=pitch_semitones,
        tempo_percent=tempo_percent,
    )
    return await _submit_work(request, session_id, options, url=url, file=file)


def _read_song_original(
    source_id: int, source_type: str
) -> tuple[BinaryIO, str, str, bytes | None]:
    # Ownership transfers to _submit_work, which closes it after installation.
    staged = tempfile.TemporaryFile(dir=config.DATA_DIR)  # noqa: SIM115
    try:
        with source_identity.open_source(source_id) as source:
            if source is None:
                raise ValueError("Original source unavailable")
            hasher = hashlib.sha256()
            with os.fdopen(os.dup(source.descriptor), "rb") as stream:
                stream.seek(0)
                while block := stream.read(1024 * 1024):
                    hasher.update(block)
                    staged.write(block)
            if not source.valid() or hasher.hexdigest() != source.digest:
                raise ValueError("Original source changed")
            filename, digest = source.name, source.digest
        metadata = None
        if source_type == "url":
            path = config.DATA_DIR / "source-metadata" / f"{source_id}.json"
            try:
                descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            except FileNotFoundError:
                pass
            else:
                with os.fdopen(descriptor, "rb") as stream:
                    if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                        raise ValueError("Unsafe source metadata")
                    metadata = stream.read()
        staged.seek(0)
        return staged, filename, digest, metadata
    except BaseException:
        staged.close()
        raise


def _hash_upload(stream: BinaryIO) -> str:
    stream.seek(0)
    hasher = hashlib.sha256()
    while block := stream.read(1024 * 1024):
        hasher.update(block)
    stream.seek(0)
    return hasher.hexdigest()


async def _submit_work(
    request: Request,
    session_id: str,
    options: SeparationOptions,
    *,
    url: str | None = None,
    file: UploadFile | None = None,
    target_song_id: int | None = None,
) -> dict:
    has_file = file is not None and bool(file.filename)

    snapshot = None
    metadata = None
    song = None
    if target_song_id is not None:
        song = await asyncio.to_thread(
            song_projection.detail, session_id, target_song_id
        )
        if song is None:
            raise HTTPException(404, "song not found")
        source_id = song.summary.original_work_id
        if source_id is None:
            raise HTTPException(409, "Original source unavailable")
        source_job = await asyncio.to_thread(db.get_job, source_id)
        if source_job is None:
            raise HTTPException(409, "Original source unavailable")
        access = request.state.job_access
        if not access.begin_read(source_id):
            raise HTTPException(409, "Original source is being deleted")
        try:
            upload_stream, filename, source_digest, metadata = await _tracked_thread(
                _read_song_original, source_id, source_job.source_type
            )
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc
        finally:
            access.end_read(source_id)
        source_type, source_value = source_job.source_type, source_job.source_value
        snapshot = db.InputSnapshot(
            source_id, f"library:{target_song_id}", filename, source_digest
        )
    elif has_file:
        assert file is not None and file.filename is not None
        source_type, source_value = "upload", file.filename
        if Path(source_value).name != source_value or source_value in {".", ".."}:
            raise HTTPException(400, "invalid upload filename")
        filename = source_value
        upload_stream = file.file
        source_digest = await _tracked_thread(_hash_upload, upload_stream)
    else:
        assert url is not None
        source_type, source_value = "url", url.strip()
        upload_stream = None
        source_digest = None
        filename = ""
    if song is None:
        existing = await asyncio.to_thread(
            library.find_song, session_id, source_type, source_value, source_digest
        )
        if existing is not None:
            song = await asyncio.to_thread(song_projection.detail, session_id, existing)
    required_options = (
        coverage.enrich_options(options, song) if song is not None else options
    )
    created_dir = None
    created_metadata = None

    def install(work_id: int) -> None:
        nonlocal created_dir, created_metadata
        if upload_stream is not None:
            config.UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
            directory = config.UPLOADS_DIR / str(work_id)
            directory.mkdir()
            created_dir = directory
            upload_stream.seek(0)
            with (directory / filename).open("xb") as destination:
                shutil.copyfileobj(upload_stream, destination, length=1024 * 1024)
        if metadata is not None:
            root = config.DATA_DIR / "source-metadata"
            root.mkdir(parents=True, exist_ok=True)
            path = root / f"{work_id}.json"
            with path.open("xb") as stream:
                created_metadata = path
                stream.write(metadata)

    def insert() -> db.SubmittedWork:
        try:
            return db.insert_job(
                session_id,
                source_type,
                source_value,
                options,
                source_digest=source_digest,
                song_id=target_song_id,
                deduplicate=True,
                install=install,
                snapshot=snapshot,
                required_coverage=coverage.known_signatures(required_options),
            )
        except BaseException:
            if created_dir is not None:
                shutil.rmtree(created_dir, ignore_errors=True)
            if created_metadata is not None:
                created_metadata.unlink(missing_ok=True)
            raise

    try:
        submitted = await _tracked_thread(insert)
    except ValueError as exc:
        raise HTTPException(
            404 if str(exc) == "Song not found" else 429, str(exc)
        ) from None
    finally:
        if target_song_id is not None and upload_stream is not None:
            upload_stream.close()

    if submitted.work_id is None:
        return {
            "song_id": submitted.song_id,
            "work_id": None,
            "status": JobStatus.DONE,
            "position": None,
            "progress": None,
        }
    job_id = submitted.work_id
    job = await asyncio.to_thread(db.get_job, job_id)
    song_id = await asyncio.to_thread(library.song_for_work, job_id, session_id)
    assert job is not None and song_id is not None
    position = await asyncio.to_thread(db.queue_position, job_id)
    return {
        "song_id": song_id,
        "work_id": job_id,
        "status": job.status,
        "position": position if job.status == JobStatus.QUEUED else None,
        "progress": job_progress(options),
    }


@router.post("/songs/{song_id}/work")
async def submit_song_work(
    song_id: int, request: Request, session_id: Annotated[str, Depends(get_session_id)]
) -> dict:
    form = await request.form()
    if set(form) - (_FORM_FIELDS - {"url", "file"}):
        raise HTTPException(422, "unsupported form field")
    values: dict[str, object] = {}
    try:
        for field in fields(SeparationOptions):
            if field.name not in form:
                continue
            value = form[field.name]
            if field.name == "mixes":
                values[field.name] = parse_mixes(json.loads(str(value)))
            elif field.name in {"pitch_semitones", "tempo_percent"}:
                values[field.name] = TypeAdapter(float).validate_python(value)
            else:
                values[field.name] = TypeAdapter(bool).validate_python(value)
        options = TypeAdapter(SeparationOptions).validate_python(values)
    except (ValueError, ValidationError) as exc:
        raise HTTPException(422, str(exc)) from None
    return await _submit_work(request, session_id, options, target_song_id=song_id)


@router.post("/jobs/{job_id}/retry")
async def retry_job(
    job_id: int, request: Request, session_id: Annotated[str, Depends(get_session_id)]
) -> dict:
    job = await asyncio.to_thread(db.get_job, job_id)
    if job is None or job.session_id != session_id:
        raise HTTPException(404, "job not found")

    origin = await asyncio.to_thread(db.regeneration_origin, job.id)
    if origin is not None and not origin[0].startswith("library:"):
        try:
            entry = await admin_cache._under_gate(
                regeneration.retry, job.id, session_id
            )
        except ValueError as exc:
            status = 429 if str(exc) == "Queue limit reached" else 409
            raise HTTPException(status, str(exc)) from None
        song_id = await asyncio.to_thread(
            library.song_for_work, entry["job_id"], session_id
        )
        return {
            "song_id": song_id,
            "work_id": entry["job_id"],
            "status": entry["status"],
            "position": entry["position"],
            "progress": job_progress(job.options),
        }

    song_id = await asyncio.to_thread(library.song_for_work, job.id, session_id)
    if song_id is None:
        raise HTTPException(404, "song not found")
    song = await asyncio.to_thread(song_projection.detail, session_id, song_id)
    if (
        song is not None
        and song.summary.original_work_id is None
        and job.source_type == "url"
    ):
        return await _submit_work(
            request, session_id, job.options, url=job.source_value
        )
    return await _submit_work(request, session_id, job.options, target_song_id=song_id)


@router.get("/jobs/{job_id}")
async def get_job(
    job_id: int, session_id: Annotated[str, Depends(get_session_id)]
) -> JobDTO:
    job = await asyncio.to_thread(db.get_job, job_id)
    if job is None or job.session_id != session_id:
        raise HTTPException(404, "job not found")
    return await _to_dto(job)


def _remove_job_files(job_id: int, *, validate_only: bool = False) -> None:
    directories = [
        root / str(job_id) for root in (config.UPLOADS_DIR, config.RESULTS_DIR)
    ]
    metadata_root = config.DATA_DIR / "source-metadata"
    metadata = metadata_root / f"{job_id}.json"

    def check(path, expected) -> bool:
        try:
            mode = path.lstat().st_mode
        except FileNotFoundError:
            return False
        if not expected(mode):
            raise ValueError("Unsafe job path")
        return True

    def walk_error(error: OSError) -> None:
        raise error

    for directory in directories:
        if not check(directory.parent, stat.S_ISDIR) or not check(
            directory, stat.S_ISDIR
        ):
            continue
        for current, dirs, files in os.walk(
            directory, followlinks=False, onerror=walk_error
        ):
            for name in dirs:
                if not check(Path(current) / name, stat.S_ISDIR):
                    raise ValueError("Job path changed")
            for name in files:
                if not check(Path(current) / name, stat.S_ISREG):
                    raise ValueError("Job path changed")
    if check(metadata_root, stat.S_ISDIR):
        check(metadata, stat.S_ISREG)
    if validate_only:
        return
    for directory in directories:
        with contextlib.suppress(FileNotFoundError):
            shutil.rmtree(directory)
    metadata.unlink(missing_ok=True)


def _remove_maintenance_files(work: list[db.StageOwner]) -> list[int]:
    """Retain dispatch owners and any files still needed for reconciliation."""
    removed = []
    for work_id, key, call_id in work:
        with contextlib.ExitStack() as stack:
            if key is not None or call_id is not None:
                if (
                    key is None
                    or call_id is None
                    or not admin_cache._KEY.fullmatch(key)
                ):
                    continue
                try:
                    lock_path = (
                        config.DATA_DIR / "artifacts" / "inference" / f"{key}.lock"
                    )
                    fd = os.open(
                        lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600
                    )
                    handle = stack.enter_context(os.fdopen(fd, "r+b"))
                    fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    stack.callback(fcntl.flock, handle, fcntl.LOCK_UN)
                    files = admin_cache.Files(stack)
                    admin_cache._ledger(files, [(work_id, key, call_id)], only_key=key)[
                        key
                    ]
                except (admin_cache.CacheConflict, OSError, KeyError):
                    continue
            _remove_job_files(work_id)
            removed.append(work_id)
    return removed


def _delete_song(song_id: int, session_id: str, ids: list[int]) -> None:
    jobs = [db.get_job(job_id) for job_id in ids]
    if any(job is None or job.session_id != session_id for job in jobs):
        raise HTTPException(404, "Song not found")
    expected = [
        (job.id, job.active_stage_key, job.modal_call_id) for job in jobs if job
    ]
    try:
        with contextlib.ExitStack() as stack:
            files = admin_cache.Files(stack)
            for job_id, key, call_id in expected:
                if (key is None) != (call_id is None):
                    raise admin_cache.CacheConflict("Inference ownership is unresolved")
                if key is None:
                    continue
                if not admin_cache._KEY.fullmatch(key) or not call_id:
                    raise admin_cache.CacheConflict("Inference ownership is unresolved")
                lock_path = config.DATA_DIR / "artifacts" / "inference" / f"{key}.lock"
                lock_path.parent.mkdir(parents=True, exist_ok=True)
                fd = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
                handle = stack.enter_context(os.fdopen(fd, "r+b"))
                try:
                    fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    raise admin_cache.CacheConflict(
                        "Inference stage is in use"
                    ) from None
                stack.callback(fcntl.flock, handle, fcntl.LOCK_UN)
                entry = admin_cache._ledger(
                    files, [(job_id, key, call_id)], only_key=key
                )[key]
                if entry.artifact is None:
                    raise admin_cache.CacheConflict("Inference did not complete")

            def remove_owned(
                work: list[db.StageOwner], owned_ids: list[int]
            ) -> list[int]:
                for work_id in owned_ids:
                    _remove_job_files(work_id, validate_only=True)
                removed = _remove_maintenance_files(work)
                for work_id in owned_ids:
                    _remove_job_files(work_id)
                return removed

            deleted = db.delete_song(song_id, session_id, expected, remove_owned)
    except (admin_cache.CacheConflict, FileNotFoundError, KeyError) as exc:
        raise HTTPException(409, "Inference ownership is unresolved") from exc
    except ValueError as exc:
        raise HTTPException(
            409, "Song state or file paths are unsafe for deletion"
        ) from exc
    except OSError as exc:
        raise HTTPException(
            503, "Song deletion failed; some files may already have been removed"
        ) from exc
    if not deleted:
        raise HTTPException(404, "Song not found")


@router.delete("/songs/{song_id}", status_code=204)
async def delete_song(
    song_id: int, request: Request, session_id: Annotated[str, Depends(get_session_id)]
) -> Response:
    ids = await asyncio.to_thread(library.song_work_ids, session_id, song_id)
    if ids is None:
        raise HTTPException(404, "Song not found")
    access = request.state.job_access
    acquired = []
    try:
        for job_id in ids:
            if not access.begin_delete(job_id):
                raise HTTPException(409, "A song file is currently in use")
            acquired.append(job_id)
        await admin_cache._under_gate(_delete_song, song_id, session_id, ids)
        return Response(status_code=204)
    finally:
        for job_id in acquired:
            access.end_delete(job_id)


_SSE_HEARTBEAT_INTERVAL = 15


@router.get("/jobs/{job_id}/events")
async def job_events(
    job_id: int, request: Request, session_id: Annotated[str, Depends(get_session_id)]
) -> StreamingResponse:
    job = await asyncio.to_thread(db.get_job, job_id)
    if job is None or job.session_id != session_id:
        raise HTTPException(404, "job not found")

    async def stream():
        queue = events.subscribe(job_id)
        try:
            current = await asyncio.to_thread(db.get_job, job_id)
            if current is None:
                return
            initial = (await _to_dto(current)).model_dump(mode="json")
            yield f"data: {json.dumps(initial)}\n\n"
            if initial["status"] in (JobStatus.DONE, JobStatus.FAILED):
                return

            while True:
                token = request.cookies.get(cookie_name(), "")
                if await asyncio.to_thread(auth_store.authenticate, token) is None:
                    return
                try:
                    payload = await asyncio.wait_for(
                        queue.get(), timeout=_SSE_HEARTBEAT_INTERVAL
                    )
                except TimeoutError:
                    yield ": keep-alive\n\n"
                    continue
                if await asyncio.to_thread(auth_store.authenticate, token) is None:
                    return
                yield f"data: {json.dumps(payload)}\n\n"
                if payload["status"] in (JobStatus.DONE, JobStatus.FAILED):
                    return
        finally:
            events.unsubscribe(job_id, queue)

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )
