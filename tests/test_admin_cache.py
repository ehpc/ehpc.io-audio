"""Administrator cache eviction preserves history and durable inference ownership."""

import asyncio
import hashlib
import json
import shutil
import time

import pytest
from audio_samples import tone_wav
from fastapi.testclient import TestClient

from backend import cache_catalog, config, db, drain, modal_client, song_search_worker
from backend.main import CacheAdmission, app
from backend.routes import admin_cache
from separator import audio, song_search
from separator.artifact_cache import atomic_write
from separator.options import SeparationOptions
from separator.pitch import PitchAnalysis, PitchTrack, pitch_to_json
from separator.song_search import SEARCH_RESULT_TTL, SEARCH_TTL, query_cache_key


def artifact(namespace, key, data):
    path = config.DATA_DIR / "artifacts" / namespace / (key + ".bin")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


def associated(audio, path, title):
    data = path.read_bytes()
    with cache_catalog.capture() as recorder:
        recorder.bind(audio, title)
        atomic_write(path, data)
    return next(
        song["id"]
        for song in cache_catalog.snapshot()["songs"]
        if song["title"] == title
    )


def completed_stage(data=b"completed inference"):
    key = "a" * 64
    path = artifact("inference", key, data)
    receipt = config.DATA_DIR / "artifacts" / "inference-requests" / (key + ".json")
    receipt.parent.mkdir(parents=True, exist_ok=True)
    receipt.write_text(
        json.dumps(
            {
                "output_id": "b" * 32,
                "result_sha256": hashlib.sha256(data).hexdigest(),
                "result_size": len(data),
                "cleaned": True,
                "cleanup_pending": False,
            }
        )
    )
    job = db.insert_job("test", "upload", "audio.mp3", SeparationOptions())
    db.mark_done(job, [])
    db.set_active_stage(job, key, "fc-completed")
    return job, key, path, receipt


def failed_stage():
    key = "c" * 64
    output_id = "d" * 32
    diagnostic = (
        config.DATA_DIR / "artifacts" / "inference-diagnostics" / f"{output_id}.log"
    )
    diagnostic.parent.mkdir(parents=True, exist_ok=True)
    diagnostic.write_bytes(b"verified terminal diagnostic")
    job = db.insert_job("test", "upload", "audio.mp3", SeparationOptions())
    db.set_active_stage(job, key, "fc-failed")
    db.mark_failed(job, "Model failed")
    receipt = config.DATA_DIR / "artifacts" / "inference-requests" / f"{key}.json"
    receipt.parent.mkdir(parents=True, exist_ok=True)
    receipt.write_text(
        json.dumps(
            {
                "output_id": output_id,
                "failure_sha256": hashlib.sha256(diagnostic.read_bytes()).hexdigest(),
                "failure_size": diagnostic.stat().st_size,
                "failure_job_id": job,
                "failure_operation": "recognition",
                "cleaned": True,
                "cleanup_pending": False,
            }
        )
    )
    return job, key, receipt, diagnostic


def test_admin_and_request_validation(client, other_client):
    anonymous = TestClient(app, base_url="https://testserver")
    assert anonymous.get("/api/admin/cache").status_code == 401
    assert other_client.get("/api/admin/cache").status_code == 403
    assert (
        other_client.post("/api/admin/cache/clear", json={"all": True}).status_code
        == 403
    )
    assert (
        client.post(
            "/api/admin/cache/clear",
            headers={"origin": "https://evil.test"},
            json={"all": True},
        ).status_code
        == 403
    )
    for body in (
        {},
        {"all": False},
        {"ids": []},
        {"ids": ["x"], "all": True},
        {"all": True, "path": "anything"},
    ):
        assert client.post("/api/admin/cache/clear", json=body).status_code == 422
    assert (
        client.post("/api/admin/cache/clear", json={"ids": ["unknown"]}).status_code
        == 404
    )


def test_selected_clear_and_historical_all_clear(client):
    one = artifact("keys", "1" * 64, b"one")
    two = artifact("keys", "2" * 64, b"two")
    first = associated(b"first original", one, "First")
    associated(b"second original", two, "Second")
    lock = one.with_suffix(".lock")
    lock.write_bytes(b"lock")
    response = client.post("/api/admin/cache/clear", json={"ids": [first]})
    assert response.status_code == 200
    assert response.json() == {"cleared": 1, "reclaimed_bytes": 3}
    assert (
        not one.exists() and two.read_bytes() == b"two" and lock.read_bytes() == b"lock"
    )
    unknown = artifact("keys", "3" * 64, b"legacy")
    listing = client.get("/api/admin/cache").json()
    assert listing["unattributed_bytes"] == 6 and not listing["selective_ready"]
    assert (
        client.post("/api/admin/cache/clear", json={"ids": [first]}).status_code == 409
    )
    response = client.post("/api/admin/cache/clear", json={"all": True})
    assert response.status_code == 200 and response.json()["cleared"] == 2
    assert not two.exists() and not unknown.exists() and lock.exists()


@pytest.mark.skipif(
    not shutil.which("ffmpeg") or not shutil.which("keyfinder-cli"),
    reason="Native audio tools required",
)
@pytest.mark.parametrize("selection", ["one", "multiple", "all"])
def test_selected_clear_recomputes_only_the_selected_real_key_analysis(
    client, monkeypatch, selection
):
    originals = [tone_wav((frequency,), 2) for frequency in (220, 330, 440)]
    calls = {"decode": 0, "key": 0}
    real_decode = audio._decode_key_audio
    real_key = audio._detect_decoded_key

    def decode(*args):
        calls["decode"] += 1
        return real_decode(*args)

    def key(*args):
        calls["key"] += 1
        return real_key(*args)

    monkeypatch.setattr(audio, "_decode_key_audio", decode)
    monkeypatch.setattr(audio, "_detect_decoded_key", key)

    def analyze(index):
        with cache_catalog.capture() as recorder:
            recorder.bind(originals[index], f"Song {index}")
            return audio.detect_key(
                originals[index], "source.wav", config.DATA_DIR / "artifacts"
            )

    first = [analyze(index) for index in range(3)]
    assert calls == {"decode": 3, "key": 3}
    assert [analyze(index) for index in range(3)] == first
    assert calls == {"decode": 3, "key": 3}
    listing = client.get("/api/admin/cache").json()
    assert listing["selective_ready"]
    count = {"one": 1, "multiple": 2, "all": 3}[selection]
    ids = [
        next(
            item["id"] for item in listing["songs"] if item["title"] == f"Song {index}"
        )
        for index in range(count)
    ]
    body = {"all": True} if selection == "all" else {"ids": ids}
    assert client.post("/api/admin/cache/clear", json=body).status_code == 200
    assert [analyze(index) for index in range(3)] == first
    assert calls == {"decode": 3 + count, "key": 3 + count}


def test_playback_stream_remains_active_until_asgi_body_finishes():
    async def scenario():
        entered = asyncio.Event()
        finish = asyncio.Event()

        async def streaming_app(scope, receive, send):
            await send({"type": "http.response.start", "status": 200, "headers": []})
            entered.set()
            await finish.wait()
            await send({"type": "http.response.body", "body": b"audio"})

        async def send(message):
            pass

        scope = {
            "type": "http",
            "method": "GET",
            "scheme": "http",
            "path": "/api/jobs/123/pitch-reference/vocals",
            "query_string": b"playback=1",
            "headers": [],
            "server": ("testserver", 80),
        }
        middleware = CacheAdmission(streaming_app)
        task = asyncio.create_task(middleware(scope, None, send))
        await entered.wait()
        assert drain.state.active == 1
        assert admin_cache._busy()
        finish.set()
        await task
        assert drain.state.active == 0

    asyncio.run(scenario())


def test_busy_and_uncertain_inference_are_preserved(client):
    job, key, path, receipt = completed_stage()
    drain.state.active += 1
    try:
        assert client.get("/api/admin/cache").json()["busy"]
        assert (
            client.post("/api/admin/cache/clear", json={"all": True}).status_code == 409
        )
    finally:
        drain.state.active -= 1
    db.set_active_stage(job, key, None)
    assert client.get("/api/admin/cache").json()["busy"]
    assert client.post("/api/admin/cache/clear", json={"all": True}).status_code == 409
    owner = db.get_job(job)
    assert owner is not None and owner.active_stage_key == key
    assert path.exists() and receipt.exists()


def test_cleaned_terminal_failure_does_not_block_unrelated_cache_clear(
    client, monkeypatch
):
    job, key, receipt, diagnostic = failed_stage()
    saved_receipt = receipt.read_bytes()
    saved_diagnostic = diagnostic.read_bytes()

    def forbidden(*args, **kwargs):
        pytest.fail("Clearing cache must not dispatch model work")

    monkeypatch.setattr(modal_client, "spawn", forbidden)
    first = artifact("keys", "1" * 64, b"first")
    selected = associated(b"first", first, "First")
    assert not client.get("/api/admin/cache").json()["busy"]
    assert (
        client.post("/api/admin/cache/clear", json={"ids": [selected]}).status_code
        == 200
    )
    assert not first.exists()
    second = artifact("keys", "2" * 64, b"second")
    associated(b"second", second, "Second")
    assert client.post("/api/admin/cache/clear", json={"all": True}).status_code == 200
    assert not second.exists()
    owner = db.get_job(job)
    assert owner is not None and owner.status.value == "failed"
    assert (owner.active_stage_key, owner.modal_call_id) == (key, "fc-failed")
    assert receipt.read_bytes() == saved_receipt
    assert diagnostic.read_bytes() == saved_diagnostic


@pytest.mark.parametrize(
    "invalid", ["diagnostic", "job", "pending", "result", "orphan"]
)
def test_invalid_terminal_failure_stays_fail_closed(client, invalid):
    job, key, receipt, diagnostic = failed_stage()
    if invalid == "diagnostic":
        diagnostic.write_bytes(b"tampered diagnostic")
    elif invalid == "job":
        db.mark_done(job, [])
    elif invalid == "pending":
        data = json.loads(receipt.read_text())
        data["cleanup_pending"] = True
        receipt.write_text(json.dumps(data))
    elif invalid == "result":
        inconsistent = artifact("inference", key, b"inconsistent result")
        associated(b"inconsistent", inconsistent, "Inconsistent")
    else:
        with db._session() as connection:
            connection.execute(
                "UPDATE jobs SET active_stage_key=NULL, modal_call_id=NULL WHERE id=?",
                (job,),
            )
    unrelated = artifact("keys", "e" * 64, b"unrelated")
    unrelated_id = associated(b"unrelated", unrelated, "Unrelated")
    assert (
        client.post("/api/admin/cache/clear", json={"ids": [unrelated_id]}).status_code
        == 409
    )
    assert client.post("/api/admin/cache/clear", json={"all": True}).status_code == 409
    owner = db.get_job(job)
    assert owner is not None
    assert owner.active_stage_key == (None if invalid == "orphan" else key)
    assert unrelated.read_bytes() == b"unrelated"
    assert receipt.exists() and diagnostic.exists()


@pytest.mark.parametrize(
    "corruption", ["digest", "size", "pending", "uncleaned", "missing"]
)
def test_incomplete_receipt_never_retires_owner(client, corruption):
    job, key, path, receipt = completed_stage()
    data = json.loads(receipt.read_text())
    if corruption == "digest":
        data["result_sha256"] = "0" * 64
    elif corruption == "size":
        data["result_size"] += 1
    elif corruption == "pending":
        data["cleanup_pending"] = True
    elif corruption == "uncleaned":
        data["cleaned"] = False
    elif corruption == "missing":
        path.unlink()
    receipt.write_text(json.dumps(data))
    assert client.post("/api/admin/cache/clear", json={"all": True}).status_code == 409
    owner = db.get_job(job)
    assert owner is not None
    assert (owner.active_stage_key, owner.modal_call_id) == (key, "fc-completed")
    assert receipt.exists()


def test_completed_retirement_and_allowlist(client):
    job, _key, path, receipt = completed_stage()
    original = config.UPLOADS_DIR / str(job) / "original.mp3"
    public = config.RESULTS_DIR / str(job) / "vocals.mp3"
    for target in (original, public):
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b"keep")
    lock = path.with_suffix(".lock")
    lock.write_bytes(b"lock")
    receipt_size = receipt.stat().st_size
    response = client.post("/api/admin/cache/clear", json={"all": True})
    assert response.status_code == 200
    assert response.json() == {
        "cleared": 1,
        "reclaimed_bytes": len(b"completed inference") + receipt_size,
    }
    owner = db.get_job(job)
    assert owner is not None
    assert (
        owner.status.value == "done"
        and owner.active_stage_key is None
        and owner.modal_call_id is None
    )
    assert not path.exists() and not receipt.exists()
    assert original.read_bytes() == public.read_bytes() == b"keep" and lock.exists()


def test_listing_does_not_rehash_completed_inference_but_clear_verifies_it(
    client, monkeypatch
):
    _, _, path, receipt = completed_stage()
    real_digest = hashlib.file_digest
    calls = []

    def counted(source, algorithm):
        calls.append(source.name)
        return real_digest(source, algorithm)

    monkeypatch.setattr(admin_cache.hashlib, "file_digest", counted)
    assert client.get("/api/admin/cache").status_code == 200
    assert not calls
    assert client.post("/api/admin/cache/clear", json={"all": True}).status_code == 200
    assert calls
    assert not path.exists() and not receipt.exists()


@pytest.mark.parametrize("failed_family", ["inference-requests", "inference"])
def test_interrupted_clear_keeps_valid_state_and_resumes_safely(
    client, monkeypatch, failed_family
):
    job, _key, artifact_path, receipt = completed_stage()
    real_unlink = admin_cache.File.unlink

    def fail_once(file):
        if file.relative.startswith(failed_family + "/"):
            raise OSError("synthetic storage failure")
        return real_unlink(file)

    monkeypatch.setattr(admin_cache.File, "unlink", fail_once)
    assert client.post("/api/admin/cache/clear", json={"all": True}).status_code == 409
    owner = db.get_job(job)
    assert owner is not None
    assert owner.active_stage_key is None and owner.modal_call_id is None
    assert artifact_path.exists()
    assert receipt.exists() == (failed_family == "inference-requests")
    monkeypatch.setattr(admin_cache.File, "unlink", real_unlink)
    assert client.post("/api/admin/cache/clear", json={"all": True}).status_code == 200
    assert not artifact_path.exists() and not receipt.exists()
    owner = db.get_job(job)
    assert owner is not None and owner.status.value == "done"


def test_symlinked_receipt_fails_closed(client, tmp_path):
    job, key, path, receipt = completed_stage()
    outside = tmp_path / "outside"
    outside.write_bytes(receipt.read_bytes())
    receipt.unlink()
    receipt.symlink_to(outside)
    assert client.post("/api/admin/cache/clear", json={"all": True}).status_code == 409
    owner = db.get_job(job)
    assert owner is not None
    assert outside.exists() and path.exists() and owner.active_stage_key == key


def test_all_invalidates_search_reuse_without_destroying_handle(client, monkeypatch):
    query = "a remembered song"
    result = {
        "status": "done",
        "songs": [
            {
                "title": "Song",
                "artists": ["Artist"],
                "url": "https://music.youtube.com/watch?v=bbbbbbbbbbb",
                "duration_seconds": 120,
                "thumbnail_url": None,
                "play_count": None,
                "play_count_approximate": False,
            }
        ],
    }
    owner = client.get("/api/auth/me").json()["id"]
    key = query_cache_key(query)
    db.create_song_search("old", owner, key, result=result, successful_at=time.time())
    assert db.get_cached_song_search(key, SEARCH_RESULT_TTL) is not None
    assert client.post("/api/admin/cache/clear", json={"all": True}).status_code == 200
    assert db.get_cached_song_search(key, SEARCH_RESULT_TTL) is None
    search = db.get_song_search("old", owner, SEARCH_TTL)
    assert search is not None
    assert json.loads(search["result_json"]) == result
    calls = []
    monkeypatch.setattr(
        song_search_worker, "run_search", lambda q, root: calls.append(q) or result
    )
    start = client.post("/api/song-search", json={"query": query})
    assert start.status_code == 202
    assert asyncio.run(song_search_worker.run_next_search())
    assert calls == [query]
    assert client.get("/api/song-search/" + start.json()["search_id"]).json() == result


def test_all_clear_invalidates_actual_song_search_artifact_cache(client):
    rows = song_search.catalog_candidates(
        [
            {
                "resultType": "song",
                "videoId": "bbbbbbbbbbb",
                "title": "Desired song",
                "artists": [{"name": "Desired artist"}],
                "duration_seconds": 214,
            }
        ]
    )
    completions = []

    def complete(messages):
        completions.append(messages)
        if len(completions) % 2:
            return '{"search":"Desired artist Desired song"}'
        return '{"status":"match","video_ids":["bbbbbbbbbbb"]}'

    def discover():
        return song_search.discover(
            "Desired artist Desired song",
            config.DATA_DIR / "artifacts" / "song-search" / "results",
            complete,
            lambda query: rows,
        )

    first = discover()
    assert first[0]["title"] == "Desired song"
    assert discover() == first
    assert len(completions) == 2
    assert client.post("/api/admin/cache/clear", json={"all": True}).status_code == 200
    assert discover() == first
    assert len(completions) == 4


def test_all_clear_preserves_private_vocal_reference_and_public_results(client):
    owner = client.get("/api/auth/me").json()["id"]
    job = db.insert_job(owner, "upload", "original.mp3", SeparationOptions())
    pitch = pitch_to_json(PitchAnalysis(1, 1, [PitchTrack("vocals", [])]))
    db.mark_done(job, [], pitch_json=pitch)
    directory = config.RESULTS_DIR / str(job)
    directory.mkdir(parents=True, exist_ok=True)
    private = directory / ".pitch-vocals.mp3"
    public = directory / "vocals.mp3"
    lock = directory / ".pitch-vocals.lock"
    for path in (private, public, lock):
        path.write_bytes(b"audio")
    url = f"/api/jobs/{job}/pitch-reference/vocals"
    assert client.get(url).content == b"audio"
    response = client.post("/api/admin/cache/clear", json={"all": True})
    assert response.status_code == 200
    assert private.read_bytes() == public.read_bytes() == lock.read_bytes() == b"audio"
    assert client.get(url).content == b"audio"
    assert client.get(f"/api/jobs/{job}").json()["status"] == "done"


def test_unsafe_cache_symlink_refuses_all_clear(client, tmp_path):
    path = artifact("keys", "a" * 64, b"untouched")
    target = tmp_path / "outside"
    target.write_bytes(b"outside")
    unsafe = path.with_name("b" * 64 + ".bin")
    unsafe.symlink_to(target)
    listing = client.get("/api/admin/cache")
    assert listing.status_code == 200 and listing.json()["unsafe"]
    assert client.post("/api/admin/cache/clear", json={"all": True}).status_code == 409
    assert path.read_bytes() == b"untouched" and target.read_bytes() == b"outside"


def test_pending_search_blocks_clear(client):
    db.create_song_search("pending", "test", "query", pending_query="test")
    response = client.post("/api/admin/cache/clear", json={"all": True})
    assert response.status_code == 409 and "search" in response.json()["detail"]
