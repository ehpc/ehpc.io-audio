"""Deleting a visible job reclaims only safely finished private maintenance files."""

import asyncio
import hashlib

from audio_samples import tone_wav
from test_admin_regeneration import original
from test_job_deletion import stage

from backend import config, db, queue
from separator.options import SeparationOptions
from separator.processing import ProcessingResult
from separator.stems import StemResult


def test_delete_reclaims_resolved_work_but_keeps_uncertain_and_visible_snapshot(
    client, other_client, monkeypatch
):
    owner = client.get("/api/auth/me").json()["id"]
    other = other_client.get("/api/auth/me").json()["id"]
    audio = tone_wav((440,), 0.3)
    job_id, song_id = original(
        owner,
        audio,
        source_type="url",
        source_value="https://example.test/song",
        options=SeparationOptions(extract_vocals=True),
    )
    metadata = config.DATA_DIR / "source-metadata"
    metadata.mkdir(parents=True)
    (metadata / f"{job_id}.json").write_text('{"track":"private"}')
    monkeypatch.setattr(queue, "detect_key", lambda *args: None)
    monkeypatch.setattr(
        queue,
        "process_source",
        lambda *args: ProcessingResult(audio={"vocals": StemResult(audio, 0.3)}),
    )
    persist = queue._persist_results
    work_ids = []
    for attempt in range(3):
        response = client.post("/api/admin/cache/regenerate", json={"ids": [song_id]})
        assert response.status_code == 200, response.text
        work = db.claim_oldest_queued()
        assert work is not None
        work_ids.append(work.id)
        if attempt:

            def fail_after_staging(*args, work_id=work.id, **kwargs):
                root = config.RESULTS_DIR / str(work_id)
                root.mkdir(parents=True)
                (root / "partial.mp3").write_bytes(b"private partial")
                raise RuntimeError("injected partial persistence failure")

            monkeypatch.setattr(queue, "_persist_results", fail_after_staging)
        else:
            monkeypatch.setattr(queue, "_persist_results", persist)
        asyncio.run(queue._run_job(work))
        assert db.regeneration_status()[0]["status"] == (
            "done" if not attempt else "failed"
        )
    resolved, failed, unresolved = work_ids
    artifact, receipt = stage(resolved)
    db.set_active_stage(unresolved, "c" * 64, None)
    clone = db.insert_job(
        other, "url", "https://example.test/legacy-clone", SeparationOptions()
    )
    clone_dir = config.UPLOADS_DIR / str(clone)
    clone_dir.mkdir(parents=True)
    (clone_dir / "original.wav").write_bytes(b"independent legacy snapshot")
    (metadata / f"{clone}.json").write_text('{"track":"other"}')
    db.mark_done(clone, [])
    with db._session() as conn:
        conn.execute(
            "INSERT INTO job_source_snapshots "
            "(job_id,source_job_id,song_id,filename,source_sha256) VALUES (?,?,?,?,?)",
            (
                clone,
                job_id,
                song_id,
                "original.wav",
                hashlib.sha256(b"independent legacy snapshot").hexdigest(),
            ),
        )
    assert client.delete(f"/api/jobs/{job_id}").status_code == 204
    assert client.get(f"/api/jobs/{job_id}").status_code == 404
    for cleaned in (resolved, failed):
        assert not (config.UPLOADS_DIR / str(cleaned)).exists()
        assert not (config.RESULTS_DIR / str(cleaned)).exists()
        assert not (metadata / f"{cleaned}.json").exists()
        assert db.regeneration_snapshot(cleaned) is None
        assert (
            db.get_job(cleaned) is not None
        )  # retained inference/operation ledger identity
    assert (config.UPLOADS_DIR / str(unresolved) / "original.wav").read_bytes() == audio
    assert (
        config.RESULTS_DIR / str(unresolved) / "partial.mp3"
    ).read_bytes() == b"private partial"
    assert (metadata / f"{unresolved}.json").exists()
    assert db.regeneration_snapshot(unresolved) is not None
    unresolved_job = db.get_job(unresolved)
    assert unresolved_job is not None and unresolved_job.active_stage_key == "c" * 64
    assert artifact.exists() and receipt.exists()
    assert (
        other_client.get(f"/api/jobs/{clone}/original").content
        == b"independent legacy snapshot"
    )
    assert (metadata / f"{clone}.json").exists()
    assert db.regeneration_snapshot(clone) is not None
