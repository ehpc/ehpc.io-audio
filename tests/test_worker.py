import asyncio
from pathlib import Path

import pytest
from audio_samples import mp3_measurements, tone_wav
from inference_fixture import StemSignal, cpu_inference, fixture_manifest

from backend import config, db, modal_client, queue
from backend.models import JobStatus
from separator.options import SeparationOptions
from separator.processing import ProcessingContext, run_processing


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

    def process(job, audio, filename, metadata, stop):
        assert audio == source and filename == "song.wav"
        assert not stop.is_set()
        work = tmp_path / "work"
        work.mkdir()
        input_path = work / filename
        input_path.write_bytes(audio)
        context = ProcessingContext(tmp_path / "cache", manifest, infer)
        result = run_processing(input_path, job.options, work, context, metadata)
        produced.append(result)
        return result

    monkeypatch.setattr(queue, "process_source", process)

    job = db.get_job(job_id)
    assert job is not None
    asyncio.run(queue._run_job(job))

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
