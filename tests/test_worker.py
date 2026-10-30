import asyncio
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from backend import config, db, modal_client, queue
from backend.models import JobStatus
from separator.options import SeparationOptions
from separator.stems import StemResult


@pytest.fixture(autouse=True)
def _key_analysis(monkeypatch: pytest.MonkeyPatch) -> None:
    # Unit tests use placeholder audio; native analysis is exercised separately.
    monkeypatch.setattr(queue, "detect_key", lambda audio, name: "C major")


def _write_upload(job_id: int, filename: str) -> None:
    upload_dir = config.UPLOADS_DIR / str(job_id)
    upload_dir.mkdir(parents=True, exist_ok=True)
    (upload_dir / filename).write_bytes(b"audio-bytes")


def test_run_job_upload_success(monkeypatch: pytest.MonkeyPatch) -> None:
    job_id = db.insert_job(
        "s1",
        "upload",
        "song.mp3",
        SeparationOptions(extract_vocals=True, extract_instruments=True),
    )
    _write_upload(job_id, "song.mp3")

    call = MagicMock()
    call.object_id = "fc-test"
    monkeypatch.setattr(modal_client, "spawn", lambda *a, **k: call)
    result = {
        "vocals": StemResult(data=b"vvv", duration_s=1.0),
        "instruments": StemResult(data=b"iiii", duration_s=2.0),
    }
    monkeypatch.setattr(modal_client, "poll", lambda c, t: result)

    job = db.get_job(job_id)
    assert job is not None
    asyncio.run(queue._run_job(job))

    done = db.get_job(job_id)
    assert done is not None
    assert done.status is JobStatus.DONE
    assert done.modal_call_id == "fc-test"
    assert done.title == "song.mp3"  # an upload's title is its filename
    assert done.result_manifest is not None
    assert [entry.label for entry in done.result_manifest] == ["vocals", "instruments"]
    assert (
        (config.RESULTS_DIR / str(job_id) / "vocals.mp3").read_bytes().endswith(b"vvv")
    )


def test_run_job_url_sets_title_from_download(monkeypatch: pytest.MonkeyPatch) -> None:
    job_id = db.insert_job("s1", "url", "https://example.com/x", SeparationOptions())
    queued = db.get_job(job_id)
    assert queued is not None
    assert queued.title is None  # not known until downloaded

    monkeypatch.setattr(
        queue, "download_mp3", lambda url, dest, **kw: (b"audio", "My Song.mp3")
    )
    call = MagicMock()
    call.object_id = "fc"
    monkeypatch.setattr(modal_client, "spawn", lambda *a, **k: call)
    monkeypatch.setattr(
        modal_client,
        "poll",
        lambda c, t: {"vocals": StemResult(b"v", 1.0)},
    )

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
    call = MagicMock()
    call.object_id = "fc"
    monkeypatch.setattr(modal_client, "spawn", lambda *a, **k: call)
    monkeypatch.setattr(
        modal_client,
        "poll",
        lambda c, t: {"vocals": StemResult(b"v", 1.0)},
    )

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
        raise RuntimeError("spawn failed")

    monkeypatch.setattr(modal_client, "spawn", _boom)

    job = db.get_job(job_id)
    assert job is not None
    asyncio.run(queue._run_job(job))

    failed = db.get_job(job_id)
    assert failed is not None
    assert failed.status is JobStatus.FAILED
    assert failed.error_message == "spawn failed"  # real reason, not a generic message


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
