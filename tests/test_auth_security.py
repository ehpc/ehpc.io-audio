"""Security boundaries that must hold independently of browser state."""

import concurrent.futures

import pytest
from fastapi.testclient import TestClient
from starlette.requests import Request

from backend import auth_store, config, db, mailer
from backend.main import app
from backend.routes.auth import client_ip


def test_missing_secrets_and_public_http_fail_closed(monkeypatch):
    monkeypatch.setattr(config, "AUTH_OTP_SECRET", "")
    with pytest.raises(RuntimeError):
        config.validate_auth()
    monkeypatch.setattr(config, "AUTH_OTP_SECRET", "o" * 32)
    monkeypatch.setattr(config, "AUTH_INVITE_SECRET", "i" * 32)
    monkeypatch.setattr(config, "AUTH_ORIGIN", "http://public.example")
    with pytest.raises(RuntimeError):
        config.validate_auth()
    monkeypatch.setattr(config, "AUTH_ORIGIN", "http://127.0.0.1:3000")
    config.validate_auth()
    assert not config.auth_cookie_secure()


def test_only_trusted_gateway_can_supply_single_real_ip(monkeypatch):
    def req(peer, headers):
        return Request({"type": "http", "client": (peer, 1234), "headers": headers})

    monkeypatch.setattr(config, "AUTH_TRUSTED_PROXY_CIDRS", "192.0.2.0/24")
    headers = [(b"x-real-ip", b"198.51.100.10"), (b"x-forwarded-for", b"203.0.113.1")]
    assert client_ip(req("203.0.113.2", headers)) == "203.0.113.2"
    assert client_ip(req("192.0.2.1", headers)) == "198.51.100.10"
    assert client_ip(req("192.0.2.1", [(b"x-real-ip", b"192.0.2.9")])) == "192.0.2.9"
    assert client_ip(req("192.0.2.1", [(b"x-real-ip", b"invalid")])) == "192.0.2.1"
    assert (
        client_ip(req("192.0.2.1", [(b"x-real-ip", b"198.51.100.1, 198.51.100.2")]))
        == "192.0.2.1"
    )
    assert (
        client_ip(
            req(
                "192.0.2.1",
                [(b"x-real-ip", b"198.51.100.1"), (b"x-real-ip", b"198.51.100.2")],
            )
        )
        == "192.0.2.1"
    )
    assert (
        client_ip(req("192.0.2.1", [(b"x-forwarded-for", b"198.51.100.3")]))
        == "192.0.2.1"
    )


def test_gateway_clients_have_independent_ip_limits(monkeypatch):
    monkeypatch.setattr(config, "AUTH_TRUSTED_PROXY_CIDRS", "192.0.2.0/24")

    def ip(value):
        request = Request(
            {
                "type": "http",
                "client": ("192.0.2.1", 1234),
                "headers": [(b"x-real-ip", value.encode())],
            }
        )
        return client_ip(request)

    for index in range(20):
        assert (
            auth_store.start(f"unknown{index}@example.com", None, ip("198.51.100.1"))
            is None
        )
    _, invite = auth_store.create_invite(None)
    assert auth_store.start("limited@example.com", invite, ip("198.51.100.1")) is None
    assert auth_store.start("other@example.com", invite, ip("198.51.100.2")) is not None


def test_uncertain_mail_preserves_code_without_leaking_eligibility(monkeypatch):
    _, invite = auth_store.create_invite(None)
    codes = []

    def fail(email, code):
        codes.append(code)
        raise OSError("submission unavailable")

    monkeypatch.setattr(mailer, "send_code", fail)
    c = TestClient(
        app, base_url="https://testserver", headers={"origin": "https://testserver"}
    )
    valid = {"email": "eligible@example.com", "invite_code": invite}
    invalid = {"email": "unknown@example.com"}
    a = c.post("/api/auth/start", json=valid)
    b = c.post("/api/auth/start", json=invalid)
    assert a.status_code == b.status_code == 202 and a.json() == b.json()
    assert (
        c.post("/api/auth/verify", json={**valid, "code": codes[0]}).status_code == 200
    )
    with db._session() as conn:
        assert (
            conn.execute(
                "SELECT count(*) FROM auth_sends WHERE delivery='failed'"
            ).fetchone()[0]
            == 1
        )


def test_invite_allowance_is_atomic(client):
    owner = client.get("/api/auth/me").json()["id"]
    auth_store.update_user(owner, invite_limit=1)

    def issue(_):
        try:
            auth_store.create_invite(owner)
            return True
        except ValueError:
            return False

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        assert sum(pool.map(issue, range(8))) == 1
