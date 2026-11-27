"""Song library usage is owned, durable, and ranked before the history cap."""

import sqlite3
from concurrent.futures import ThreadPoolExecutor

from backend import config, db
from separator.options import SeparationOptions


def _submit(client, url="https://example.test/track"):
    response = client.post("/api/jobs", data={"url": url})
    assert response.status_code == 200
    return response.json()["song_id"]


def test_usage_is_explicit_owned_and_private(client, other_client):
    song = _submit(client)
    assert other_client.post(f"/api/songs/{song}/open").status_code == 404
    summary = client.get(f"/api/songs/{song}").json()["summary"]
    assert summary["open_count"] == 0
    assert client.post(f"/api/songs/{song}/open").json() == {
        "id": song,
        "open_count": 1,
    }
    assert client.get(f"/api/songs/{song}").json()["summary"]["open_count"] == 1
    assert client.post(f"/api/songs/{song}/open").json()["open_count"] == 2
    db.init_db()
    assert client.get(f"/api/songs/{song}").json()["summary"]["open_count"] == 2


def test_concurrent_opens_do_not_lose_increments(client):
    song = _submit(client)
    owner = client.get("/api/auth/me").json()["id"]
    with ThreadPoolExecutor(max_workers=8) as pool:
        counts = list(pool.map(lambda _: db.record_song_open(song, owner), range(40)))
    assert sorted(count for count in counts if count is not None) == list(range(1, 41))
    assert client.get(f"/api/songs/{song}").json()["summary"]["open_count"] == 40


def test_ranking_precedes_history_limit_and_current_stays_newest(client):
    owner = client.get("/api/auth/me").json()["id"]
    songs = []
    for n in range(51):
        submitted = db.insert_job(
            owner, "url", f"https://example.test/track-{n}", SeparationOptions()
        )
        assert submitted.work_id is not None
        songs.append(submitted.song_id)
        db.mark_failed(submitted.work_id, "ranking fixture")
    oldest = songs[0]
    assert client.post(f"/api/songs/{oldest}/open").status_code == 200
    with sqlite3.connect(config.DB_PATH) as conn:
        conn.execute(
            "UPDATE jobs SET created_at=1 WHERE id=(SELECT job_id "
            "FROM library_song_jobs WHERE song_id=?)",
            (oldest,),
        )
    popular = client.get("/api/songs").json()
    added = client.get("/api/songs?sort=added").json()
    assert len(popular) == len(added) == 50
    assert popular[0]["id"] == oldest and popular[0]["open_count"] == 1
    assert oldest not in [song["id"] for song in added]
    assert client.get("/api/songs/current").json()["id"] == songs[-1]
    assert client.get("/api/songs?sort=invalid").status_code == 422


def test_current_uses_latest_song_independent_of_library_sort(client):
    older = _submit(client, "https://example.test/older")
    newer = _submit(client, "https://example.test/newer")
    assert client.post(f"/api/songs/{older}/open").status_code == 200
    assert client.get("/api/songs?sort=usage").json()[0]["id"] == older
    assert client.get("/api/songs?sort=added").json()[0]["id"] == newer
    assert client.get("/api/songs/current").json()["id"] == newer


def test_new_library_songs_default_usage_to_zero(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "library.sqlite")
    db.init_db()
    with sqlite3.connect(config.DB_PATH) as conn:
        conn.execute("INSERT INTO library_songs (session_id) VALUES ('owner')")
        row = conn.execute(
            "SELECT open_count FROM library_songs WHERE session_id='owner'"
        ).fetchone()
    assert row == (0,)
