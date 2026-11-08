import asyncio
import json
import sqlite3
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import pytest

from backend import config, db, song_search_worker
from separator.song_search import SEARCH_TTL, query_cache_key

RESULT = {
    "status": "done",
    "songs": [
        {
            "title": "Owned test song",
            "artists": ["Owned test artist"],
            "url": "https://music.youtube.com/watch?v=bbbbbbbbbbb",
            "duration_seconds": 120,
            "thumbnail_url": None,
            "play_count": None,
            "play_count_approximate": False,
        }
    ],
}
LEGACY_COLUMNS = (
    "rowid, id, session_id, modal_call_id, result_json, created_at, "
    "query_key, successful_at"
)


@pytest.fixture
def legacy_database(client):
    job_id = client.post(
        "/api/jobs", data={"url": "https://example.com/owned-history"}
    ).json()["id"]
    now = int(time.time())
    with sqlite3.connect(config.DB_PATH) as conn:
        conn.execute("DROP INDEX IF EXISTS idx_jobs_active_stage_key")
        conn.execute("ALTER TABLE jobs DROP COLUMN active_stage_key")
        jobs = conn.execute("SELECT * FROM jobs").fetchall()
        conn.execute("DROP TABLE song_searches")
        conn.execute(
            "CREATE TABLE song_searches (id TEXT PRIMARY KEY, session_id TEXT NOT NULL,"
            " modal_call_id TEXT NOT NULL, result_json TEXT,"
            " created_at INTEGER NOT NULL, query_key TEXT, successful_at REAL)"
        )
        conn.execute(
            "CREATE INDEX idx_song_search_query_success "
            "ON song_searches(query_key, successful_at DESC)"
        )
        conn.executemany(
            f"INSERT INTO song_searches ({LEGACY_COLUMNS}) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [
                (
                    number * 2 + 1,
                    f"legacy-{number}",
                    "historical-owner",
                    f"fc-historical-{number}",
                    json.dumps(RESULT, indent=2) if number < 13 else None,
                    now - (1000 if number == 13 else 10),
                    query_cache_key("owned cached query") if number < 13 else None,
                    now - 5.5 if number < 13 else None,
                )
                for number in range(14)
            ],
        )
        searches = conn.execute(
            f"SELECT {LEGACY_COLUMNS} FROM song_searches ORDER BY rowid"
        ).fetchall()
    return {"jobs": jobs, "searches": searches, "job_id": job_id}


def test_local_migration_keeps_historical_rows_cache_and_jobs(legacy_database, client):
    db.init_db()
    db.init_db()
    db.recover_song_searches(SEARCH_TTL)
    with sqlite3.connect(config.DB_PATH) as conn:
        assert (
            conn.execute(
                f"SELECT {LEGACY_COLUMNS} FROM song_searches ORDER BY rowid"
            ).fetchall()
            == legacy_database["searches"]
        )
        assert [row[:-1] for row in conn.execute("SELECT * FROM jobs").fetchall()] == (
            legacy_database["jobs"]
        )
        assert (
            conn.execute(
                "SELECT pending_query, claimed_at FROM song_searches"
            ).fetchall()
            == [(None, None)] * 14
        )
    assert db.claim_song_search(SEARCH_TTL) is None
    response = client.post("/api/song-search", json={"query": "owned cached query"})
    assert response.status_code == 202
    path = "/api/song-search/" + response.json()["search_id"]
    assert client.get(path).json() == RESULT
    assert db.claim_song_search(SEARCH_TTL) is None
    assert client.get(f"/api/jobs/{legacy_database['job_id']}").status_code == 200


def test_failed_schema_migration_rolls_back_without_losing_old_rows(
    legacy_database, monkeypatch
):
    migrate = db._migrate

    def interrupted(conn):
        migrate(conn)
        raise RuntimeError("owned migration interruption")

    monkeypatch.setattr(db, "_migrate", interrupted)
    with pytest.raises(RuntimeError):
        db.init_db()
    with sqlite3.connect(config.DB_PATH) as conn:
        assert (
            conn.execute(
                f"SELECT {LEGACY_COLUMNS} FROM song_searches ORDER BY rowid"
            ).fetchall()
            == legacy_database["searches"]
        )
        assert conn.execute("SELECT * FROM jobs").fetchall() == legacy_database["jobs"]
        columns = {
            row[1]: row for row in conn.execute("PRAGMA table_info(song_searches)")
        }
        assert columns["modal_call_id"][3] == 1
        assert "pending_query" not in columns
    monkeypatch.setattr(db, "_migrate", migrate)
    db.init_db()
    db.create_song_search("local", "owner", "key", pending_query="owned local clue")
    claimed = db.claim_song_search(SEARCH_TTL)
    assert claimed is not None and claimed["id"] == "local"


@pytest.mark.parametrize("dispatch_recorded", [False, True])
def test_job_claims_are_exclusive_and_stage_pair_survives_restart(
    client, dispatch_recorded
):
    ids = {
        client.post("/api/jobs", data={"url": f"https://example.com/song-{i}"}).json()[
            "id"
        ]
        for i in range(8)
    }
    with ThreadPoolExecutor(max_workers=8) as pool:
        jobs = list(pool.map(lambda _: db.claim_oldest_queued(), range(16)))
    claimed = [job for job in jobs if job is not None]
    assert len(claimed) == len(ids)
    assert {job.id for job in claimed} == ids
    for job in claimed:
        db.set_active_stage(job.id, "previous-" + str(job.id), f"fc-old-{job.id}")
        call_id = f"fc-{job.id}" if dispatch_recorded else None
        db.set_active_stage(job.id, f"stage-{job.id}", call_id)
    db.init_db()
    db.reap_running_to_queued()
    for _ in claimed:
        resumed = db.claim_oldest_queued()
        assert resumed is not None
        assert resumed.active_stage_key == f"stage-{resumed.id}"
        assert resumed.modal_call_id == (
            f"fc-{resumed.id}" if dispatch_recorded else None
        )
    assert db.claim_oldest_queued() is None


def test_search_lifespan_recovers_claim_and_drains_thread_before_stopping(monkeypatch):
    started = threading.Event()
    release = threading.Event()
    calls = []

    def blocked_provider(query, cache_root):
        calls.append(query)
        started.set()
        assert release.wait(5)
        return RESULT

    monkeypatch.setattr(song_search_worker, "run_search", blocked_provider)
    monkeypatch.setattr(config, "QUEUE_POLL_INTERVAL_S", 0.01)
    db.create_song_search("first", "owner", "key1", pending_query="first clue")
    claimed = db.claim_song_search(SEARCH_TTL)
    assert claimed is not None and claimed["id"] == "first"
    db.create_song_search("second", "owner", "key2", pending_query="second clue")

    async def exercise():
        stop = asyncio.Event()

        async def service():
            async with song_search_worker.lifespan():
                await stop.wait()

        task = asyncio.create_task(service())
        try:
            assert await asyncio.to_thread(started.wait, 5)
            stop.set()
            await asyncio.sleep(0.02)
            assert not task.done()
        finally:
            release.set()
            stop.set()
            await asyncio.wait_for(task, timeout=5)

    asyncio.run(exercise())
    assert len(calls) == 1
    completed = db.get_song_search("first", "owner", SEARCH_TTL)
    assert completed is not None
    assert json.loads(completed["result_json"]) == RESULT
    queued = db.claim_song_search(SEARCH_TTL)
    assert queued is not None and queued["id"] == "second"


def test_slow_discovery_does_not_hold_post_or_other_http_requests(
    worker_client, monkeypatch
):
    started = threading.Event()
    release = threading.Event()

    def blocked_provider(query, cache_root):
        started.set()
        assert release.wait(5)
        return RESULT

    monkeypatch.setattr(song_search_worker, "run_search", blocked_provider)
    try:
        response = worker_client.post("/api/song-search", json={"query": "owned clue"})
        assert response.status_code == 202
        assert started.wait(5)
        path = "/api/song-search/" + response.json()["search_id"]
        assert worker_client.get(path).json() == {"status": "pending"}
        assert worker_client.get("/api/jobs").json() == []
    finally:
        release.set()
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        result = worker_client.get(path).json()
        if result.get("status") == "done":
            break
        time.sleep(0.01)
    assert result == RESULT


def test_rebuild_preserves_custom_unique_constraint_and_insert_trigger(legacy_database):
    with sqlite3.connect(config.DB_PATH) as conn:
        conn.execute(
            "CREATE UNIQUE INDEX owned_unique_search_call "
            "ON song_searches(modal_call_id)"
        )
        conn.execute("CREATE TABLE owned_search_audit (search_id TEXT)")
        conn.execute(
            "CREATE TRIGGER owned_search_insert AFTER INSERT ON song_searches "
            "BEGIN INSERT INTO owned_search_audit VALUES (NEW.id); END"
        )
    try:
        db.init_db()
        db.init_db()
        with sqlite3.connect(config.DB_PATH) as conn:
            assert (
                conn.execute(
                    f"SELECT {LEGACY_COLUMNS} FROM song_searches ORDER BY rowid"
                ).fetchall()
                == legacy_database["searches"]
            )
            # Copying historical rows during rebuild must not replay insert effects.
            assert conn.execute("SELECT * FROM owned_search_audit").fetchall() == []
            with pytest.raises(sqlite3.IntegrityError):
                conn.execute(
                    "INSERT INTO song_searches "
                    "(id, session_id, modal_call_id, created_at) VALUES (?, ?, ?, ?)",
                    ("duplicate-call", "owner", "fc-historical-0", int(time.time())),
                )
        db.create_song_search(
            "local-after-migration", "owner", "key", pending_query="owned local clue"
        )
        with sqlite3.connect(config.DB_PATH) as conn:
            assert conn.execute("SELECT * FROM owned_search_audit").fetchall() == [
                ("local-after-migration",)
            ]
            assert (
                conn.execute(
                    f"SELECT {LEGACY_COLUMNS} FROM song_searches "
                    "WHERE id LIKE 'legacy-%' ORDER BY rowid"
                ).fetchall()
                == legacy_database["searches"]
            )
    finally:
        with sqlite3.connect(config.DB_PATH) as conn:
            conn.execute("DROP TRIGGER IF EXISTS owned_search_insert")
            conn.execute("DROP INDEX IF EXISTS owned_unique_search_call")
            conn.execute("DROP TABLE IF EXISTS owned_search_audit")


def test_global_stage_claim_keeps_failed_uncertain_owner_across_new_jobs(client):
    ids = [
        client.post("/api/jobs", data={"url": f"https://example.com/song-{i}"}).json()[
            "id"
        ]
        for i in range(8)
    ]
    with ThreadPoolExecutor(max_workers=8) as pool:
        claims = list(
            pool.map(
                lambda job_id: db.claim_inference_stage(job_id, "shared-stage"), ids
            )
        )
    fresh = [claim for claim in claims if claim.newly_claimed]
    assert len(fresh) == 1
    owner = fresh[0].owner
    assert {claim.owner.id for claim in claims} == {owner.id}
    assert all(claim.owner.modal_call_id is None for claim in claims)
    db.mark_failed(owner.id, "Dispatch outcome unknown.")
    db.init_db()
    db.reap_running_to_queued()
    new_job = client.post(
        "/api/jobs", data={"url": "https://example.com/new-job-same-input"}
    ).json()["id"]
    uncertain = db.claim_inference_stage(new_job, "shared-stage")
    assert not uncertain.newly_claimed
    assert uncertain.owner.id == owner.id
    assert uncertain.owner.modal_call_id is None
    assert uncertain.owner.status.value == "failed"
    db.set_active_stage(owner.id, "shared-stage", "fc-verified-owned-call")
    assert not db.release_inference_stage(owner.id, "shared-stage")
    resumed = db.claim_inference_stage(new_job, "shared-stage")
    assert not resumed.newly_claimed
    assert resumed.owner.id == owner.id
    assert resumed.owner.modal_call_id == "fc-verified-owned-call"


def test_verified_undispatched_release_preserves_history_and_allows_new_owner(client):
    first = client.post(
        "/api/jobs", data={"url": "https://example.com/first-attempt"}
    ).json()["id"]
    second = client.post(
        "/api/jobs", data={"url": "https://example.com/later-attempt"}
    ).json()["id"]
    assert db.claim_inference_stage(first, "owned-stage").newly_claimed
    db.mark_failed(first, "Dispatch outcome unknown.")
    before = db.get_job(first)
    assert before is not None
    assert not db.release_inference_stage(second, "owned-stage")
    assert not db.release_inference_stage(first, "different-stage")
    assert not db.claim_inference_stage(second, "owned-stage").newly_claimed
    assert db.release_inference_stage(first, "owned-stage")
    after = db.get_job(first)
    assert after is not None
    assert after.status == before.status
    assert after.error_message == before.error_message
    assert after.finished_at == before.finished_at
    assert after.modal_call_id is None
    assert after.active_stage_key is None
    claimed = db.claim_inference_stage(second, "owned-stage")
    assert claimed.newly_claimed
    assert claimed.owner.id == second


def test_search_stop_signal_prevents_new_claims_before_other_workers_finish(
    monkeypatch,
):
    started = threading.Event()
    release = threading.Event()
    calls = []

    def blocked_provider(query, cache_root):
        calls.append(query)
        started.set()
        assert release.wait(5)
        return RESULT

    monkeypatch.setattr(song_search_worker, "run_search", blocked_provider)
    db.create_song_search("first", "owner", "key1", pending_query="first clue")
    db.create_song_search("second", "owner", "key2", pending_query="second clue")

    async def exercise():
        stopped = asyncio.Event()
        original_worker = song_search_worker._worker

        async def observe_worker(stop):
            try:
                await original_worker(stop)
            finally:
                stopped.set()

        monkeypatch.setattr(song_search_worker, "_worker", observe_worker)
        async with song_search_worker.lifespan() as stop_search:
            try:
                assert await asyncio.to_thread(started.wait, 5)
                stop_search.set()
                release.set()
                await asyncio.wait_for(stopped.wait(), timeout=5)
                # The context is still open (another worker could still be draining),
                # but discovery has finished its current request and stopped claiming.
                assert len(calls) == 1
                first = db.get_song_search("first", "owner", SEARCH_TTL)
                second = db.get_song_search("second", "owner", SEARCH_TTL)
                assert first is not None and json.loads(first["result_json"]) == RESULT
                assert second is not None and second["result_json"] is None
            finally:
                release.set()

    asyncio.run(exercise())
