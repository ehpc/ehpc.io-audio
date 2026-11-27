"""Compatibility for snapshot-backed jobs created by the previous release."""

import hashlib

from audio_samples import tone_wav

from backend import cache_catalog, config, db, queue
from separator.artifact_cache import atomic_write
from separator.options import SeparationOptions


def original(
    owner, audio, *, source_type="upload", source_value="original.wav", options=None
):
    submitted = db.insert_job(
        owner, source_type, source_value, options or SeparationOptions()
    )
    assert submitted.work_id is not None
    job_id = submitted.work_id
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


def test_migrated_snapshot_retry_survives_deleted_original(
    client, other_client, monkeypatch
):
    owner = other_client.get("/api/auth/me").json()["id"]
    audio = tone_wav((392,), 0.3)
    original_owner = client.get("/api/auth/me").json()["id"]
    original_id, song = original(
        original_owner,
        audio,
        source_type="url",
        source_value="https://example.test/song",
    )
    options = SeparationOptions(pitch_semitones=2)
    clone_work = db.insert_job(owner, "url", "https://example.test/song", options)
    assert clone_work.work_id is not None
    old_clone = clone_work.work_id
    directory = config.UPLOADS_DIR / str(old_clone)
    directory.mkdir(parents=True)
    (directory / "original.wav").write_bytes(audio)
    metadata = b'{"artist":"A","track":"T","duration":1}'
    sidecars = config.DATA_DIR / "source-metadata"
    sidecars.mkdir(parents=True, exist_ok=True)
    (sidecars / f"{old_clone}.json").write_bytes(metadata)
    db.mark_failed(old_clone, "old failure")
    with db._session() as conn:
        conn.execute(
            "CREATE TABLE regenerations (job_id INTEGER PRIMARY KEY, "
            "source_job_id INTEGER NOT NULL, song_id TEXT NOT NULL, "
            "filename TEXT NOT NULL, source_sha256 TEXT NOT NULL)"
        )
        conn.execute(
            "INSERT INTO regenerations VALUES (?,?,?,?,?)",
            (
                old_clone,
                original_id,
                song,
                "original.wav",
                hashlib.sha256(audio).hexdigest(),
            ),
        )
    db.init_db()
    assert db.regeneration_snapshot(old_clone) == (
        "original.wav",
        hashlib.sha256(audio).hexdigest(),
    )
    with db._session() as conn:
        assert not conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='regenerations'"
        ).fetchone()
    original_song_id = client.get(f"/api/jobs/{original_id}").json()["song_id"]
    assert client.delete(f"/api/songs/{original_song_id}").status_code == 204
    assert client.post(f"/api/jobs/{old_clone}/retry").status_code == 404
    response = other_client.post(f"/api/jobs/{old_clone}/retry")
    assert response.status_code == 200
    new_id = response.json()["work_id"]
    job = db.get_job(new_id)
    assert job is not None and job.session_id == owner and job.options == options
    assert job.source_type == "url" and job.source_value == "https://example.test/song"
    assert (sidecars / f"{new_id}.json").read_bytes() == metadata
    monkeypatch.setattr(
        queue,
        "cached_download",
        lambda *a, **kw: (_ for _ in ()).throw(AssertionError("redownload")),
    )
    assert queue._load_source_bytes(job) == (audio, "original.wav")
    assert other_client.get(f"/api/jobs/{new_id}").status_code == 200
