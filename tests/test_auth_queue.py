"""Concurrent expensive-work queue budgets include both work types."""

from backend import db


def test_pending_search_and_jobs_share_account_queue_cap(client):
    with db._session() as conn:
        conn.execute("INSERT INTO auth_settings VALUES ('user_queue', 2)")
    assert (
        client.post("/api/jobs", data={"url": "https://example.com/a"}).status_code
        == 200
    )
    assert client.post("/api/song-search", json={"query": "a song"}).status_code == 202
    assert (
        client.post("/api/jobs", data={"url": "https://example.com/b"}).status_code
        == 429
    )
    assert (
        client.post("/api/song-search", json={"query": "another song"}).status_code
        == 429
    )
