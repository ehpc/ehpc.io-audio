import asyncio
import contextlib
import fcntl
import json
import os
import shutil
import stat
from dataclasses import fields
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import Response, StreamingResponse

from backend import auth_store, config, db, events
from backend.models import JobDTO, JobRecord, JobStatus, job_to_dto
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
    return job_to_dto(job, position)


async def _save_upload(job_id: int, filename: str, data: bytes) -> None:
    upload_dir = config.UPLOADS_DIR / str(job_id)
    await asyncio.to_thread(upload_dir.mkdir, parents=True, exist_ok=True)
    await asyncio.to_thread((upload_dir / filename).write_bytes, data)


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

    if has_file:
        assert file is not None and file.filename is not None
        source_type, source_value = "upload", file.filename
        upload_bytes = await file.read()
    else:
        assert url is not None
        source_type, source_value = "url", url.strip()
        upload_bytes = None

    try:
        job_id = await asyncio.to_thread(
            db.insert_job, session_id, source_type, source_value, options
        )
    except ValueError as exc:
        raise HTTPException(429, str(exc)) from None

    if upload_bytes is not None:
        await _save_upload(job_id, source_value, upload_bytes)

    position = await asyncio.to_thread(db.queue_position, job_id)
    return {"id": job_id, "status": JobStatus.QUEUED, "position": position}


@router.post("/jobs/{job_id}/retry")
async def retry_job(
    job_id: int, session_id: Annotated[str, Depends(get_session_id)]
) -> dict:
    job = await asyncio.to_thread(db.get_job, job_id)
    if job is None or job.session_id != session_id:
        raise HTTPException(404, "job not found")

    try:
        new_job_id = await asyncio.to_thread(
            db.insert_job, session_id, job.source_type, job.source_value, job.options
        )
    except ValueError as exc:
        raise HTTPException(429, str(exc)) from None

    if job.source_type == "upload":
        src = config.UPLOADS_DIR / str(job.id) / job.source_value
        data = await _tracked_thread(src.read_bytes)
        await _save_upload(new_job_id, job.source_value, data)

    position = await asyncio.to_thread(db.queue_position, new_job_id)
    return {"id": new_job_id, "status": JobStatus.QUEUED, "position": position}


@router.get("/jobs")
async def list_jobs(
    session_id: Annotated[str, Depends(get_session_id)],
) -> list[JobDTO]:
    jobs = await asyncio.to_thread(db.list_jobs_for_session, session_id)
    return [await _to_dto(job) for job in jobs]


@router.get("/jobs/current")
async def get_current_job(session_id: Annotated[str, Depends(get_session_id)]):
    job = await asyncio.to_thread(db.get_latest_job_for_session, session_id)
    return await _to_dto(job) if job is not None else None


@router.get("/jobs/{job_id}")
async def get_job(
    job_id: int, session_id: Annotated[str, Depends(get_session_id)]
) -> JobDTO:
    job = await asyncio.to_thread(db.get_job, job_id)
    if job is None or job.session_id != session_id:
        raise HTTPException(404, "job not found")
    return await _to_dto(job)


def _remove_job_files(job_id: int) -> None:
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
    for directory in directories:
        with contextlib.suppress(FileNotFoundError):
            shutil.rmtree(directory)
    metadata.unlink(missing_ok=True)


def _delete_job(job_id: int, session_id: str) -> None:
    job = db.get_job(job_id)
    if job is None or job.session_id != session_id:
        raise HTTPException(404, "Job not found")
    if job.status != JobStatus.DONE:
        raise HTTPException(409, "Only completed jobs can be deleted")
    key, call_id = job.active_stage_key, job.modal_call_id
    if (key is None) != (call_id is None):
        raise HTTPException(409, "Inference ownership is unresolved")
    try:
        with contextlib.ExitStack() as stack:
            if key is not None:
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
                files = admin_cache.Files(stack)
                entry = admin_cache._ledger(
                    files, [(job_id, key, call_id)], only_key=key
                )[key]
                if entry.artifact is None:
                    raise admin_cache.CacheConflict("Inference did not complete")
            deleted = db.delete_completed_job(
                job_id, session_id, (key, call_id), lambda: _remove_job_files(job_id)
            )
    except admin_cache.CacheConflict as exc:
        raise HTTPException(409, "Inference ownership is unresolved") from exc
    except FileNotFoundError as exc:
        raise HTTPException(409, "Inference ownership is unresolved") from exc
    except ValueError as exc:
        raise HTTPException(
            409, "Job state or file paths are unsafe for deletion"
        ) from exc
    except OSError as exc:
        raise HTTPException(
            503, "Job deletion failed; some files may already have been removed"
        ) from exc
    if not deleted:
        raise HTTPException(404, "Job not found")


@router.delete("/jobs/{job_id}", status_code=204)
async def delete_job(
    job_id: int, request: Request, session_id: Annotated[str, Depends(get_session_id)]
) -> Response:
    job = await asyncio.to_thread(db.get_job, job_id)
    if job is None or job.session_id != session_id:
        raise HTTPException(404, "Job not found")
    if job.status != JobStatus.DONE:
        raise HTTPException(409, "Only completed jobs can be deleted")
    access = request.state.job_access
    if not access.begin_delete(job_id):
        raise HTTPException(409, "A job file is currently in use")
    try:
        await admin_cache._under_gate(_delete_job, job_id, session_id)
        return Response(status_code=204)
    finally:
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
