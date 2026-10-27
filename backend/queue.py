import asyncio
import contextlib
import dataclasses
import logging
from collections.abc import AsyncIterator
from pathlib import Path

from fastapi import FastAPI

from backend import config, db, events, modal_client
from backend.metadata import ensure_download_title
from backend.models import (
    JobRecord,
    JobStatus,
    ResultManifestEntry,
    download_filename,
    job_to_dto,
)
from separator.audio import detect_key, modification_suffix, transform_audio
from separator.download import download_mp3
from separator.stems import SeparationResult, StemResult

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
    job: JobRecord, result: SeparationResult
) -> list[ResultManifestEntry]:
    out_dir = config.RESULTS_DIR / str(job.id)
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest = []
    for label, stem_result in result.items():
        audio = transform_audio(stem_result.data, job.options)
        filename = f"{label}{modification_suffix(job.options)}.mp3"
        path = out_dir / filename
        path.write_bytes(audio)
        download_name = download_filename(
            job.title, job.id, label, job.options, job.original_key
        )
        size_bytes = ensure_download_title(path, download_name)
        manifest.append(
            ResultManifestEntry(
                label=label,
                filename=filename,
                download_name=download_name,
                size_bytes=size_bytes,
                duration_s=stem_result.duration_s,
            )
        )
    return manifest


async def _run_job(job: JobRecord) -> None:
    await _publish_status(job.id)
    try:
        log.info(
            "job %s starting (source=%s value=%s options=%s)",
            job.id,
            job.source_type,
            job.source_value,
            dataclasses.asdict(job.options),
        )
        log.info("job %s loading source", job.id)
        audio_bytes, filename = await asyncio.to_thread(_load_source_bytes, job)
        log.info(
            "job %s source ready (%s, %.1f MB)",
            job.id,
            filename,
            len(audio_bytes) / 1_048_576,
        )
        # For URL jobs the downloaded filename is the track title (yt-dlp names the
        # file after it); surface it so history reads nicer than a raw URL.
        if job.source_type == "url":
            job.title = Path(filename).stem
            await asyncio.to_thread(db.set_title, job.id, job.title)
        job.original_key = await asyncio.to_thread(detect_key, audio_bytes, filename)
        await asyncio.to_thread(db.set_original_key, job.id, job.original_key)
        await _publish_status(job.id)
        result: SeparationResult = {}
        if job.options.output_labels:
            call = await asyncio.to_thread(
                modal_client.spawn, audio_bytes, filename, job.options
            )
            log.info("job %s spawned on modal (call_id=%s)", job.id, call.object_id)
            await asyncio.to_thread(db.set_modal_call_id, job.id, call.object_id)

            remote_result = None
            polls = 0
            while remote_result is None:
                polls += 1
                remote_result = await asyncio.to_thread(
                    modal_client.poll, call, config.MODAL_CALL_POLL_TIMEOUT_S
                )
                if remote_result is None:
                    log.info(
                        "job %s still running (waited %.0fs)",
                        job.id,
                        polls * config.MODAL_CALL_POLL_TIMEOUT_S,
                    )
            result = remote_result
            log.info(
                "job %s modal returned %d outputs: %s",
                job.id,
                len(result),
                ", ".join(result),
            )
        elif job.options.pitch_semitones != 0 or job.options.tempo_percent != 100:
            result = {"song": StemResult(audio_bytes, 0.0)}
        manifest = await asyncio.to_thread(_persist_results, job, result)
        await asyncio.to_thread(db.mark_done, job.id, manifest)
        log.info("job %s done", job.id)
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
