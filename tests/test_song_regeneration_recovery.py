"""Durable song maintenance survives interrupted clear and queue restart."""

import asyncio
import hashlib
import os
import signal
import subprocess
import sys
from pathlib import Path

import pytest
from audio_samples import tone_wav
from test_admin_regeneration import original

from backend import cache_catalog, config, db, queue, regeneration
from backend.routes import admin_cache
from separator.options import SeparationOptions


def test_interrupted_clear_resumes_before_claiming_work(client, monkeypatch):
    owner = client.get("/api/auth/me").json()["id"]
    audio = tone_wav((440,), 0.3)
    job_id, song_id = original(owner, audio, options=SeparationOptions())
    old = client.get(f"/api/jobs/{job_id}").json()
    library_song_id = old["song_id"]
    assert client.post(f"/api/songs/{library_song_id}/open").json()["open_count"] == 1
    operations = regeneration.prepare([song_id])
    status = next(
        s for s in db.regeneration_status() if s["operation_id"] == operations[0]
    )
    assert status["status"] == "clearing"
    assert db.claim_oldest_queued() is None
    admin_cache.recover_song_clears()
    assert (
        next(s for s in db.regeneration_status() if s["operation_id"] == operations[0])[
            "status"
        ]
        == "queued"
    )
    assert cache_catalog.song_digests({song_id})[song_id]
    claimed = db.claim_oldest_queued()
    assert claimed is not None
    db.reap_running_to_queued()
    claimed = db.claim_oldest_queued()
    assert claimed is not None
    monkeypatch.setattr(queue, "detect_key", lambda *args: None)
    asyncio.run(queue._run_job(claimed))
    status = next(
        s for s in db.regeneration_status() if s["operation_id"] == operations[0]
    )
    assert status["status"] == "done" and status["completed_jobs"] == 1
    after = client.get(f"/api/jobs/{job_id}").json()
    assert after["id"] == old["id"] and after["created_at"] == old["created_at"]
    summary = client.get(f"/api/songs/{library_song_id}").json()["summary"]
    assert summary["open_count"] == 1
    assert after["result_revision"] is not None
    assert len(client.get("/api/songs").json()) == 1


def test_restart_clears_all_reserved_songs_before_activating_any(client):
    owner = client.get("/api/auth/me").json()["id"]
    first = tone_wav((330,), 0.3)
    second = tone_wav((550,), 0.3)
    original(owner, first)
    original(owner, second)
    ids = {song["id"] for song in cache_catalog.snapshot()["songs"]}
    by_digest = {
        digest: ident for ident, digest in cache_catalog.song_digests(ids).items()
    }
    selected = [
        by_digest[hashlib.sha256(audio).hexdigest()] for audio in (first, second)
    ]
    operations = regeneration.prepare(selected)
    admin_cache.recover_song_clears()
    statuses = {s["operation_id"]: s["status"] for s in db.regeneration_status()}
    assert [statuses[operation_id] for operation_id in operations] == [
        "queued",
        "queued",
    ]
    assert len(list((config.DATA_DIR / "artifacts" / "keys").glob("*.bin"))) == 0


def test_failed_post_clear_activation_keeps_song_selectable(client, monkeypatch):
    owner = client.get("/api/auth/me").json()["id"]
    job_id, song_id = original(owner, tone_wav((440,), 0.3))
    old = client.get(f"/api/jobs/{job_id}").json()
    activate = db.activate_song_regenerations

    def fail_activation(_ids):
        raise RuntimeError("injected activation failure")

    monkeypatch.setattr(db, "activate_song_regenerations", fail_activation)
    with pytest.raises(RuntimeError, match="injected activation failure"):
        client.post("/api/admin/cache/regenerate", json={"ids": [song_id]})
    assert db.regeneration_status()[0]["status"] == "failed"
    assert client.get(f"/api/jobs/{job_id}").json() == old
    song = next(
        s for s in client.get("/api/admin/cache").json()["songs"] if s["id"] == song_id
    )
    assert song["bytes"] == 0 and song["regenerable"] and song["matched_jobs"] == 1
    monkeypatch.setattr(db, "activate_song_regenerations", activate)
    response = client.post("/api/admin/cache/regenerate", json={"ids": [song_id]})
    assert response.status_code == 200
    assert response.json()["operations"][0]["song_id"] == song_id


def test_generation_parent_fsync_failure_preserves_original(client, monkeypatch):
    owner = client.get("/api/auth/me").json()["id"]
    job_id, song_id = original(owner, tone_wav((523,), 0.3))
    old = client.get(f"/api/jobs/{job_id}").json()
    response = client.post("/api/admin/cache/regenerate", json={"ids": [song_id]})
    operation_id = response.json()["operations"][0]["operation_id"]
    claimed = db.claim_oldest_queued()
    assert claimed is not None
    monkeypatch.setattr(queue, "detect_key", lambda *args: None)
    real_fsync = os.fsync
    original_dir = config.RESULTS_DIR / str(job_id)

    def fail_parent(fd):
        if Path(f"/proc/self/fd/{fd}").readlink() == original_dir:
            raise OSError("injected parent fsync failure")
        real_fsync(fd)

    monkeypatch.setattr(queue.os, "fsync", fail_parent)
    asyncio.run(queue._run_job(claimed))
    status = next(
        s for s in db.regeneration_status() if s["operation_id"] == operation_id
    )
    assert status["status"] == "failed" and status["completed_jobs"] == 0
    assert client.get(f"/api/jobs/{job_id}").json() == old


def _kill_during_copy(mode, identifier, owner):
    worker = Path(__file__).with_name("song_regeneration_crash_worker.py")
    project = worker.parent.parent
    environment = {
        **os.environ,
        "DATA_DIR": str(config.DATA_DIR),
        "QUEUE_CONCURRENCY": "0",
        "PYTHONPATH": os.pathsep.join(
            filter(None, [str(project), os.environ.get("PYTHONPATH", "")])
        ),
    }
    result = subprocess.run(
        [sys.executable, str(worker), mode, str(identifier), owner],
        cwd=project,
        env=environment,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == -signal.SIGKILL, result.stdout + result.stderr


def test_killed_snapshot_preparation_cannot_reuse_or_expose_reserved_id(
    client, other_client
):
    owner = client.get("/api/auth/me").json()["id"]
    audio = tone_wav((349,), 0.3)
    job_id, song_id = original(
        owner, audio, source_type="url", source_value="https://example.test/track"
    )
    library_song_id = client.get(f"/api/jobs/{job_id}").json()["song_id"]
    sidecar_dir = config.DATA_DIR / "source-metadata"
    sidecar_dir.mkdir(parents=True)
    (sidecar_dir / f"{job_id}.json").write_text('{"track":"private title"}')
    history = client.get("/api/songs").json()
    artifact = next((config.DATA_DIR / "artifacts" / "keys").glob("*.bin"))
    cache_before = (artifact.read_bytes(), artifact.stat().st_ino)
    _kill_during_copy("song", song_id, owner)
    with db._session() as conn:
        reservation = conn.execute(
            "SELECT i.work_job_id, s.ready FROM song_regeneration_items i "
            "JOIN job_source_snapshots s ON s.job_id=i.work_job_id"
        ).fetchone()
    reserved_id = reservation["work_job_id"]
    assert reservation["ready"] == 0
    assert (
        config.UPLOADS_DIR / str(reserved_id) / "original.wav"
    ).read_bytes() == audio
    assert (sidecar_dir / f"{reserved_id}.json").exists()
    assert db.claim_oldest_queued() is None
    assert db.regeneration_status()[0]["status"] == "clearing"
    assert client.delete(f"/api/songs/{library_song_id}").status_code == 409
    assert (
        client.post("/api/admin/cache/clear", json={"ids": [song_id]}).status_code
        == 409
    )
    assert (artifact.read_bytes(), artifact.stat().st_ino) == cache_before
    admin_cache.recover_song_clears()
    assert db.regeneration_status()[0]["status"] == "failed"
    assert client.get("/api/songs").json() == history
    assert client.get(f"/api/jobs/{job_id}/original").content == audio
    song = next(
        s for s in client.get("/api/admin/cache").json()["songs"] if s["id"] == song_id
    )
    assert song["regenerable"] and song["matched_jobs"] == 1
    assert (artifact.read_bytes(), artifact.stat().st_ino) == cache_before
    assert other_client.get(f"/api/jobs/{reserved_id}/original").status_code == 404
    uploaded = other_client.post(
        "/api/jobs", files={"file": ("own.wav", b"unrelated input", "audio/wav")}
    )
    assert uploaded.status_code == 200, uploaded.text
    new_id = uploaded.json()["work_id"]
    assert new_id != reserved_id
    assert (
        other_client.get(f"/api/jobs/{new_id}/original").content == b"unrelated input"
    )
    assert not (sidecar_dir / f"{new_id}.json").exists()


def test_killed_snapshot_retry_keeps_reserved_id_hidden(client, other_client):
    owner = client.get("/api/auth/me").json()["id"]
    audio = tone_wav((370,), 0.3)
    job_id, song_id = original(
        owner, audio, source_type="url", source_value="https://example.test/track"
    )
    sidecars = config.DATA_DIR / "source-metadata"
    sidecars.mkdir(parents=True)
    (sidecars / f"{job_id}.json").write_text('{"track":"original private title"}')
    db.mark_failed(job_id, "prior failure")
    with db._session() as conn:
        conn.execute(
            "INSERT INTO job_source_snapshots "
            "(job_id,source_job_id,song_id,filename,source_sha256) VALUES (?,?,?,?,?)",
            (
                job_id,
                job_id,
                song_id,
                "original.wav",
                hashlib.sha256(audio).hexdigest(),
            ),
        )
    history = client.get("/api/songs").json()
    _kill_during_copy("retry", job_id, owner)
    with db._session() as conn:
        reserved = conn.execute(
            "SELECT j.id,s.ready FROM jobs j JOIN job_source_snapshots s "
            "ON s.job_id=j.id WHERE j.internal=1"
        ).fetchone()
    assert reserved["ready"] == 0
    assert db.claim_oldest_queued() is None
    assert client.get(f"/api/jobs/{reserved['id']}/original").status_code == 404
    admin_cache.recover_song_clears()
    assert client.get("/api/songs").json() == history
    response = other_client.post(
        "/api/jobs", data={"url": "https://example.test/other"}
    )
    assert response.status_code == 200, response.text
    assert response.json()["work_id"] != reserved["id"]
    assert not (sidecars / f"{response.json()['work_id']}.json").exists()
