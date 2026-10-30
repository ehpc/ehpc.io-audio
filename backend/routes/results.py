import asyncio
from typing import Annotated
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse, Response

from backend import config, db
from backend.metadata import ensure_download_title
from backend.models import (
    JobRecord,
    JobStatus,
    TranscriptDTO,
    download_filename,
    lyrics_filename,
    original_filename,
)
from backend.session import get_session_id
from separator.lyrics import transcript_text

router = APIRouter(tags=["results"])


@router.get("/jobs/{job_id}/original")
async def get_original(
    job_id: int, session_id: Annotated[str, Depends(get_session_id)]
) -> FileResponse:
    job = await asyncio.to_thread(db.get_job, job_id)
    if job is None or job.session_id != session_id:
        raise HTTPException(404, "job not found")

    src_dir = config.UPLOADS_DIR / str(job_id)
    files = sorted(src_dir.glob("*")) if src_dir.is_dir() else []
    if not files:
        raise HTTPException(404, "original not available")

    path = files[0]
    return FileResponse(
        path, filename=original_filename(job.title, job_id, path.suffix)
    )


@router.get("/jobs/{job_id}/results/{label}")
async def get_result(
    job_id: int, label: str, session_id: Annotated[str, Depends(get_session_id)]
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
    return TranscriptDTO.from_transcript(job.transcript)


@router.get("/jobs/{job_id}/lyrics/download")
async def download_lyrics(
    job_id: int, session_id: Annotated[str, Depends(get_session_id)]
) -> Response:
    job = await _lyrics_job(job_id, session_id)
    assert job.transcript is not None
    name = quote(lyrics_filename(job.title, job_id))
    return Response(
        transcript_text(job.transcript.segments, job.transcript.sections),
        media_type="text/plain; charset=utf-8",
        headers={"Content-Disposition": f"attachment; filename*=utf-8''{name}"},
    )
