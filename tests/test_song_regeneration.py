"""Song regeneration replaces owned history in place, not with new jobs."""

import asyncio
import hashlib
import socket
import sqlite3
import threading
import time

from audio_samples import tone_wav
from fastapi.testclient import TestClient
from test_admin_regeneration import original
from test_cache_http import finish, server, trace

from backend import cache_catalog, config, db, queue
from backend.main import app
from backend.metadata import ensure_download_title
from backend.models import ResultManifestEntry, download_filename
from separator.artifact_cache import atomic_write
from separator.options import SeparationOptions
from separator.processing import ProcessingResult
from separator.stems import StemResult


def _completed(owner, audio, options, output):
    job_id, song_id = original(owner, audio, options=options)
    path = config.RESULTS_DIR / str(job_id) / "vocals.mp3"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(output)
    job = db.get_job(job_id)
    assert job is not None
    size = ensure_download_title(
        path,
        download_filename(job.title, job.id, "vocals", job.options, job.original_key),
    )
    db.mark_done(
        job_id,
        [
            ResultManifestEntry(
                label="vocals", filename=path.name, size_bytes=size, duration_s=1
            )
        ],
    )
    return job_id, song_id


def _operation(client, operation_id):
    response = client.get("/api/admin/cache/regenerations")
    assert response.status_code == 200
    return next(
        item for item in response.json() if item["operation_id"] == operation_id
    )


def _identity(job):
    return {
        key: job[key]
        for key in (
            "id",
            "title",
            "source_type",
            "source_value",
            "options",
            "created_at",
        )
    }


def test_selection_preserves_two_owners_history_and_outputs_while_queued(
    client, other_client
):
    audio = tone_wav((440,), 0.3)
    first_owner = client.get("/api/auth/me").json()["id"]
    second_owner = other_client.get("/api/auth/me").json()["id"]
    first, song_id = _completed(
        first_owner, audio, SeparationOptions(extract_vocals=True), b"first output"
    )
    second, same_song = _completed(
        second_owner,
        audio,
        SeparationOptions(extract_vocals=True, pitch_semitones=2),
        b"second output",
    )
    assert same_song == song_id
    clients = (client, other_client)
    ids = (first, second)
    outputs = [
        (config.RESULTS_DIR / str(job_id) / "vocals.mp3").read_bytes() for job_id in ids
    ]
    before = [c.get("/api/jobs").json() for c in clients]
    listing = client.get("/api/admin/cache").json()
    song = next(s for s in listing["songs"] if s["id"] == song_id)
    assert song["regenerable"] is True
    assert song["matched_jobs"] == 2
    assert song["unavailable_reason"] is None
    assert (
        other_client.post(
            "/api/admin/cache/regenerate", json={"ids": [song_id]}
        ).status_code
        == 403
    )
    assert TestClient(app).get("/api/admin/cache/regenerations").status_code == 401
    response = client.post("/api/admin/cache/regenerate", json={"ids": [song_id]})
    assert response.status_code == 200, response.text
    (operation,) = response.json()["operations"]
    assert isinstance(operation["operation_id"], int)
    assert operation["song_id"] == song_id and operation["title"] == song["title"]
    assert operation["status"] == "queued"
    assert operation["completed_jobs"] == 0 and operation["total_jobs"] == 2
    assert operation["error_message"] is None
    assert _operation(client, operation["operation_id"]) == operation
    for c, job_id, history, old in zip(clients, ids, before, outputs, strict=True):
        assert c.get("/api/jobs").json() == history
        assert c.get(f"/api/jobs/{job_id}").json()["status"] == "done"
        assert c.get(f"/api/jobs/{job_id}/results/vocals").content == old
        assert c.get(f"/api/jobs/{job_id}/original").content == audio
    assert client.get(f"/api/jobs/{second}").status_code == 404
    assert other_client.get(f"/api/jobs/{first}").status_code == 404
    assert (
        client.post("/api/admin/cache/regenerate", json={"ids": [song_id]}).status_code
        == 409
    )


def test_preview_unknown_invalid_and_busy_selection_is_atomic(client):
    audio = tone_wav((523,), 0.3)
    owner = client.get("/api/auth/me").json()["id"]
    job_id, song_id = _completed(owner, audio, SeparationOptions(), b"old")
    before_output = client.get(f"/api/jobs/{job_id}/results/vocals").content
    preview_audio = tone_wav((660,), 0.3)
    path = (
        config.DATA_DIR
        / "artifacts"
        / "keys"
        / (hashlib.sha256(preview_audio).hexdigest() + ".bin")
    )
    with cache_catalog.capture() as recorder:
        recorder.bind(preview_audio, "Preview only")
        atomic_write(path, b"preview")
    preview = next(
        s
        for s in client.get("/api/admin/cache").json()["songs"]
        if s["title"] == "Preview only"
    )
    assert preview["regenerable"] is False
    assert preview["matched_jobs"] == 0
    assert preview["unavailable_reason"]
    assert (
        client.post(
            "/api/admin/cache/regenerate", json={"ids": [preview["id"]]}
        ).status_code
        == 409
    )
    assert (
        client.post(
            "/api/admin/cache/regenerate", json={"ids": [song_id, "unknown-song"]}
        ).status_code
        == 404
    )
    assert (
        client.post(
            "/api/admin/cache/regenerate", json={"ids": [song_id, song_id]}
        ).status_code
        == 409
    )
    assert (
        client.post(
            "/api/admin/cache/regenerate",
            json={"jobs": [{"song_id": song_id, "job_id": job_id}]},
        ).status_code
        == 422
    )
    assert (
        client.post("/api/admin/cache/regenerate", json={"ids": [job_id]}).status_code
        == 422
    )
    assert client.get("/api/admin/cache/regenerations").json() == []
    db.insert_job(owner, "upload", "busy.wav", SeparationOptions())
    assert (
        client.post("/api/admin/cache/regenerate", json={"ids": [song_id]}).status_code
        == 409
    )
    assert client.get("/api/admin/cache/regenerations").json() == []
    assert client.get(f"/api/jobs/{job_id}/results/vocals").content == before_output


def test_real_http_worker_reuses_computation_and_replaces_in_place(tmp_path):
    audio = tone_wav((440, 660), 1, channels=2)
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    with server(tmp_path, port, admin=True) as client:
        jobs = [
            finish(
                client,
                client.post(
                    "/api/jobs",
                    files={"file": ("song.wav", audio, "audio/wav")},
                    data=options,
                ),
            )
            for options in (
                {"extract_vocals": "true"},
                {"extract_vocals": "true", "pitch_semitones": "2"},
            )
        ]
        other_audio = tone_wav((330, 550), 1, channels=2)
        other = finish(
            client,
            client.post(
                "/api/jobs",
                files={"file": ("other.wav", other_audio, "audio/wav")},
                data={"extract_vocals": "true"},
            ),
        )
        history = client.get("/api/jobs").json()
        before_trace = trace(tmp_path)
        songs = client.get("/api/admin/cache").json()["songs"]
        song = next(s for s in songs if s["matched_jobs"] == 2)
        other_song = next(s for s in songs if s["matched_jobs"] == 1)
        with sqlite3.connect(tmp_path / "cache-catalog.sqlite") as catalog:
            associations = catalog.execute("""
                WITH RECURSIVE reachable(digest,path) AS (
                    SELECT digest,path FROM paths UNION
                    SELECT reachable.digest,dependencies.child FROM reachable
                    JOIN dependencies ON dependencies.parent=reachable.path
                )
                SELECT songs.id,reachable.path FROM songs JOIN reachable
                ON songs.digest=reachable.digest
            """).fetchall()
        selected_paths = {path for ident, path in associations if ident == song["id"]}
        other_paths = {
            path for ident, path in associations if ident == other_song["id"]
        }
        exclusive = {
            path: (tmp_path / "artifacts" / path).stat().st_ino
            for path in other_paths - selected_paths
            if (tmp_path / "artifacts" / path).is_file()
        }
        assert exclusive, "expected independently attributed other-song cache"
        response = client.post(
            "/api/admin/cache/regenerate", json={"ids": [song["id"]]}
        )
        assert response.status_code == 200, response.text
        (operation,) = response.json()["operations"]
        deadline = time.monotonic() + 30
        while True:
            status = _operation(client, operation["operation_id"])
            assert status["song_id"] == song["id"] and status["total_jobs"] == 2
            if status["status"] in {"done", "failed"}:
                assert status["status"] == "done", status["error_message"]
                assert status["completed_jobs"] == 2
                break
            assert status["status"] in {"queued", "running"}
            assert 0 <= status["completed_jobs"] <= 2
            assert time.monotonic() < deadline
            time.sleep(0.05)
        after = client.get("/api/jobs").json()
        assert [j["id"] for j in after] == [j["id"] for j in history]
        assert [_identity(j) for j in after] == [_identity(j) for j in history]
        assert all(j["status"] == "done" for j in after)
        assert all(
            j["result_revision"] != old["result_revision"]
            if j["id"] != other["id"]
            else j["result_revision"] == old["result_revision"]
            for j, old in zip(after, history, strict=True)
        )
        assert all(
            client.get(f"/api/jobs/{j['id']}/original").content == audio for j in jobs
        )
        delta = trace(tmp_path) - before_trace
        assert delta["stem"] == 1
        assert delta["decode"] == 1 and delta["key"] == 1
        assert all(
            (tmp_path / "artifacts" / path).stat().st_ino == inode
            for path, inode in exclusive.items()
        )


def test_running_and_failure_preserve_previous_success(
    client, other_client, monkeypatch
):
    audio = tone_wav((392,), 0.3)
    owners = [c.get("/api/auth/me").json()["id"] for c in (client, other_client)]
    first, song_id = _completed(
        owners[0], audio, SeparationOptions(extract_vocals=True), b"old first"
    )
    second, _ = _completed(
        owners[1],
        audio,
        SeparationOptions(extract_vocals=True, pitch_semitones=2),
        b"old second",
    )
    old_outputs = [
        (config.RESULTS_DIR / str(job_id) / "vocals.mp3").read_bytes()
        for job_id in (first, second)
    ]
    before = [
        c.get(f"/api/jobs/{job_id}").json()
        for c, job_id in ((client, first), (other_client, second))
    ]
    entered, release = threading.Event(), threading.Event()

    def fail_after_block(*args, **kwargs):
        entered.set()
        assert release.wait(10), "test did not release worker"
        raise RuntimeError("injected processing failure")

    monkeypatch.setattr(queue, "detect_key", lambda *args: None)
    monkeypatch.setattr(queue, "process_source", fail_after_block)
    response = client.post("/api/admin/cache/regenerate", json={"ids": [song_id]})
    assert response.status_code == 200, response.text
    operation = response.json()["operations"][0]
    claimed = db.claim_oldest_queued()
    assert claimed is not None
    errors = []

    def run():
        assert claimed is not None
        try:
            asyncio.run(queue._run_job(claimed))
        except BaseException as exc:
            errors.append(exc)

    worker = threading.Thread(target=run)
    worker.start()
    try:
        assert entered.wait(10), "replacement never entered processing"
        running = _operation(client, operation["operation_id"])
        assert running["status"] == "running"
        assert running["completed_jobs"] == 0 and running["total_jobs"] == 2
        for c, job_id, old in (
            (client, first, old_outputs[0]),
            (other_client, second, old_outputs[1]),
        ):
            assert c.get(f"/api/jobs/{job_id}").json()["status"] == "done"
            assert c.get(f"/api/jobs/{job_id}/results/vocals").content == old
        assert (
            client.post(
                "/api/admin/cache/regenerate", json={"ids": [song_id]}
            ).status_code
            == 409
        )
    finally:
        release.set()
        worker.join(timeout=10)
    assert not worker.is_alive()
    assert not errors
    pending = _operation(client, operation["operation_id"])
    assert pending["status"] == "running"
    assert pending["completed_jobs"] == 0 and pending["total_jobs"] == 2
    for c, job_id, original_job, old in (
        (client, first, before[0], old_outputs[0]),
        (other_client, second, before[1], old_outputs[1]),
    ):
        assert c.get(f"/api/jobs/{job_id}").json() == original_job
        assert c.get(f"/api/jobs/{job_id}/results/vocals").content == old
    monkeypatch.setattr(
        queue,
        "process_source",
        lambda *args: ProcessingResult(audio={"vocals": StemResult(audio, 0.3)}),
    )
    claimed = db.claim_oldest_queued()
    assert claimed is not None
    asyncio.run(queue._run_job(claimed))
    failed = _operation(client, operation["operation_id"])
    assert failed["status"] == "failed"
    assert "injected processing failure" in failed["error_message"]
    assert failed["completed_jobs"] == 1 and failed["total_jobs"] == 2
    after = [
        c.get(f"/api/jobs/{job_id}").json()
        for c, job_id in ((client, first), (other_client, second))
    ]
    assert [_identity(j) for j in after] == [_identity(j) for j in before]
    assert all(j["status"] == "done" for j in after)
    assert (
        sum(
            j["result_revision"] != old["result_revision"]
            for j, old in zip(after, before, strict=True)
        )
        == 1
    )
    outputs = [
        client.get(f"/api/jobs/{first}/results/vocals").content,
        other_client.get(f"/api/jobs/{second}/results/vocals").content,
    ]
    assert (
        sum(value == old for value, old in zip(outputs, old_outputs, strict=True)) == 1
    )
