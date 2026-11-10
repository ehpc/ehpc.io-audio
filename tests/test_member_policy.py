"""Administrator quota and privacy-sensitive activity behavior."""

import time
from concurrent.futures import ThreadPoolExecutor

from backend import auth_store, db
from separator.options import SeparationOptions


def test_admin_unlimited_and_member_permissions(client, other_client):
    owner = client.get("/api/auth/me").json()
    member = other_client.get("/api/auth/me").json()
    assert owner["invite_limit"] is None and member["invite_limit"] == 3
    assert all(client.post("/api/auth/invites").status_code == 200 for _ in range(5))
    invites = [other_client.post("/api/auth/invites").json() for _ in range(3)]
    assert other_client.post("/api/auth/invites").status_code == 409
    assert (
        other_client.delete("/api/auth/invites/" + invites[0]["id"]).status_code == 403
    )
    assert other_client.delete("/api/auth/invites/unknown").status_code == 403
    assert (
        other_client.patch(
            "/api/admin/users/" + owner["id"], json={"disabled": True}
        ).status_code
        == 403
    )
    assert (
        client.patch(
            "/api/admin/users/" + owner["id"], json={"invite_limit": 2}
        ).status_code
        == 409
    )
    assert (
        client.post("/api/admin/users/" + owner["id"] + "/invite-slot").status_code
        == 409
    )
    assert client.delete("/api/auth/invites/" + invites[0]["id"]).status_code == 204
    assert other_client.post("/api/auth/invites").status_code == 200


def test_atomic_grants_and_private_activity(client, other_client):
    member = other_client.get("/api/auth/me").json()
    uid = member["id"]
    assert other_client.get(f"/api/admin/users/{uid}/activity").status_code == 403
    assert other_client.post(f"/api/admin/users/{uid}/invite-slot").status_code == 403
    with ThreadPoolExecutor(max_workers=8) as pool:
        values = list(pool.map(lambda _: auth_store.grant_invite_slot(uid), range(8)))
    assert all(v is not None for v in values)
    listed = next(u for u in client.get("/api/admin/users").json() if u["id"] == uid)
    assert listed["invite_limit"] == 11
    assert (
        client.post(f"/api/admin/users/{uid}/invite-slot").json()["invite_limit"] == 12
    )
    assert other_client.post("/api/auth/activity").status_code == 204
    job = db.insert_job(uid, "upload", "personal.wav", SeparationOptions())
    search = other_client.post(
        "/api/song-search", json={"query": "owned music clue"}
    ).json()["search_id"]
    before = client.get(f"/api/admin/users/{uid}/activity").json()
    assert before["registered_at"] is not None and before["last_login_at"] is not None
    assert before["last_activity_at"] is not None
    assert any(j["id"] == job and j["title"] == "personal.wav" for j in before["jobs"])
    assert any(
        s["id"] == search and s["query"] == "owned music clue"
        for s in before["searches"]
    )
    db.finish_song_search(
        search, {"status": "failed", "detail": "fixture"}, 900, query_key="fixture"
    )
    finished = client.get(f"/api/admin/users/{uid}/activity").json()
    assert (
        next(s for s in finished["searches"] if s["id"] == search)["status"] == "failed"
    )
    assert other_client.post("/api/auth/logout").status_code == 204
    after = client.get(f"/api/admin/users/{uid}/activity").json()
    assert after["last_login_at"] == before["last_login_at"]
    assert after["last_activity_at"] >= before["last_activity_at"]
    assert "verifier" not in str(after) and "transcript" not in str(after)


def test_existing_owner_reconciliation_preserves_data(client):
    owner = client.get("/api/auth/me").json()
    invite = client.post("/api/auth/invites").json()
    job_id = db.insert_job(owner["id"], "upload", "kept.wav", SeparationOptions())
    before = db.get_job(job_id)
    with db._session() as conn:
        conn.execute("UPDATE auth_users SET is_admin=0 WHERE id=?", (owner["id"],))
    db.init_db()
    db.init_db()
    assert client.get("/api/auth/me").json()["is_admin"] is True
    assert client.get("/api/auth/me").json()["invite_limit"] is None
    assert db.get_job(job_id) == before
    assert client.get("/api/auth/me").json()["invites"][0]["id"] == invite["id"]


def test_last_activity_is_not_refreshed_by_background_reads(
    client, other_client, monkeypatch
):
    uid = other_client.get("/api/auth/me").json()["id"]
    now = int(time.time())
    monkeypatch.setattr(auth_store.time, "time", lambda: now + 10)
    assert other_client.post("/api/auth/activity").status_code == 204
    observed = client.get(f"/api/admin/users/{uid}/activity").json()["last_activity_at"]
    monkeypatch.setattr(auth_store.time, "time", lambda: now + 100)
    assert other_client.get("/api/jobs").status_code == 200
    assert other_client.get("/api/auth/me").status_code == 200
    assert (
        client.get(f"/api/admin/users/{uid}/activity").json()["last_activity_at"]
        == observed
    )


def test_old_session_activity_is_backfilled_and_survives_logout(client, other_client):
    uid = other_client.get("/api/auth/me").json()["id"]
    with db._session() as conn:
        conn.execute(
            "UPDATE auth_sessions SET last_activity=123456 WHERE user_id=?", (uid,)
        )
        conn.execute("ALTER TABLE auth_users DROP COLUMN last_activity_at")
        conn.execute("ALTER TABLE auth_users DROP COLUMN last_login_at")
    db.init_db()
    activity = client.get(f"/api/admin/users/{uid}/activity").json()
    assert activity["last_activity_at"] == 123456
    assert activity["last_login_at"] is None
    auth_store.revoke_session(other_client.cookies["__Host-auth_session"])
    db.init_db()
    assert (
        client.get(f"/api/admin/users/{uid}/activity").json()["last_activity_at"]
        == 123456
    )
