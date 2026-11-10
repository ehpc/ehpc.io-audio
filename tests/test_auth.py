"""Consumer-level authentication, ownership, and operator regressions."""

import concurrent.futures
import hashlib
import socketserver
import sqlite3
import threading
import time
from email import message_from_bytes

from fastapi.testclient import TestClient

from backend import auth_store, config, db, mailer
from backend.main import app
from separator.options import SeparationOptions


def browser() -> TestClient:
    return TestClient(
        app, base_url="https://testserver", headers={"origin": "https://testserver"}
    )


def test_invite_registration_profile_and_slots(client, other_client, monkeypatch):
    codes = {}
    monkeypatch.setattr(
        mailer, "send_code", lambda email, code: codes.__setitem__(email, code)
    )
    owner = other_client.get("/api/auth/me").json()
    assert not owner["is_admin"] and owner["invite_limit"] == 3
    invites = [other_client.post("/api/auth/invites").json() for _ in range(3)]
    assert other_client.post("/api/auth/invites").status_code == 409
    listed = other_client.get("/api/auth/me").json()["invites"]
    assert {i["code"] for i in listed} == {i["code"] for i in invites}
    other = browser()
    args = {"email": "new@example.com", "invite_code": invites[0]["code"]}
    assert other.post("/api/auth/start", json=args).status_code == 202
    assert (
        other.post(
            "/api/auth/verify", json={**args, "code": codes[args["email"]]}
        ).status_code
        == 200
    )
    activated = next(
        i
        for i in other_client.get("/api/auth/me").json()["invites"]
        if i["id"] == invites[0]["id"]
    )
    assert (
        activated["status"] == "activated"
        and activated["recipient_email"] == args["email"]
    )
    assert activated["activated_at"] and activated["code"] is None
    assert (
        other_client.delete("/api/auth/invites/" + invites[0]["id"]).status_code == 403
    )
    assert client.delete("/api/auth/invites/" + invites[0]["id"]).status_code == 404
    assert (
        other_client.delete("/api/auth/invites/" + invites[1]["id"]).status_code == 403
    )
    assert client.delete("/api/auth/invites/" + invites[1]["id"]).status_code == 204
    assert other_client.post("/api/auth/invites").status_code == 200
    assert other.get("/api/auth/me").json()["invites"] == []
    assert other.get("/api/admin/users").status_code == 403


def test_single_use_race_and_attempt_limit(monkeypatch):
    now = int(time.time())
    monkeypatch.setattr(auth_store.time, "time", lambda: now)
    _, invite = auth_store.create_invite(None)
    one = auth_store.start("one@example.com", invite, "1.2.3.4")
    two = auth_store.start("two@example.com", invite, "1.2.3.5")
    assert one and two
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        results = list(
            pool.map(
                lambda v: auth_store.verify(v[0], v[1], invite),
                [("one@example.com", one[1]), ("two@example.com", two[1])],
            )
        )
    assert sum(r is not None for r in results) == 1
    _, invite2 = auth_store.create_invite(None)
    challenge = auth_store.start("three@example.com", invite2, "1.2.3.6")
    assert challenge
    wrong = "000000" if challenge[1] != "000000" else "000001"
    for _ in range(5):
        assert auth_store.verify("three@example.com", wrong, invite2) is None
    assert auth_store.verify("three@example.com", challenge[1], invite2) is None
    assert auth_store.start("three@example.com", invite2, "1.2.3.6") is None
    monkeypatch.setattr(auth_store.time, "time", lambda: now + 61)
    challenge = auth_store.start("three@example.com", invite2, "1.2.3.6")
    assert challenge
    monkeypatch.setattr(auth_store.time, "time", lambda: now + 662)
    assert auth_store.verify("three@example.com", challenge[1], invite2) is None


def test_idle_origin_private_and_disabled(client, other_client, monkeypatch):
    now = int(time.time())
    monkeypatch.setattr(auth_store.time, "time", lambda: now)
    anonymous = browser()
    for path in [
        "/api/jobs",
        "/api/status",
        "/api/jobs/1/original",
        "/api/jobs/1/events",
    ]:
        assert anonymous.get(path).status_code == 401
    assert (
        anonymous.post(
            "/api/auth/start",
            headers={"origin": "https://evil.invalid"},
            json={"email": "x@example.com"},
        ).status_code
        == 403
    )
    assert client.post("/api/auth/activity").status_code == 204
    monkeypatch.setattr(
        auth_store.time, "time", lambda: now + auth_store.SESSION_IDLE - 1
    )
    assert client.get("/api/jobs").status_code == 200
    monkeypatch.setattr(auth_store.time, "time", lambda: now + auth_store.SESSION_IDLE)
    assert client.get("/api/jobs").status_code == 401
    monkeypatch.setattr(auth_store.time, "time", lambda: now)
    other_id = other_client.get("/api/auth/me").json()["id"]
    assert (
        client.patch(
            "/api/admin/users/" + other_id, json={"disabled": True}
        ).status_code
        == 200
    )
    assert other_client.get("/api/jobs").status_code == 401


def test_legacy_binding_and_account_quota(client):
    owner = client.get("/api/auth/me").json()["id"]
    old = db.insert_job(
        "legacy-owner-evidence", "url", "https://example.org", SeparationOptions()
    )
    directory = config.UPLOADS_DIR / str(old)
    directory.mkdir(parents=True)
    original = directory / "original.wav"
    original.write_bytes(b"preserved audio")
    before_stat = original.stat().st_mtime_ns
    before = db.get_job(old)
    assert client.get(f"/api/jobs/{old}").status_code == 404
    auth_store.bind_legacy("legacy-owner-evidence", owner)
    assert client.get(f"/api/jobs/{old}").status_code == 200
    after = db.get_job(old)
    assert before is not None and after is not None
    before.session_id = owner
    assert before == after
    assert original.read_bytes() == b"preserved audio"
    assert original.stat().st_mtime_ns == before_stat
    with db._session() as conn:
        assert (
            conn.execute(
                "SELECT user_id FROM auth_legacy_bindings WHERE legacy_id=?",
                ("legacy-owner-evidence",),
            ).fetchone()[0]
            == owner
        )
    with db._session() as conn:
        conn.execute("INSERT INTO auth_settings VALUES ('user_daily_work', 1)")
    assert client.post("/api/key-analysis", data={}).status_code == 400
    assert client.post("/api/key-analysis", data={}).status_code == 429


class SMTPSink(socketserver.UnixStreamServer):
    messages: list[tuple[list[str], bytes]]


class SMTPHandler(socketserver.StreamRequestHandler):
    def handle(self):
        self.wfile.write(b"220 local sink\r\n")
        envelope = []
        while True:
            line = self.rfile.readline()
            if not line:
                return
            command = line.decode("ascii").strip()
            if command.upper().startswith(("EHLO", "HELO")):
                self.wfile.write(b"250 local\r\n")
            elif command.upper().startswith(("MAIL FROM:", "RCPT TO:")):
                envelope.append(command)
                self.wfile.write(b"250 ok\r\n")
            elif command.upper() == "DATA":
                self.wfile.write(b"354 send\r\n")
                lines = []
                while True:
                    line = self.rfile.readline()
                    if line == b".\r\n":
                        break
                    lines.append(line)
                assert isinstance(self.server, SMTPSink)
                self.server.messages.append((envelope, b"".join(lines)))
                self.wfile.write(b"250 accepted\r\n")
            elif command.upper() == "QUIT":
                self.wfile.write(b"221 bye\r\n")
                return
            else:
                self.wfile.write(b"250 ok\r\n")


def test_unix_smtp_and_auth_lifecycle(tmp_path, monkeypatch):
    monkeypatch.undo()
    # Restore test-owned configuration after the fixture's mail capture is removed.
    monkeypatch.setattr(config, "AUTH_SMTP_SOCKET", str(tmp_path / "smtp.sock"))
    server = SMTPSink(config.AUTH_SMTP_SOCKET, SMTPHandler)
    server.messages = []
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        _, invite = auth_store.create_invite(None)
        c = browser()
        args = {"email": "sink@example.com", "invite_code": invite}
        assert c.post("/api/auth/start", json=args).status_code == 202
        envelope, raw = server.messages[0]
        message = message_from_bytes(raw)
        assert message["From"] == "no-reply@auth.ehpc.io"
        assert message["Date"] and message["Message-ID"]
        assert envelope[0].lower() == "mail from:<bounce@auth.ehpc.io>"
        assert envelope[1].lower() == "rcpt to:<sink@example.com>"
        payload = message.get_payload(decode=True)
        assert isinstance(payload, bytes)
        code = payload.decode().split("code is ")[1].split(".")[0]
        assert (
            c.post("/api/auth/verify", json={**args, "code": code}).status_code == 200
        )
        assert c.get("/api/auth/me").json()["email"] == "sink@example.com"
        with sqlite3.connect(config.DB_PATH) as conn:
            assert conn.execute(
                "SELECT verifier FROM auth_invites WHERE verifier=?",
                (hashlib.sha256(invite.encode()).hexdigest(),),
            ).fetchone()
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
