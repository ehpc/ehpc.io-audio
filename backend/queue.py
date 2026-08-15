import asyncio
import contextlib
import logging
from collections.abc import AsyncIterator
from pathlib import Path
from typing import TYPE_CHECKING

from fastapi import FastAPI

from backend import config, db, events, modal_client
from backend.models import JobRecord, JobStatus, ResultManifestEntry, job_to_dto
from separator.download import download_mp3

if TYPE_CHECKING:
    from separator.stems import SeparationResult

log = logging.getLogger(__name__)

_claim_lock = asyncio.Lock()


async def _publish_status(job_id: int) -> None:
    job = await asyncio.to_thread(db.get_job, job_id)
    if job is None:
        return
    position = (
        await asyncio.to_thread(db.queue_position, job_id)
        if job.status == JobStatus.QUEUED
        else None
    )
    events.publish(job_id, job_to_dto(job, position).model_dump(mode="json"))


def _load_source_bytes(job: JobRecord) -> tuple[bytes, str]:
    if job.source_type == "upload":
        path = config.UPLOADS_DIR / str(job.id) / job.source_value
        return path.read_bytes(), job.source_value
    # Download into the job's dir (not a temp dir) so the original persists and
    # stays downloadable from history, matching how uploads are kept.
    dest = config.UPLOADS_DIR / str(job.id)
    dest.mkdir(parents=True, exist_ok=True)
    return download_mp3(
        job.source_value,
        str(dest),
        max_attempts=config.DOWNLOAD_MAX_ATTEMPTS,
        backoff_s=config.DOWNLOAD_RETRY_BACKOFF_S,
    )


def _persist_results(
    job_id: int, result: "SeparationResult"
) -> list[ResultManifestEntry]:
    out_dir = config.RESULTS_DIR / str(job_id)
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest = []
    for label, stem_result in result.items():
        filename = f"{label}.mp3"
        (out_dir / filename).write_bytes(stem_result.data)
        manifest.append(
            ResultManifestEntry(
                label=label,
                filename=filename,
                size_bytes=len(stem_result.data),
                duration_s=stem_result.duration_s,
            )
        )
    return manifest


async def _run_job(job: JobRecord) -> None:
    await _publish_status(job.id)
    try:
        audio_bytes, filename = await asyncio.to_thread(_load_source_bytes, job)
        # For URL jobs the downloaded filename is the track title (yt-dlp names the
        # file after it); surface it so history reads nicer than a raw URL.
        if job.source_type == "url":
            await asyncio.to_thread(db.set_title, job.id, Path(filename).stem)
        call = await asyncio.to_thread(
            modal_client.spawn, audio_bytes, filename, job.options
        )
        await asyncio.to_thread(db.set_modal_call_id, job.id, call.object_id)

        result = None
        while result is None:
            result = await asyncio.to_thread(
                modal_client.poll, call, config.MODAL_CALL_POLL_TIMEOUT_S
            )

        manifest = await asyncio.to_thread(_persist_results, job.id, result)
        await asyncio.to_thread(db.mark_done, job.id, manifest)
    except Exception as exc:
        log.exception("job %s failed", job.id)
        message = str(exc).strip() or "Separation failed. Please try again."
        await asyncio.to_thread(db.mark_failed, job.id, message[:500])
    finally:
        await _publish_status(job.id)


async def _claim_next_job() -> JobRecord | None:
    async with _claim_lock:
        return await asyncio.to_thread(db.claim_oldest_queued)


async def _worker_loop(worker_id: int) -> None:
    log.info("queue worker %d started", worker_id)
    while True:
        job = await _claim_next_job()
        if job is None:
            await asyncio.sleep(config.QUEUE_POLL_INTERVAL_S)
            continue
        await _run_job(job)


@contextlib.asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    await asyncio.to_thread(db.init_db)
    await asyncio.to_thread(db.reap_running_to_queued)
    tasks = [
        asyncio.create_task(_worker_loop(i)) for i in range(config.QUEUE_CONCURRENCY)
    ]
    try:
        yield
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
