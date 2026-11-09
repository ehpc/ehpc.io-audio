"""Browser cookie, private HTTP and administrator recovery boundaries."""

import sys
import time

from fastapi.testclient import TestClient

from backend import auth_admin, auth_store, config, mailer
from backend.main import app


def test_secure_host_cookie_rejects_legacy_shadow(monkeypatch):
    captured = {}
    monkeypatch.setattr(
        mailer, "send_code", lambda email, code: captured.update(code=code)
    )
    _, invite = auth_store.create_invite(None)
    browser = TestClient(
        app, base_url="https://testserver", headers={"origin": "https://testserver"}
    )
    body = {"email": "cookie@example.com", "invite_code": invite}
    assert browser.post("/api/auth/start", json=body).status_code == 202
    response = browser.post("/api/auth/verify", json={**body, "code": captured["code"]})
    cookie = response.headers["set-cookie"]
    assert cookie.startswith("__Host-auth_session=")
    assert "Secure" in cookie and "HttpOnly" in cookie and "Path=/" in cookie
    assert "Domain=" not in cookie and "SameSite=lax" in cookie
    token = browser.cookies.get("__Host-auth_session")
    anonymous = TestClient(
        app, base_url="https://testserver", cookies={"auth_session": token}
    )
    assert anonymous.get("/api/auth/me").status_code == 401


def test_all_private_routes_reject_anonymous_before_upload_processing(monkeypatch):
    browser = TestClient(
        app, base_url="https://testserver", headers={"origin": "https://testserver"}
    )
    paths = [
        "/api/jobs",
        "/api/jobs/current",
        "/api/jobs/1",
        "/api/jobs/1/events",
        "/api/jobs/1/original",
        "/api/jobs/1/results/vocals",
        "/api/jobs/1/pitch-reference/vocals",
        "/api/jobs/1/lyrics",
        "/api/jobs/1/lyrics/download",
        "/api/jobs/1/lyrics/download.json",
        "/api/jobs/1/pitch",
        "/api/jobs/1/pitched-lyrics/vocals/download",
        "/api/song-search/one",
        "/api/status",
        "/api/auth/me",
        "/api/admin/users",
    ]
    for path in paths:
        assert browser.get(path, headers={"range": "bytes=0-10"}).status_code == 401
    for path in [
        "/api/jobs/1/original",
        "/api/jobs/1/pitch-reference/vocals",
        "/api/jobs/1/results/vocals",
    ]:
        assert browser.head(path, headers={"range": "bytes=0-10"}).status_code == 401
    assert (
        browser.patch("/api/admin/users/unknown", json={"disabled": True}).status_code
        == 401
    )
    assert browser.delete("/api/auth/invites/unknown").status_code == 401
    assert browser.post("/api/admin/users/unknown/revoke-sessions").status_code == 401
    assert browser.post("/api/auth/activity").status_code == 401
    assert browser.post("/api/auth/logout").status_code == 401
    assert browser.post("/api/auth/invites").status_code == 401
    for path in [
        "/api/jobs",
        "/api/key-analysis",
        "/api/song-search",
        "/api/jobs/1/retry",
        "/api/jobs/1/pitch-reference/vocals",
    ]:
        # Deliberately malformed multipart would fail parsing if the route ran.
        response = browser.post(
            path,
            content=b"broken",
            headers={"content-type": "multipart/form-data; boundary=missing"},
        )
        assert response.status_code == 401


def test_polling_does_not_extend_idle_session(client, monkeypatch):
    now = int(time.time())
    monkeypatch.setattr(auth_store.time, "time", lambda: now)
    assert client.post("/api/auth/activity").status_code == 204
    monkeypatch.setattr(
        auth_store.time, "time", lambda: now + auth_store.SESSION_IDLE - 1
    )
    for path in ["/api/auth/me", "/api/jobs", "/api/jobs/current", "/api/status"]:
        assert client.get(path).status_code == 200
    monkeypatch.setattr(auth_store.time, "time", lambda: now + auth_store.SESSION_IDLE)
    assert client.get("/api/jobs").status_code == 401


def test_operator_can_reenable_self_disabled_admin(client, monkeypatch):
    admin_id = client.get("/api/auth/me").json()["id"]
    assert (
        client.patch(
            "/api/admin/users/" + admin_id, json={"disabled": True}
        ).status_code
        == 200
    )
    assert client.get("/api/auth/me").status_code == 401
    monkeypatch.setattr(sys, "argv", ["auth_admin", "enable", admin_id])
    auth_admin.main()
    assert client.get("/api/auth/me").status_code == 401  # old sessions remain revoked
    assert (
        next(u for u in auth_store.users() if u["id"] == admin_id)["disabled"] is False
    )
    now = int(time.time())
    monkeypatch.setattr(auth_store.time, "time", lambda: now + 61)
    codes = {}
    monkeypatch.setattr(
        mailer, "send_code", lambda email, code: codes.update({email: code})
    )
    email = config.AUTH_ADMIN_EMAIL
    assert client.post("/api/auth/start", json={"email": email}).status_code == 202
    assert (
        client.post(
            "/api/auth/verify", json={"email": email, "code": codes[email]}
        ).status_code
        == 200
    )
    assert client.get("/api/auth/me").json()["is_admin"] is True
