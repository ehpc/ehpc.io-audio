import os
import tempfile

# Config reads these at import time, so they must be set before any backend
# import. Point at a throwaway data dir and disable background workers so jobs
# stay queued for deterministic API-shape assertions.
os.environ["DATA_DIR"] = tempfile.mkdtemp(prefix="vocals-test-")
os.environ["QUEUE_CONCURRENCY"] = "0"
os.environ["AUTH_OTP_SECRET"] = "test-otp-secret-" * 4
os.environ["AUTH_INVITE_SECRET"] = "test-invite-secret-" * 4
os.environ["AUTH_ORIGIN"] = "https://testserver"

import shutil
import sqlite3
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend import auth_store, config, db, drain, mailer
from backend.main import app


@pytest.fixture(autouse=True)
def _fresh_state(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Iterator[None]:
    monkeypatch.setattr(drain, "SOCKET", tmp_path / "drain.sock")
    drain.state.reset()
    db.init_db()
    conn = sqlite3.connect(config.DB_PATH)
    conn.executescript(
        "DELETE FROM auth_legacy_bindings; DELETE FROM auth_work; "
        "DELETE FROM auth_sends; DELETE FROM auth_challenges; "
        "DELETE FROM auth_sessions; DELETE FROM auth_invites; "
        "DELETE FROM auth_users; DELETE FROM auth_settings; "
        "DELETE FROM song_searches; "
        "DELETE FROM jobs; DELETE FROM sqlite_sequence WHERE name = 'jobs';"
    )
    conn.commit()
    conn.close()
    shutil.rmtree(config.UPLOADS_DIR, ignore_errors=True)
    shutil.rmtree(config.RESULTS_DIR, ignore_errors=True)
    shutil.rmtree(config.DATA_DIR / "artifacts", ignore_errors=True)
    monkeypatch.setattr(
        mailer, "send_code", lambda email, code: _codes.__setitem__(email, code)
    )
    _codes.clear()
    yield
    drain.state.reset()


_codes: dict[str, str] = {}


def _register(client: TestClient, email: str) -> None:
    _, invite = auth_store.create_invite(None)
    assert (
        client.post(
            "/api/auth/start", json={"email": email, "invite_code": invite}
        ).status_code
        == 202
    )
    assert (
        client.post(
            "/api/auth/verify",
            json={"email": email, "invite_code": invite, "code": _codes[email]},
        ).status_code
        == 200
    )


def _new_client() -> TestClient:
    return TestClient(
        app, base_url="https://testserver", headers={"origin": "https://testserver"}
    )


@pytest.fixture
def client() -> Iterator[TestClient]:
    with _new_client() as c:
        _register(c, "ehpc@ehpc.io")
        yield c


@pytest.fixture
def other_client() -> Iterator[TestClient]:
    """A client with its own cookie jar — i.e. a different browser session."""
    c = _new_client()
    try:
        _register(c, "other@example.com")
        yield c
    finally:
        c.close()


@pytest.fixture
def worker_client(monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    """A client whose app runs a real queue worker, for end-to-end tests.

    `client` above keeps QUEUE_CONCURRENCY at 0 so jobs stay queued; here the
    lifespan starts a worker that picks them up (and polls tightly, so tests
    don't wait on the production 2s idle interval).
    """
    monkeypatch.setattr(config, "QUEUE_CONCURRENCY", 1)
    monkeypatch.setattr(config, "QUEUE_POLL_INTERVAL_S", 0.01)
    with _new_client() as c:
        _register(c, "worker@example.com")
        yield c
