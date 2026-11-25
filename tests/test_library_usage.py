"""Library usage is owned, durable, and ranked before the history cap."""

import sqlite3
from concurrent.futures import ThreadPoolExecutor

from backend import config, db


def _submit(client, name="track.wav"):
    response = client.post("/api/jobs", files={"file": (name, b"audio", "audio/wav")})
    assert response.status_code == 200
    return response.json()["id"]


def test_usage_is_explicit_owned_and_private(client, other_client):
    job = _submit(client)
    with sqlite3.connect(config.DB_PATH) as conn:
        conn.execute("UPDATE jobs SET internal=1 WHERE id=?", (job,))
    assert client.post(f"/api/jobs/{job}/open").status_code == 404
    with sqlite3.connect(config.DB_PATH) as conn:
        conn.execute("UPDATE jobs SET internal=0 WHERE id=?", (job,))
    assert other_client.post(f"/api/jobs/{job}/open").status_code == 404
    assert client.get(f"/api/jobs/{job}").json()["open_count"] == 0
    assert client.post(f"/api/jobs/{job}/open").json() == {"id": job, "open_count": 1}
    for path in ("/api/jobs", "/api/jobs/current", f"/api/jobs/{job}"):
        assert client.get(path).status_code == 200
        assert client.get(path).status_code == 200
    assert client.get(f"/api/jobs/{job}").json()["open_count"] == 1
    assert client.post(f"/api/jobs/{job}/open").json()["open_count"] == 2
    db.init_db()
    assert client.get(f"/api/jobs/{job}").json()["open_count"] == 2


def test_concurrent_opens_do_not_lose_increments(client):
    job = _submit(client)
    owner = client.get("/api/auth/me").json()["id"]
    with ThreadPoolExecutor(max_workers=8) as pool:
        counts = list(pool.map(lambda _: db.record_job_open(job, owner), range(40)))
    assert sorted(count for count in counts if count is not None) == list(range(1, 41))
    assert client.get(f"/api/jobs/{job}").json()["open_count"] == 40


def test_ranking_precedes_history_limit_and_current_stays_newest(client):
    oldest = _submit(client)
    assert client.post(f"/api/jobs/{oldest}/open").status_code == 200
    with sqlite3.connect(config.DB_PATH) as conn:
        conn.execute("UPDATE jobs SET created_at=1 WHERE id=?", (oldest,))
        conn.executemany(
            "INSERT INTO jobs (session_id,status,source_type,source_value,"
            "options_json,created_at) SELECT session_id,status,source_type,"
            "source_value,options_json,? FROM jobs WHERE id=?",
            [(n, oldest) for n in range(2, 53)],
        )
    popular = client.get("/api/jobs").json()
    added = client.get("/api/jobs?sort=added").json()
    assert len(popular) == len(added) == 50
    assert popular[0]["id"] == oldest and popular[0]["open_count"] == 1
    assert oldest not in [job["id"] for job in added]
    assert [job["created_at"] for job in added] == list(range(52, 2, -1))
    assert client.get("/api/jobs/current").json()["id"] == added[0]["id"]
    assert client.get("/api/jobs?sort=invalid").status_code == 422


def test_current_uses_latest_owned_id_independent_of_library_sort(client):
    older = _submit(client, "older.wav")
    newer = _submit(client, "newer.wav")
    assert client.post(f"/api/jobs/{older}/open").status_code == 200
    with sqlite3.connect(config.DB_PATH) as conn:
        conn.execute("UPDATE jobs SET created_at=200 WHERE id=?", (older,))
        conn.execute("UPDATE jobs SET created_at=100 WHERE id=?", (newer,))
        conn.execute(
            "INSERT INTO jobs (session_id,status,source_type,source_value,"
            "options_json,created_at,internal) SELECT session_id,status,source_type,"
            "source_value,options_json,300,1 FROM jobs WHERE id=?",
            (newer,),
        )
    assert client.get("/api/jobs?sort=usage").json()[0]["id"] == older
    assert client.get("/api/jobs?sort=added").json()[0]["id"] == older
    assert client.get("/api/jobs/current").json()["id"] == newer


def test_migration_preserves_existing_job_and_defaults_usage(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "legacy.sqlite")
    db.init_db()
    with sqlite3.connect(config.DB_PATH) as conn:
        conn.execute("ALTER TABLE jobs DROP COLUMN open_count")
        conn.execute(
            "INSERT INTO jobs (session_id,status,source_type,source_value,"
            "options_json,created_at) "
            "VALUES ('legacy-owner','done','url','https://example.test/track','{}',123)"
        )
    db.init_db()
    job = db.list_jobs_for_session("legacy-owner")[0]
    assert (job.source_value, job.created_at, job.open_count) == (
        "https://example.test/track", 123, 0
    )


