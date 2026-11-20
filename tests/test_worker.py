import asyncio
import multiprocessing
import threading
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from audio_samples import mp3_measurements, tone_wav
from inference_fixture import StemSignal, cpu_inference, fixture_manifest

from backend import config, db, events, modal_client, queue
from backend.models import JobRecord, JobStatus
from separator.artifact_cache import async_locked, digest
from separator.lyrics_reference import ReferenceMetadata
from separator.options import SeparationOptions
from separator.processing import ProcessingContext, ProcessingResult, run_processing
from separator.progress import JobPhase


@pytest.fixture(autouse=True)
def _key_analysis(monkeypatch: pytest.MonkeyPatch) -> None:
    # Key detection is independently exercised; isolate queue result publication.
    monkeypatch.setattr(queue, "detect_key", lambda audio, name, root: "C major")

    def forbidden(*args, **kwargs):
        raise AssertionError("worker consumer tests must not dispatch paid inference")

    monkeypatch.setattr(modal_client, "spawn", forbidden)


def _write_upload(job_id: int, filename: str) -> None:
    upload_dir = config.UPLOADS_DIR / str(job_id)
    upload_dir.mkdir(parents=True, exist_ok=True)
    (upload_dir / filename).write_bytes(b"audio-bytes")


def test_run_job_upload_success(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    job_id = db.insert_job(
        "s1",
        "upload",
        "song.wav",
        SeparationOptions(extract_vocals=True, extract_instruments=True),
    )
    source = tone_wav((440,), 0.6)
    upload = config.UPLOADS_DIR / str(job_id)
    upload.mkdir(parents=True)
    (upload / "song.wav").write_bytes(source)
    producer = tmp_path / "producer"
    manifest = fixture_manifest(
        producer,
        signals={"vocals": StemSignal(220, 0.6), "instruments": StemSignal(330, 0.6)},
    )
    produced = []
    calls = []

    def infer(request, key):
        calls.append(request.operation)
        return cpu_inference(request, key, root=producer)

    def process(job, audio, filename, metadata, stop, on_phase):
        assert audio == source and filename == "song.wav"
        assert not stop.is_set()
        work = tmp_path / f"work-{job.id}"
        work.mkdir()
        input_path = work / filename
        input_path.write_bytes(audio)
        context = ProcessingContext(
            tmp_path / "cache", manifest, infer, on_phase=on_phase
        )
        result = run_processing(input_path, job.options, work, context, metadata)
        produced.append(result)
        return result

    monkeypatch.setattr(queue, "process_source", process)

    job = db.claim_oldest_queued()
    assert job is not None and job.id == job_id

    async def run_with_events(job: JobRecord):
        listener = events.subscribe(job.id)
        try:
            await queue._run_job(job)
            return [listener.get_nowait() for _ in range(listener.qsize())]
        finally:
            events.unsubscribe(job.id, listener)

    updates = asyncio.run(run_with_events(job))
    assert [update["progress"]["current"] for update in updates] == [
        "source",
        "analysis",
        "analysis",
        "wait",
        "separation",
        "export",
        None,
    ]
    assert updates[-1]["status"] == JobStatus.DONE

    done = db.get_job(job_id)
    assert done is not None
    assert done.status is JobStatus.DONE
    assert done.title == "song.wav"  # an upload's title is its filename
    assert done.result_manifest is not None
    assert [entry.label for entry in done.result_manifest] == ["vocals", "instruments"]
    assert calls == ["separation", "separation"]
    assert done.original_key == "C major"
    for entry, frequency in zip(done.result_manifest, (220, 330), strict=True):
        audio = (config.RESULTS_DIR / str(job_id) / f"{entry.label}.mp3").read_bytes()
        duration, measured_frequency = mp3_measurements(audio)
        assert duration == pytest.approx(0.6, abs=0.08)
        assert measured_frequency == pytest.approx(frequency, rel=0.025)
        assert entry.size_bytes == len(audio)
        # This field is producer elapsed time, not decoded media duration.
        assert entry.duration_s == produced[0].audio[entry.label].duration_s
    assert (upload / "song.wav").read_bytes() == source

    cached_id = db.insert_job(
        "s1",
        "upload",
        "song.wav",
        SeparationOptions(extract_vocals=True, extract_instruments=True),
    )
    cached_upload = config.UPLOADS_DIR / str(cached_id)
    cached_upload.mkdir(parents=True)
    (cached_upload / "song.wav").write_bytes(source)
    job = db.claim_oldest_queued()
    assert job is not None and job.id == cached_id
    cached_updates = asyncio.run(run_with_events(job))
    assert [update["progress"]["current"] for update in cached_updates] == [
        "source",
        "analysis",
        "analysis",
        "wait",
        "separation",
        "export",
        None,
    ]
    assert calls == ["separation", "separation"]


def test_phase_publication_does_not_deadlock_single_worker_executor(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    job_id = db.insert_job(
        "s1", "upload", "song.wav", SeparationOptions(extract_vocals=True)
    )
    job = db.claim_oldest_queued()
    assert job is not None and job.id == job_id
    parent, child = multiprocessing.get_context("fork").Pipe(duplex=False)

    def execute() -> None:
        def process(
            job: JobRecord,
            audio: bytes,
            filename: str,
            metadata: ReferenceMetadata | None,
            stop: threading.Event,
            on_phase: Callable[[JobPhase], None],
        ) -> ProcessingResult:
            on_phase(JobPhase.SEPARATION)
            return ProcessingResult({})

        monkeypatch.setattr(queue, "process_source", process)

        async def run() -> None:
            asyncio.get_running_loop().set_default_executor(
                ThreadPoolExecutor(max_workers=1)
            )
            listener = events.subscribe(job_id)
            await queue._process(job, b"source", "song.wav", None)
            child.send(listener.get_nowait()["progress"]["current"])
            events.unsubscribe(job_id, listener)

        asyncio.run(run())
        child.close()

    process = multiprocessing.get_context("fork").Process(target=execute)
    process.start()
    child.close()
    try:
        assert parent.poll(10), "phase callback blocked the only executor thread"
        assert parent.recv() == "separation"
        process.join(10)
        assert process.exitcode == 0
    finally:
        if process.is_alive():
            process.terminate()
            process.join(10)
        parent.close()


def test_source_only_job_does_not_wait_for_same_source_model_lock() -> None:
    job_id = db.insert_job("s1", "upload", "song.wav", SeparationOptions())
    _write_upload(job_id, "song.wav")
    job = db.claim_oldest_queued()
    assert job is not None and job.id == job_id
    lock = config.DATA_DIR / "artifacts" / "gpu-locks" / digest(b"audio-bytes")

    async def run() -> None:
        async with async_locked(lock):
            await asyncio.wait_for(queue._run_job(job), timeout=10)

    asyncio.run(run())
    done = db.get_job(job_id)
    assert done is not None and done.status is JobStatus.DONE


def test_run_job_url_sets_title_from_download(monkeypatch: pytest.MonkeyPatch) -> None:
    job_id = db.insert_job("s1", "url", "https://example.com/x", SeparationOptions())
    queued = db.get_job(job_id)
    assert queued is not None
    assert queued.title is None  # not known until downloaded

    monkeypatch.setattr(
        queue, "download_mp3", lambda url, dest, **kw: (b"audio", "My Song.mp3")
    )

    def forbidden(*args):
        raise AssertionError("source-only download invoked model processing")

    monkeypatch.setattr(queue, "process_source", forbidden)

    job = db.get_job(job_id)
    assert job is not None
    asyncio.run(queue._run_job(job))

    done = db.get_job(job_id)
    assert done is not None
    assert done.status is JobStatus.DONE
    assert done.title == "My Song"  # yt-dlp filename stem, not the raw URL


def test_run_job_url_persists_original(monkeypatch: pytest.MonkeyPatch) -> None:
    job_id = db.insert_job("s1", "url", "https://example.com/x", SeparationOptions())

    def fake_download(url: str, dest: str, **kw: object) -> tuple[bytes, str]:
        (Path(dest) / "My Song.mp3").write_bytes(b"original-audio")
        return b"original-audio", "My Song.mp3"

    monkeypatch.setattr(queue, "download_mp3", fake_download)

    def forbidden(*args):
        raise AssertionError("source-only download invoked model processing")

    monkeypatch.setattr(queue, "process_source", forbidden)

    job = db.get_job(job_id)
    assert job is not None
    asyncio.run(queue._run_job(job))

    original = config.UPLOADS_DIR / str(job_id) / "My Song.mp3"
    assert original.read_bytes() == b"original-audio"


def test_run_job_marks_failed_on_error(monkeypatch: pytest.MonkeyPatch) -> None:
    job_id = db.insert_job(
        "s1", "upload", "x.mp3", SeparationOptions(extract_vocals=True)
    )
    _write_upload(job_id, "x.mp3")

    def _boom(*a: object, **k: object) -> object:
        raise RuntimeError("raw inference stage failed")

    monkeypatch.setattr(queue, "process_source", _boom)

    job = db.get_job(job_id)
    assert job is not None
    asyncio.run(queue._run_job(job))

    failed = db.get_job(job_id)
    assert failed is not None
    assert failed.status is JobStatus.FAILED
    assert failed.error_message == "raw inference stage failed"


def test_load_options_maps_renamed_and_ignores_unknown() -> None:
    # A job stored under the old schema (chorus/vocalists, plus a dropped field).
    opts = db._load_options(
        '{"decrowd": true, "chorus": true, "vocalists": true, "gone": true}'
    )
    assert opts.genders is True  # chorus -> genders
    assert opts.lead_backing is True  # vocalists -> lead_backing
    assert opts.decrowd is True
    assert opts.drums is False  # default for a field the old row lacked


def test_reap_running_to_queued() -> None:
    job_id = db.insert_job("s1", "url", "https://example.com/x", SeparationOptions())
    claimed = db.claim_oldest_queued()
    assert claimed is not None and claimed.status is JobStatus.RUNNING

    db.reap_running_to_queued()

    reaped = db.get_job(job_id)
    assert reaped is not None
    assert reaped.status is JobStatus.QUEUED
