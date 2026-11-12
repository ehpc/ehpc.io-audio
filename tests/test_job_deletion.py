import asyncio
import fcntl
import hashlib
import json
import threading
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend import config, db, drain
from backend.main import JobAccess, app
from backend.models import ResultManifestEntry
from backend.routes import jobs, results
from backend.routes.results import _tracked_thread
from separator.options import SeparationOptions


def completed_job(owner: str, name: str) -> int:
    job = db.insert_job(owner, "upload", name, SeparationOptions())
    uploads = config.UPLOADS_DIR / str(job)
    results = config.RESULTS_DIR / str(job)
    uploads.mkdir(parents=True)
    results.mkdir(parents=True)
    (uploads / name).write_bytes(b"original shared source")
    (results / "song.mp3").write_bytes(b"personal output")
    (results / ".pitch-vocals.mp3").write_bytes(b"private vocal reference")
    metadata = config.DATA_DIR / "source-metadata" / f"{job}.json"
    metadata.parent.mkdir(parents=True, exist_ok=True)
    metadata.write_text('{"artist":"private"}')
    db.mark_done(job, [])
    return job


def stage(job: int, *, cleaned: bool = True) -> tuple[Path, Path]:
    key = "a" * 64
    root = config.DATA_DIR / "artifacts"
    artifact = root / "inference" / f"{key}.bin"
    receipt = root / "inference-requests" / f"{key}.json"
    artifact.parent.mkdir(parents=True, exist_ok=True)
    receipt.parent.mkdir(parents=True, exist_ok=True)
    artifact.write_bytes(b"shared completed inference")
    receipt.write_text(
        json.dumps(
            {
                "output_id": "b" * 32,
                "result_sha256": hashlib.sha256(artifact.read_bytes()).hexdigest(),
                "result_size": artifact.stat().st_size,
                "cleaned": cleaned,
                "cleanup_pending": not cleaned,
            }
        )
    )
    db.set_active_stage(job, key, "fc-completed")
    return artifact, receipt


def test_delete_is_owned_and_preserves_shared_cache_and_other_user(
    client, other_client
):
    owner = client.get("/api/auth/me").json()["id"]
    other = other_client.get("/api/auth/me").json()["id"]
    first = completed_job(owner, "same.wav")
    second = completed_job(other, "same.wav")
    artifact, receipt = stage(first)
    original_artifact, original_receipt = artifact.read_bytes(), receipt.read_bytes()
    anonymous = TestClient(
        app, base_url="https://testserver", headers={"origin": "https://testserver"}
    )
    assert anonymous.delete(f"/api/jobs/{first}").status_code == 401
    assert other_client.delete(f"/api/jobs/{first}").status_code == 404
    assert client.delete(f"/api/jobs/{second}").status_code == 404
    assert db.get_job(first) is not None and db.get_job(second) is not None
    assert client.delete(f"/api/jobs/{first}").status_code == 204
    assert client.get(f"/api/jobs/{first}").status_code == 404
    assert client.delete(f"/api/jobs/{first}").status_code == 404
    assert not (config.UPLOADS_DIR / str(first)).exists()
    assert not (config.RESULTS_DIR / str(first)).exists()
    assert not (config.DATA_DIR / "source-metadata" / f"{first}.json").exists()
    assert (
        other_client.get(f"/api/jobs/{second}/original").content
        == b"original shared source"
    )
    assert (
        config.RESULTS_DIR / str(second) / ".pitch-vocals.mp3"
    ).read_bytes() == b"private vocal reference"
    assert artifact.read_bytes() == original_artifact
    assert receipt.read_bytes() == original_receipt
    assert not client.get("/api/admin/cache").json()["busy"]


@pytest.mark.parametrize("state", ["queued", "running", "failed"])
def test_noncompleted_jobs_cannot_be_deleted(client, state):
    owner = client.get("/api/auth/me").json()["id"]
    job = completed_job(owner, "original.wav")
    with db._session() as conn:
        conn.execute("UPDATE jobs SET status=? WHERE id=?", (state, job))
    assert client.delete(f"/api/jobs/{job}").status_code == 409
    assert db.get_job(job) is not None
    assert (config.UPLOADS_DIR / str(job) / "original.wav").exists()
    assert (config.RESULTS_DIR / str(job) / "song.mp3").exists()


def test_drain_rejects_deletion_without_removing_job_or_files(client):
    owner = client.get("/api/auth/me").json()["id"]
    job = completed_job(owner, "original.wav")
    with db._session() as conn:
        before = conn.execute(
            "SELECT COUNT(*) FROM auth_work WHERE user_id = ?", (owner,)
        ).fetchone()[0]
    client.portal.call(drain.state.begin)
    assert client.delete(f"/api/jobs/{job}").status_code == 503
    assert db.get_job(job) is not None
    assert (config.UPLOADS_DIR / str(job) / "original.wav").exists()
    assert (config.RESULTS_DIR / str(job) / "song.mp3").exists()
    drain.state.reset()
    assert client.delete(f"/api/jobs/{job}").status_code == 204
    with db._session() as conn:
        after = conn.execute(
            "SELECT COUNT(*) FROM auth_work WHERE user_id = ?", (owner,)
        ).fetchone()[0]
    assert after == before


@pytest.mark.parametrize(
    "problem", ["missing_call", "pending", "missing_receipt", "corrupt", "locked"]
)
def test_unresolved_inference_prevents_job_deletion(client, problem):
    owner = client.get("/api/auth/me").json()["id"]
    job = completed_job(owner, "original.wav")
    artifact, receipt = stage(job, cleaned=problem != "pending")
    lock = None
    if problem == "missing_call":
        db.set_active_stage(job, "a" * 64, None)
    elif problem == "missing_receipt":
        receipt.unlink()
    elif problem == "corrupt":
        artifact.write_bytes(b"altered inference")
    elif problem == "locked":
        lock = artifact.with_suffix(".lock").open("a+b")
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    try:
        assert client.delete(f"/api/jobs/{job}").status_code == 409
    finally:
        if lock is not None:
            fcntl.flock(lock, fcntl.LOCK_UN)
            lock.close()
    assert db.get_job(job) is not None
    assert (config.UPLOADS_DIR / str(job) / "original.wav").exists()
    assert (config.RESULTS_DIR / str(job) / ".pitch-vocals.mp3").exists()
    assert artifact.exists()


def test_missing_owned_files_can_be_deleted_but_unsafe_symlink_cannot(client, tmp_path):
    owner = client.get("/api/auth/me").json()["id"]
    empty = db.insert_job(owner, "upload", "missing.wav", SeparationOptions())
    db.mark_done(empty, [])
    assert client.delete(f"/api/jobs/{empty}").status_code == 204
    job = completed_job(owner, "original.wav")
    outside = tmp_path / "other-user-data"
    outside.write_bytes(b"do not touch")
    (config.RESULTS_DIR / str(job) / "unsafe").symlink_to(outside)
    assert client.delete(f"/api/jobs/{job}").status_code == 409
    assert outside.read_bytes() == b"do not touch"
    assert (config.UPLOADS_DIR / str(job) / "original.wav").exists()
    assert db.get_job(job) is not None


def test_partial_file_error_keeps_row_and_allows_retry(client, monkeypatch):
    owner = client.get("/api/auth/me").json()["id"]
    job = completed_job(owner, "original.wav")
    real_rmtree = jobs.shutil.rmtree

    def fail_results(path):
        if path == config.RESULTS_DIR / str(job):
            raise OSError("fixture failure")
        return real_rmtree(path)

    monkeypatch.setattr(jobs.shutil, "rmtree", fail_results)
    assert client.delete(f"/api/jobs/{job}").status_code == 503
    assert db.get_job(job) is not None
    assert (config.RESULTS_DIR / str(job) / "song.mp3").exists()
    monkeypatch.setattr(jobs.shutil, "rmtree", real_rmtree)
    assert client.delete(f"/api/jobs/{job}").status_code == 204
    assert db.get_job(job) is None


@pytest.mark.parametrize("id_format", ["{}", "+{}", "{}.0", "0{}"])
def test_delete_http_fails_fast_during_download_without_blocking_other_reads(
    client, other_client, monkeypatch, id_format
):
    owner = client.get("/api/auth/me").json()["id"]
    job = completed_job(owner, "original.wav")
    db.mark_done(
        job,
        [
            ResultManifestEntry(
                label="song", filename="song.mp3", size_bytes=15, duration_s=1
            )
        ],
    )
    started, finish = threading.Event(), threading.Event()
    observed = []

    def delay_title(path, title):
        started.set()
        assert finish.wait(5)
        return path.stat().st_size

    monkeypatch.setattr(results, "ensure_download_title", delay_title)
    download = threading.Thread(
        target=lambda: observed.append(
            client.get(f"/api/jobs/{id_format.format(job)}/results/song").status_code
        )
    )
    download.start()
    try:
        assert started.wait(5)
        assert other_client.delete(f"/api/jobs/{job}").status_code == 404
        assert client.delete(f"/api/jobs/{job}").status_code == 409
        assert (
            client.get(f"/api/jobs/{job}/original").content == b"original shared source"
        )
    finally:
        finish.set()
        download.join(timeout=5)
    assert not download.is_alive()
    assert observed == [200]
    assert client.delete(f"/api/jobs/{job}").status_code == 204


def test_delete_fails_fast_for_stream_and_readers_remain_concurrent():
    async def exercise():
        started, second_started, finish = (asyncio.Event() for _ in range(3))

        async def application(scope, receive, send):
            if scope["path"].endswith("/original"):
                started.set()
            else:
                second_started.set()
            await finish.wait()

        middleware = JobAccess(application)
        stream = asyncio.create_task(
            middleware(
                {"type": "http", "method": "GET", "path": "/api/jobs/12/original"},
                None,
                None,
            )
        )
        await started.wait()
        second = asyncio.create_task(
            middleware(
                {"type": "http", "method": "GET", "path": "/api/jobs/12/results/song"},
                None,
                None,
            )
        )
        await second_started.wait()
        assert not middleware.begin_delete(12)
        assert middleware.begin_delete(13)
        middleware.end_delete(13)
        finish.set()
        await asyncio.gather(stream, second)
        assert middleware.begin_delete(12)
        middleware.end_delete(12)

    asyncio.run(exercise())


def test_cancelled_file_request_keeps_lease_until_worker_exits():
    async def exercise():
        started, finish = threading.Event(), threading.Event()

        def worker():
            started.set()
            assert finish.wait(5)

        async def application(scope, receive, send):
            await _tracked_thread(worker)

        middleware = JobAccess(application)
        task = asyncio.create_task(
            middleware(
                {"type": "http", "method": "GET", "path": "/api/jobs/12/original"},
                None,
                None,
            )
        )
        assert await asyncio.to_thread(started.wait, 5)
        task.cancel()
        await asyncio.sleep(0)
        assert not middleware.begin_delete(12)
        finish.set()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert middleware.begin_delete(12)
        middleware.end_delete(12)

    asyncio.run(exercise())
