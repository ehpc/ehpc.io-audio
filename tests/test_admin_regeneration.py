"""Regeneration retains ownership and source identity without destructive eviction."""

import asyncio
import hashlib

import pytest
from audio_samples import tone_wav
from fastapi.testclient import TestClient

from backend import cache_catalog, config, db, queue, regeneration
from backend.main import app
from backend.models import JobRecord
from separator.artifact_cache import atomic_write
from separator.options import SeparationOptions


def original(
    owner, audio, *, source_type="upload", source_value="original.wav", options=None
):
    job_id = db.insert_job(
        owner, source_type, source_value, options or SeparationOptions()
    )
    directory = config.UPLOADS_DIR / str(job_id)
    directory.mkdir(parents=True)
    (directory / "original.wav").write_bytes(audio)
    db.mark_done(job_id, [])
    path = (
        config.DATA_DIR
        / "artifacts"
        / "keys"
        / (hashlib.sha256(audio).hexdigest() + ".bin")
    )
    with cache_catalog.capture() as recorder:
        recorder.bind(audio, "Track")
        atomic_write(path, b"key")
    song_id = next(
        song["id"]
        for song in cache_catalog.snapshot()["songs"]
        if song["title"] == "Track"
    )
    return job_id, song_id


def required_job(job_id: int) -> JobRecord:
    job = db.get_job(job_id)
    assert job is not None
    return job


def test_candidates_admission_ownership_and_durable_status(client, other_client):
    audio = tone_wav((440,), 0.3)
    options = SeparationOptions(detect_pitch=True, pitch_semitones=2, tempo_percent=95)
    owner = other_client.get("/api/auth/me").json()["id"]
    job_id, song_id = original(owner, audio, options=options)
    listing = client.get("/api/admin/cache").json()
    song = next(song for song in listing["songs"] if song["id"] == song_id)
    assert song["candidates"][0]["job_id"] == job_id
    assert song["candidates"][0]["options"]["pitch_semitones"] == 2
    body = {"jobs": [{"song_id": song_id, "job_id": job_id}]}
    assert (
        other_client.post("/api/admin/cache/regenerate", json=body).status_code == 403
    )
    assert TestClient(app).get("/api/admin/cache/regenerations").status_code == 401
    response = client.post("/api/admin/cache/regenerate", json=body)
    assert response.status_code == 200
    entry = response.json()["jobs"][0]
    new = required_job(entry["job_id"])
    assert new.session_id == owner and new.options == options
    assert entry["status"] == "queued" and entry["source_job_id"] == job_id
    assert required_job(job_id).status == "done"
    assert other_client.get(f"/api/jobs/{new.id}").status_code == 200
    assert any(job["id"] == new.id for job in other_client.get("/api/jobs").json())
    assert client.get(f"/api/jobs/{new.id}").status_code == 404
    assert queue._load_source_bytes(new)[0] == audio
    assert client.get("/api/admin/cache/regenerations").json() == [entry]
    assert client.post("/api/admin/cache/regenerate", json=body).status_code == 409
    db.mark_failed(new.id, "synthetic failure")
    assert client.get("/api/admin/cache/regenerations").json()[0]["status"] == "failed"
    assert (config.UPLOADS_DIR / str(job_id) / "original.wav").read_bytes() == audio


def test_atomic_validation_and_url_snapshot(client, monkeypatch):
    audio = tone_wav((523,), 0.3)
    job_id, song_id = original(
        "owner", audio, source_type="url", source_value="https://example.test/song"
    )
    sidecars = config.DATA_DIR / "source-metadata"
    sidecars.mkdir(parents=True, exist_ok=True)
    (sidecars / f"{job_id}.json").write_bytes(
        b'{"artist":"A","track":"T","duration":1}'
    )
    selection = {"song_id": song_id, "job_id": job_id}
    assert (
        client.post(
            "/api/admin/cache/regenerate", json={"jobs": [selection, selection]}
        ).status_code
        == 409
    )
    assert (
        client.post(
            "/api/admin/cache/regenerate",
            json={"jobs": [selection, {"song_id": "missing", "job_id": 999}]},
        ).status_code
        == 404
    )
    assert db.regeneration_status() == []
    response = client.post("/api/admin/cache/regenerate", json={"jobs": [selection]})
    assert response.status_code == 200
    new = required_job(response.json()["jobs"][0]["job_id"])
    assert new.source_type == "url" and new.source_value == "https://example.test/song"
    assert (sidecars / f"{new.id}.json").read_bytes() == (
        sidecars / f"{job_id}.json"
    ).read_bytes()
    monkeypatch.setattr(
        queue,
        "cached_download",
        lambda *a, **kw: (_ for _ in ()).throw(AssertionError("unexpected download")),
    )
    assert queue._load_source_bytes(new) == (audio, "original.wav")
    (config.UPLOADS_DIR / str(new.id) / "original.wav").write_bytes(b"changed")
    with pytest.raises(ValueError, match="snapshot changed"):
        queue._load_source_bytes(new)


def test_url_regeneration_attributes_new_artifact(client, monkeypatch):
    audio = tone_wav((392,), 0.3)
    job_id, song_id = original(
        "owner", audio, source_type="url", source_value="https://example.test/song"
    )
    response = client.post(
        "/api/admin/cache/regenerate",
        json={"jobs": [{"song_id": song_id, "job_id": job_id}]},
    )
    new = required_job(response.json()["jobs"][0]["job_id"])
    path = config.DATA_DIR / "artifacts" / "keys" / ("f" * 64 + ".bin")

    def produce_key(*args):
        atomic_write(path, b"new-key")
        return None

    monkeypatch.setattr(queue, "detect_key", produce_key)
    asyncio.run(queue._run_job(new))
    assert required_job(new.id).status == "done"
    assert f"keys/{path.name}" in cache_catalog.select_paths([song_id])
    assert cache_catalog.snapshot()["selective_ready"]


def test_missing_original_and_queue_capacity_do_not_mutate(client):
    audio = tone_wav((660,), 0.3)
    job_id, song_id = original("acct:owner", audio)
    source = config.UPLOADS_DIR / str(job_id) / "original.wav"
    source.unlink()
    song = next(
        s for s in client.get("/api/admin/cache").json()["songs"] if s["id"] == song_id
    )
    assert song["candidates"] == []
    body = {"jobs": [{"song_id": song_id, "job_id": job_id}]}
    assert client.post("/api/admin/cache/regenerate", json=body).status_code == 409
    source.write_bytes(audio)
    for index in range(5):
        db.insert_job("acct:owner", "upload", f"{index}.wav", SeparationOptions())
    assert client.post("/api/admin/cache/regenerate", json=body).status_code == 409
    assert db.regeneration_status() == []
    assert required_job(job_id).status == "done"
    assert source.read_bytes() == audio


def test_changed_source_during_copy_rolls_back_all_jobs(client, monkeypatch):
    audio = tone_wav((440,), 0.3)
    job_id, song_id = original("owner", audio)
    source = config.UPLOADS_DIR / str(job_id) / "original.wav"
    admit = db.enqueue_regenerations

    def modify_before_copy(items, install):
        source.write_bytes(b"changed after preflight")
        return admit(items, install)

    monkeypatch.setattr(db, "enqueue_regenerations", modify_before_copy)
    response = client.post(
        "/api/admin/cache/regenerate",
        json={"jobs": [{"song_id": song_id, "job_id": job_id}]},
    )
    assert response.status_code == 409
    assert db.regeneration_status() == []
    assert required_job(job_id).status == "done"
    assert list(config.UPLOADS_DIR.iterdir()) == [source.parent]


def test_mid_batch_copy_failure_preserves_every_original(client, monkeypatch):
    audio = tone_wav((440,), 0.3)
    first, song = original("owner-one", audio)
    second, _ = original("owner-two", audio)
    result = config.RESULTS_DIR / str(first) / "vocals.mp3"
    result.parent.mkdir(parents=True)
    result.write_bytes(b"existing result")
    copy = regeneration._copy_verified
    calls = 0

    def fail_second_copy(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise OSError("injected disk failure")
        return copy(*args, **kwargs)

    monkeypatch.setattr(regeneration, "_copy_verified", fail_second_copy)
    with pytest.raises(OSError, match="injected disk failure"):
        client.post(
            "/api/admin/cache/regenerate",
            json={
                "jobs": [
                    {"song_id": song, "job_id": first},
                    {"song_id": song, "job_id": second},
                ]
            },
        )

    assert calls == 2
    assert db.regeneration_status() == []
    assert {p.name for p in config.UPLOADS_DIR.iterdir()} == {str(first), str(second)}
    assert all(
        (config.UPLOADS_DIR / str(job) / "original.wav").read_bytes() == audio
        for job in (first, second)
    )
    assert result.read_bytes() == b"existing result"


def test_wrong_song_and_batch_capacity_rejected(client):
    audio = tone_wav((440,), 0.3)
    first, song = original("acct:owner", audio)
    second, _ = original("acct:owner", audio)
    other_audio = tone_wav((660,), 0.3)
    original("another", other_audio)
    ids = {entry["id"] for entry in cache_catalog.snapshot()["songs"]}
    other_song = next(item for item in ids if item != song)
    assert (
        client.post(
            "/api/admin/cache/regenerate",
            json={"jobs": [{"song_id": other_song, "job_id": first}]},
        ).status_code
        == 409
    )
    for index in range(4):
        db.insert_job(
            "acct:owner", "upload", f"queued-{index}.wav", SeparationOptions()
        )
    assert (
        client.post(
            "/api/admin/cache/regenerate",
            json={
                "jobs": [
                    {"song_id": song, "job_id": first},
                    {"song_id": song, "job_id": second},
                ]
            },
        ).status_code
        == 409
    )
    assert db.regeneration_status() == []


def test_deleting_original_and_clone_cleans_only_own_linkage(client):
    owner = client.get("/api/auth/me").json()["id"]
    audio = tone_wav((440,), 0.3)
    original_id, song = original(owner, audio)
    response = client.post(
        "/api/admin/cache/regenerate",
        json={"jobs": [{"song_id": song, "job_id": original_id}]},
    )
    clone_id = response.json()["jobs"][0]["job_id"]
    db.mark_done(clone_id, [])
    assert client.delete(f"/api/jobs/{original_id}").status_code == 204
    assert db.regeneration_snapshot(clone_id) is not None
    assert queue._load_source_bytes(required_job(clone_id))[0] == audio
    assert (
        client.get("/api/admin/cache/regenerations").json()[0]["source_job_id"]
        == original_id
    )
    assert client.delete(f"/api/jobs/{clone_id}").status_code == 204
    assert db.regeneration_snapshot(clone_id) is None
    assert client.get("/api/admin/cache/regenerations").json() == []


def test_retry_regenerated_url_uses_owned_snapshot_after_original_deleted(
    client, other_client, monkeypatch
):
    owner = other_client.get("/api/auth/me").json()["id"]
    audio = tone_wav((392,), 0.3)
    original_id, song = original(
        owner,
        audio,
        source_type="url",
        source_value="https://example.test/song",
        options=SeparationOptions(pitch_semitones=2),
    )
    sidecars = config.DATA_DIR / "source-metadata"
    sidecars.mkdir(parents=True, exist_ok=True)
    metadata = b'{"artist":"A","track":"T","duration":1}'
    (sidecars / f"{original_id}.json").write_bytes(metadata)
    response = client.post(
        "/api/admin/cache/regenerate",
        json={"jobs": [{"song_id": song, "job_id": original_id}]},
    )
    failed_id = response.json()["jobs"][0]["job_id"]
    db.mark_failed(failed_id, "synthetic failure")
    assert other_client.delete(f"/api/jobs/{original_id}").status_code == 204
    assert client.post(f"/api/jobs/{failed_id}/retry").status_code == 404
    response = other_client.post(f"/api/jobs/{failed_id}/retry")
    assert response.status_code == 200
    retried = required_job(response.json()["id"])
    assert retried.session_id == owner and retried.source_type == "url"
    assert retried.source_value == "https://example.test/song"
    assert retried.options.pitch_semitones == 2
    assert (sidecars / f"{retried.id}.json").read_bytes() == metadata
    assert other_client.get(f"/api/jobs/{retried.id}").status_code == 200
    assert any(j["id"] == retried.id for j in other_client.get("/api/jobs").json())
    monkeypatch.setattr(
        queue, "cached_download", lambda *a, **kw: pytest.fail("redownload")
    )
    assert queue._load_source_bytes(retried) == (audio, "original.wav")
