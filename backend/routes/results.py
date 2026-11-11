import asyncio
import contextlib
import hashlib
import os
import stat
from pathlib import Path
from typing import Annotated, Literal
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse, Response

from backend import config, db, drain
from backend.cache_catalog import capture
from backend.inference import recover_vocals
from backend.metadata import ensure_download_title
from backend.models import (
    JobRecord,
    JobStatus,
    TranscriptDTO,
    download_filename,
    header_title,
    lyrics_filename,
    original_filename,
    pitch_vocals_path,
    pitched_lyrics_available,
    pitched_lyrics_filename,
)
from backend.pitch_reference import persist_pitch_vocals
from backend.playback import listening_path
from backend.session import get_session_id
from separator.artifact_cache import async_locked
from separator.audio import transposed_key
from separator.lyrics import transcript_export_text
from separator.pitch import pitch_from_json, pitch_to_json
from separator.pitched_lyrics import pitched_lyrics_document, pitched_lyrics_text
from separator.pitched_lyrics_odt import MIME_TYPE, pitched_lyrics_odt

router = APIRouter(tags=["results"])


def _source_identity(job: JobRecord):
    """Hash the sole original without following links or loading it into memory."""
    try:
        with contextlib.ExitStack() as stack:
            flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
            root = os.open(config.UPLOADS_DIR, flags)
            stack.callback(os.close, root)
            directory = os.open(str(job.id), flags, dir_fd=root)
            stack.callback(os.close, directory)
            with os.scandir(directory) as entries:
                names = [entry.name for entry in entries]
            if len(names) != 1:
                return None
            descriptor = os.open(
                names[0], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory
            )
            stream = stack.enter_context(os.fdopen(descriptor, "rb"))
            if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                return None
            return hashlib.file_digest(stream, "sha256").hexdigest(), names[0]
    except OSError:
        return None


def _with_source(job: JobRecord, function, *args):
    with capture() as recorder:
        identity = _source_identity(job)
        if identity is not None:
            digest, filename = identity
            recorder.bind_digest(digest, job.title or Path(filename).stem)
        return function(*args)


async def _tracked_thread(function, *args):
    task = asyncio.create_task(asyncio.to_thread(function, *args))
    drain.state.track(task)
    return await asyncio.shield(task)


async def _listening_response(
    job: JobRecord, path: Path, media_type: str | None = None
) -> FileResponse:
    try:
        indexed = await _tracked_thread(
            _with_source,
            job,
            listening_path,
            path,
            config.DATA_DIR / "artifacts" / "playback",
        )
    except (OSError, RuntimeError, ValueError) as exc:
        raise HTTPException(
            503,
            "Listening audio could not be prepared. "
            "The original download is unchanged.",
        ) from exc
    return FileResponse(
        indexed or path,
        media_type="audio/mp4" if indexed is not None else media_type,
        headers={"Content-Disposition": "inline", "Cache-Control": "private"},
    )


@router.get("/jobs/{job_id}/original")
@router.head("/jobs/{job_id}/original", include_in_schema=False)
async def get_original(
    job_id: int,
    session_id: Annotated[str, Depends(get_session_id)],
    playback: bool = False,
) -> FileResponse:
    job = await asyncio.to_thread(db.get_job, job_id)
    if job is None or job.session_id != session_id:
        raise HTTPException(404, "job not found")

    src_dir = config.UPLOADS_DIR / str(job_id)
    files = sorted(src_dir.glob("*")) if src_dir.is_dir() else []
    if not files:
        raise HTTPException(404, "original not available")

    path = files[0]
    if not path.is_file():
        raise HTTPException(404, "original not available")
    if playback:
        return await _listening_response(job, path)
    return FileResponse(
        path, filename=original_filename(job.title, job_id, path.suffix)
    )


@router.get("/jobs/{job_id}/pitch-reference/vocals")
@router.head("/jobs/{job_id}/pitch-reference/vocals", include_in_schema=False)
async def get_pitch_vocals(
    job_id: int,
    session_id: Annotated[str, Depends(get_session_id)],
    playback: bool = False,
) -> FileResponse:
    job = await asyncio.to_thread(db.get_job, job_id)
    if job is None or job.session_id != session_id:
        raise HTTPException(404, "pitch reference not found")
    path = pitch_vocals_path(job)
    if path is None:
        raise HTTPException(404, "pitch reference not found")
    if playback:
        return await _listening_response(job, path, "audio/mpeg")
    return FileResponse(path, media_type="audio/mpeg")


@router.post("/jobs/{job_id}/pitch-reference/vocals", status_code=204)
async def recover_pitch_vocals(
    job_id: int, session_id: Annotated[str, Depends(get_session_id)]
) -> Response:
    job = await asyncio.to_thread(db.get_job, job_id)
    if (
        job is None
        or job.session_id != session_id
        or job.status != JobStatus.DONE
        or job.pitch_json is None
    ):
        raise HTTPException(404, "pitch reference not found")
    async with async_locked(config.RESULTS_DIR / str(job.id) / ".pitch-vocals.lock"):
        if pitch_vocals_path(job) is not None:
            return Response(status_code=204)
        source_dir = config.UPLOADS_DIR / str(job.id)
        sources = sorted(path for path in source_dir.glob("*") if path.is_file())
        if not sources:
            raise HTTPException(
                404, "Original audio is unavailable; cached vocals cannot be recovered."
            )
        source = await asyncio.to_thread(sources[0].read_bytes)
        try:
            vocals = await _tracked_thread(_with_source, job, recover_vocals, source)
        except Exception as exc:
            raise HTTPException(
                503, "Vocal cache lookup is unavailable. Please try again later."
            ) from exc
        if not vocals:
            raise HTTPException(
                404,
                "No full vocals match this original and the current model/cache "
                "identity. The cache may be missing or from an older model. "
                "Run pitch detection again to create a reference.",
            )
        await _tracked_thread(_with_source, job, persist_pitch_vocals, job, vocals)
    return Response(status_code=204)


@router.get("/jobs/{job_id}/results/{label}")
@router.head("/jobs/{job_id}/results/{label}", include_in_schema=False)
async def get_result(
    job_id: int,
    label: str,
    session_id: Annotated[str, Depends(get_session_id)],
    playback: bool = False,
) -> FileResponse:
    job = await asyncio.to_thread(db.get_job, job_id)
    if (
        job is None
        or job.session_id != session_id
        or job.status != JobStatus.DONE
        or job.result_manifest is None
    ):
        raise HTTPException(404, "result not found")

    entry = next((e for e in job.result_manifest if e.label == label), None)
    if entry is None:
        raise HTTPException(404, "result not found")

    path = config.RESULTS_DIR / str(job_id) / entry.filename
    if not path.is_file():
        raise HTTPException(404, "result not found")
    if playback:
        return await _listening_response(job, path, "audio/mpeg")
    download_name = download_filename(
        job.title, job_id, label, job.options, job.original_key
    )
    # Old persisted results predate canonical titles (and source-key filenames).
    # Reconcile tags without re-encoding, and skip writes once they match.
    size_bytes = await asyncio.to_thread(ensure_download_title, path, download_name)
    if entry.size_bytes != size_bytes:
        await asyncio.to_thread(db.update_result_size, job_id, label, size_bytes)
    return FileResponse(
        path,
        media_type="audio/mpeg",
        filename=download_name,
    )


async def _lyrics_job(job_id: int, session_id: str) -> JobRecord:
    job = await asyncio.to_thread(db.get_job, job_id)
    if (
        job is None
        or job.session_id != session_id
        or job.status != JobStatus.DONE
        or job.transcript is None
    ):
        raise HTTPException(404, "lyrics not found")
    return job


@router.get("/jobs/{job_id}/lyrics")
async def get_lyrics(
    job_id: int, session_id: Annotated[str, Depends(get_session_id)]
) -> TranscriptDTO:
    job = await _lyrics_job(job_id, session_id)
    assert job.transcript is not None
    return TranscriptDTO.from_transcript(job.transcript, title=header_title(job.title))


@router.get("/jobs/{job_id}/lyrics/download")
async def download_lyrics(
    job_id: int, session_id: Annotated[str, Depends(get_session_id)]
) -> Response:
    job = await _lyrics_job(job_id, session_id)
    assert job.transcript is not None
    name = quote(lyrics_filename(job.title, job_id))
    return Response(
        transcript_export_text(job.transcript, title=header_title(job.title)),
        media_type="text/plain; charset=utf-8",
        headers={"Content-Disposition": f"attachment; filename*=utf-8''{name}"},
    )


@router.get("/jobs/{job_id}/lyrics/download.json")
async def download_lyrics_json(
    job_id: int, session_id: Annotated[str, Depends(get_session_id)]
) -> Response:
    job = await _lyrics_job(job_id, session_id)
    assert job.transcript is not None
    name = quote(lyrics_filename(job.title, job_id).removesuffix(".txt") + ".json")
    return Response(
        TranscriptDTO.from_transcript(
            job.transcript, title=header_title(job.title)
        ).model_dump_json(),
        media_type="application/json",
        headers={"Content-Disposition": f"attachment; filename*=utf-8''{name}"},
    )


@router.get("/jobs/{job_id}/pitch")
async def get_pitch(
    job_id: int, session_id: Annotated[str, Depends(get_session_id)]
) -> Response:
    job = await asyncio.to_thread(db.get_job, job_id)
    if (
        job is None
        or job.session_id != session_id
        or job.status != JobStatus.DONE
        or job.pitch_json is None
    ):
        raise HTTPException(404, "pitch analysis not found")
    # The same canonical payload backs the browser, history, and JSON download.
    content = pitch_to_json(pitch_from_json(job.pitch_json))
    name = quote(
        lyrics_filename(job.title, job_id).removesuffix("lyrics.txt") + "pitch.json"
    )
    return Response(
        content,
        media_type="application/json",
        headers={"Content-Disposition": f"attachment; filename*=utf-8''{name}"},
    )


@router.get("/jobs/{job_id}/pitched-lyrics/{label}/download")
async def download_pitched_lyrics(
    job_id: int,
    label: str,
    session_id: Annotated[str, Depends(get_session_id)],
    format: Literal["txt", "odt"] = "txt",
) -> Response:
    job = await _lyrics_job(job_id, session_id)
    if not pitched_lyrics_available(job) or job.pitch_json is None:
        raise HTTPException(404, "pitched lyrics not found")
    analysis = pitch_from_json(job.pitch_json)
    track = next((item for item in analysis.tracks if item.label == label), None)
    if track is None:
        raise HTTPException(404, "pitched lyrics not found")
    assert job.transcript is not None
    filename = pitched_lyrics_filename(job.title, job_id, label, job.options)
    options = {
        "title": header_title(job.title),
        "output_key": transposed_key(job.original_key, job.options.pitch_semitones),
    }
    if format == "odt":
        content = pitched_lyrics_odt(
            pitched_lyrics_document(job.transcript, analysis, track, **options)
        )
        filename = filename.removesuffix(".txt") + ".odt"
        media_type = MIME_TYPE
    else:
        content = pitched_lyrics_text(job.transcript, analysis, track, **options)
        media_type = "text/plain; charset=utf-8"
    name = quote(filename)
    return Response(
        content,
        media_type=media_type,
        headers={"Content-Disposition": f"attachment; filename*=utf-8''{name}"},
    )
