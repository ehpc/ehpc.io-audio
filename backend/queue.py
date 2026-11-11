import asyncio
import contextlib
import dataclasses
import logging
import threading
from collections.abc import AsyncIterator
from pathlib import Path

from fastapi import FastAPI

from backend import config, db, drain, events, song_search_worker
from backend.cache_catalog import capture
from backend.inference import (
    UncertainInferenceDispatch,
    cleanup_completed_transfers,
    process_source,
)
from backend.metadata import ensure_download_title
from backend.modal_client import InferenceStageFailure
from backend.models import (
    JobRecord,
    JobStatus,
    ResultManifestEntry,
    download_filename,
    job_to_dto,
)
from backend.pitch_reference import persist_pitch_vocals
from backend.source_cache import cached_download
from backend.source_metadata import reference_metadata
from separator.artifact_cache import async_locked, digest
from separator.audio import detect_key, modification_suffix, transform_audio
from separator.download import download_mp3
from separator.processing import ProcessingResult
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
    metadata_path = None
    if job.options.needs_lyrics:
        metadata_path = config.DATA_DIR / "source-metadata" / f"{job.id}.json"
        metadata_path.parent.mkdir(parents=True, exist_ok=True)
    return cached_download(
        job.source_value,
        str(dest),
        max_attempts=config.DOWNLOAD_MAX_ATTEMPTS,
        backoff_s=config.DOWNLOAD_RETRY_BACKOFF_S,
        metadata_path=metadata_path,
        producer=download_mp3,
    )


def _persist_results(
    job: JobRecord, result: SeparationResult
) -> list[ResultManifestEntry]:
    out_dir = config.RESULTS_DIR / str(job.id)
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest = []
    for label, stem_result in result.items():
        audio = transform_audio(
            stem_result.data, job.options, config.DATA_DIR / "artifacts"
        )
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
                display_name=job.options.display_name(label),
                size_bytes=size_bytes,
                duration_s=stem_result.duration_s,
            )
        )
    return manifest


async def _cache_thread(function, *args):
    task = asyncio.create_task(asyncio.to_thread(function, *args))
    drain.state.track(task)
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        await asyncio.gather(task, return_exceptions=True)
        raise


async def _process(
    job: JobRecord, audio: bytes, filename: str, metadata
) -> ProcessingResult:
    stop = threading.Event()
    task = asyncio.create_task(
        asyncio.to_thread(process_source, job, audio, filename, metadata, stop)
    )
    drain.state.track(task)
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        # Stop between stages/polls, preserving an accepted remote call for
        # restart. The owning thread cleans its own temporary files first.
        stop.set()
        await asyncio.gather(task, return_exceptions=True)
        raise


async def _run_job(job: JobRecord) -> None:
    with capture() as recorder:
        await _run_job_captured(job, recorder)


async def _run_job_captured(job: JobRecord, recorder) -> None:
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
        audio_bytes, filename = await _cache_thread(_load_source_bytes, job)
        if job.source_type == "upload":
            recorder.bind(audio_bytes, job.title or Path(filename).stem)
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
        job.original_key = await _cache_thread(
            detect_key, audio_bytes, filename, config.DATA_DIR / "artifacts"
        )
        await asyncio.to_thread(db.set_original_key, job.id, job.original_key)
        await _publish_status(job.id)
        processed = ProcessingResult(audio={})
        # Coalesce identical sources on the authoritative VPS filesystem.
        # Completed stages persist before later stages or CPU exports begin.
        async with async_locked(
            config.DATA_DIR / "artifacts" / "gpu-locks" / digest(audio_bytes)
        ):
            if (
                job.options.needs_lyrics
                or job.options.needs_pitch
                or job.options.output_labels
            ):
                metadata = None
                if job.options.needs_lyrics:
                    metadata = await asyncio.to_thread(
                        reference_metadata,
                        audio_bytes,
                        downloaded_metadata=(
                            config.DATA_DIR / "source-metadata" / f"{job.id}.json"
                            if job.source_type == "url"
                            else None
                        ),
                    )
                processed = await _process(job, audio_bytes, filename, metadata)
        if (
            job.options.output_labels
            or job.options.needs_lyrics
            or job.options.needs_pitch
        ):
            log.info(
                "job %s processing produced %d outputs: %s",
                job.id,
                len(processed.audio),
                ", ".join(processed.audio),
            )
        result = processed.audio
        if job.options.needs_lyrics and processed.transcript is None:
            raise RuntimeError("Lyrics extraction returned no transcript")
        if job.options.needs_pitch and processed.pitch_json is None:
            raise RuntimeError("Pitch detection returned no analysis")
        if "song" in job.options.result_labels:
            # Transform the complete source, not a separated/reconstructed mix.
            # Persisting applies pitch and tempo together once, as for each stem.
            result = {"song": StemResult(audio_bytes, 0.0), **result}
        manifest = await _cache_thread(_persist_results, job, result)
        if processed.pitch_vocals is not None:
            await _cache_thread(persist_pitch_vocals, job, processed.pitch_vocals)
        await asyncio.to_thread(
            db.mark_done, job.id, manifest, processed.transcript, processed.pitch_json
        )
        log.info("job %s done", job.id)
    except drain.DrainDeferred:
        log.info("job %s deferred for rollout", job.id)
        await asyncio.to_thread(db.requeue_job, job.id)
    except Exception as exc:
        if isinstance(exc, (UncertainInferenceDispatch, db.UncompletedInferenceStage)):
            drain.state.fail_drain()
        log.exception("job %s failed", job.id)
        message = str(exc).strip() or "Separation failed. Please try again."
        await asyncio.to_thread(db.mark_failed, job.id, message[:500])
        if isinstance(exc, InferenceStageFailure):
            try:
                await asyncio.to_thread(cleanup_completed_transfers)
            except Exception as cleanup_error:
                log.warning(
                    "job %s terminal transfer cleanup remains pending (%s)",
                    job.id,
                    type(cleanup_error).__name__,
                )
    finally:
        await _publish_status(job.id)


async def _claim_next_job() -> JobRecord | None:
    async with drain.state.gate:
        if drain.state.draining:
            return None
        async with _claim_lock:
            return await asyncio.to_thread(db.claim_oldest_queued)


async def _worker_loop(worker_id: int) -> None:
    log.info("queue worker %d started", worker_id)
    while not drain.state.draining:
        job = await _claim_next_job()
        if job is None:
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(
                    drain.state.changed.wait(), timeout=config.QUEUE_POLL_INTERVAL_S
                )
            continue
        await _run_job(job)


@contextlib.asynccontextmanager
async def _lifespan(app: FastAPI) -> AsyncIterator[None]:
    config.validate_auth()
    drain.state.reset()
    server = await drain.serve(start_serving=False)
    async with contextlib.AsyncExitStack() as stack:
        try:
            await asyncio.to_thread(db.init_db)
            await asyncio.to_thread(db.reap_running_to_queued)
            for i in range(config.QUEUE_CONCURRENCY):
                drain.state.workers.append(asyncio.create_task(_worker_loop(i)))
            if config.QUEUE_CONCURRENCY > 0:
                search_done = asyncio.Event()
                stop_search = await stack.enter_async_context(
                    song_search_worker.lifespan(search_done)
                )
                drain.state.search_done = search_done
                drain.state.stop_search = stop_search
            await server.start_serving()
            yield
        finally:
            try:
                await drain.state.begin()
                await drain.state.wait()
            finally:
                server.close()
                await server.wait_closed()
                drain.cleanup_socket(server)


@contextlib.asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    if not drain.state.acquire_lifespan():
        raise RuntimeError("Only one queue lifespan may run in this process")
    try:
        async with _lifespan(app):
            yield
    finally:
        drain.state.release_lifespan()
