import os
import tempfile

# Config reads these at import time, so they must be set before any backend
# import. Point at a throwaway data dir and disable background workers so jobs
# stay queued for deterministic API-shape assertions.
os.environ["DATA_DIR"] = tempfile.mkdtemp(prefix="vocals-test-")
os.environ["QUEUE_CONCURRENCY"] = "0"
os.environ["COOKIE_SECRET"] = "test-secret"
os.environ["COOKIE_SECURE"] = "false"

import shutil
import sqlite3
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from backend import config, db
from backend.main import app


@pytest.fixture(autouse=True)
def _fresh_state() -> Iterator[None]:
    db.init_db()
    conn = sqlite3.connect(config.DB_PATH)
    conn.executescript(
        "DELETE FROM jobs; DELETE FROM sqlite_sequence WHERE name = 'jobs';"
    )
    conn.commit()
    conn.close()
    shutil.rmtree(config.UPLOADS_DIR, ignore_errors=True)
    shutil.rmtree(config.RESULTS_DIR, ignore_errors=True)
    yield


@pytest.fixture
def client() -> Iterator[TestClient]:
    with TestClient(app) as c:
        yield c


@pytest.fixture
def other_client() -> Iterator[TestClient]:
    """A client with its own cookie jar — i.e. a different browser session."""
    with TestClient(app) as c:
        yield c


@pytest.fixture
def worker_client(monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    """A client whose app runs a real queue worker, for end-to-end tests.

    `client` above keeps QUEUE_CONCURRENCY at 0 so jobs stay queued; here the
    lifespan starts a worker that picks them up (and polls tightly, so tests
    don't wait on the production 2s idle interval).
    """
    monkeypatch.setattr(config, "QUEUE_CONCURRENCY", 1)
    monkeypatch.setattr(config, "QUEUE_POLL_INTERVAL_S", 0.01)
    with TestClient(app) as c:
        yield c
