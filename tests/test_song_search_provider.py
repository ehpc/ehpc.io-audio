import asyncio
import hashlib
import json
import shutil
import threading
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace

import modal
import pytest
import requests
import ytmusicapi

from backend import config, db, song_search_worker
from separator import cache_versions, song_search

CLUE = "Find Desired Artist Desired Song"
CANDIDATES: song_search.CatalogCandidates = [
    {
        "video_id": "aaaaaaaaaaa",
        "title": "Unrelated Song",
        "artists": ["Other Artist"],
        "duration_seconds": 120,
        "thumbnail_url": None,
        "play_count": None,
        "play_count_approximate": False,
    },
    {
        "video_id": "bbbbbbbbbbb",
        "title": "Desired Song",
        "artists": ["Desired Artist"],
        "duration_seconds": 210,
        "thumbnail_url": None,
        "play_count": None,
        "play_count_approximate": False,
    },
]
EXTRACTION = '{"search":"Desired Artist Desired Song"}'
SELECTION = '{"status":"match","video_ids":["bbbbbbbbbbb"]}'


def completion(content, finish_reason="stop"):
    return {
        "choices": [{"finish_reason": finish_reason, "message": {"content": content}}]
    }


@pytest.fixture
def provider_http(monkeypatch):
    responses = deque()
    received = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            self.rfile.read(int(self.headers["Content-Length"]))
            received.append(None)
            status, payload, *headers = responses.popleft()
            encoded = (
                payload if isinstance(payload, bytes) else json.dumps(payload).encode()
            )
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(encoded)))
            for name, value in (headers[0] if headers else {}).items():
                self.send_header(name, value)
            self.end_headers()
            self.wfile.write(encoded)

        def log_message(self, format, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    monkeypatch.setenv("OPENROUTER_API_KEY", "owned-test-key")
    monkeypatch.setattr(
        song_search,
        "OPENROUTER_URL",
        f"http://127.0.0.1:{server.server_port}/completion",
    )
    try:
        yield responses, received
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def test_provider_grounding_cache_and_model_dependency_invalidation(
    tmp_path, monkeypatch, provider_http
):
    responses, received = provider_http
    catalog_calls = []

    def catalog(query):
        catalog_calls.append(query)
        return CANDIDATES

    def run():
        return song_search.discover(CLUE, tmp_path, song_search.generate, catalog)

    def expect_fresh():
        responses.extend([(200, completion(EXTRACTION)), (200, completion(SELECTION))])
        result = run()
        assert result == [
            {
                "title": "Desired Song",
                "artists": ["Desired Artist"],
                "url": "https://music.youtube.com/watch?v=bbbbbbbbbbb",
                "duration_seconds": 210,
                "thumbnail_url": None,
                "play_count": None,
                "play_count_approximate": False,
            }
        ]
        assert not responses
        return result

    original = expect_fresh()
    assert run() == original
    assert len(received) == 2
    assert len(catalog_calls) == 2
    monkeypatch.setattr(cache_versions, "SONG_MODEL", "owned-different-model")
    expect_fresh()
    assert len(received) == 4
    monkeypatch.setattr(
        cache_versions, "package_revision", lambda package: "owned-new-http"
    )
    expect_fresh()
    assert len(received) == 6


@pytest.mark.parametrize(
    ("status", "payload", "code"),
    [
        (401, {"error": {"message": "private upstream credentials"}}, "unavailable"),
        (402, {"error": "private billing details"}, "unavailable"),
        (429, {"error": "private rate limit details"}, "unavailable"),
        (500, {"error": "private upstream failure"}, "unavailable"),
        (400, {"error": "private malformed request details"}, "invalid_model"),
        (302, b"private redirect destination", "invalid_model"),
        (200, {"error": {"message": "private provider error"}}, "unavailable"),
        (200, b"private non-JSON response", "invalid_model"),
        (200, [], "invalid_model"),
        (200, {}, "invalid_model"),
        (200, {"choices": []}, "invalid_model"),
        (200, {"choices": [None]}, "invalid_model"),
        (200, {"choices": [{"finish_reason": "stop"}]}, "invalid_model"),
        (200, completion(None), "invalid_model"),
        (200, completion([]), "invalid_model"),
        (200, completion(" "), "invalid_model"),
        (200, completion(EXTRACTION, "length"), "invalid_model"),
        (200, completion("not JSON"), "invalid_model"),
        (200, completion('{"search":"Invented Artist"}'), "invalid_model"),
    ],
)
def test_provider_failures_publish_nothing_and_do_not_expose_response(
    tmp_path, provider_http, status, payload, code
):
    responses, received = provider_http
    responses.append((status, payload))
    result = song_search.run_search(CLUE, str(tmp_path))
    assert result["status"] == "failed"
    assert result["code"] == code
    assert "private" not in result["detail"]
    assert "owned-test-key" not in result["detail"]
    assert len(received) == 1  # No application retries.
    assert list(tmp_path.rglob("*.bin")) == []


@pytest.mark.parametrize(
    ("selection", "code"),
    [
        ('{"status":"match","video_ids":["invented_id"]}', "invalid_model"),
        ('{"status":"no_match"}', "no_match"),
        ('{"status":"ambiguous"}', "ambiguous"),
    ],
)
def test_provider_selection_still_requires_actual_catalog_match(
    tmp_path, provider_http, selection, code
):
    responses, received = provider_http
    responses.extend([(200, completion(EXTRACTION)), (200, completion(selection))])
    with pytest.raises(song_search.SearchError) as error:
        song_search.discover(
            CLUE, tmp_path, song_search.generate, lambda query: CANDIDATES
        )
    assert error.value.code == code
    assert len(received) == 2
    assert len(list(tmp_path.glob("*.bin"))) == 1  # Only valid extraction was cached.


def test_missing_provider_credential_never_attempts_http(tmp_path, monkeypatch):
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    attempts = []

    def forbidden(*args, **kwargs):
        attempts.append(True)
        raise AssertionError("HTTP must not run without application credentials")

    monkeypatch.setattr(requests, "post", forbidden)
    result = song_search.run_search(CLUE, str(tmp_path))
    assert result["status"] == "failed"
    assert result["code"] == "unavailable"
    assert attempts == []
    assert list(tmp_path.rglob("*.bin")) == []


def test_provider_timeout_has_safe_terminal_error(tmp_path, monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "owned-test-key")
    attempts = []

    def timeout(*args, **kwargs):
        attempts.append(None)
        raise requests.Timeout("private connection details")

    monkeypatch.setattr(requests, "post", timeout)
    result = song_search.run_search(CLUE, str(tmp_path))
    assert result["status"] == "failed"
    assert result["code"] == "unavailable"
    assert "private" not in result["detail"]
    assert len(attempts) == 1


def test_provider_redirect_never_contacts_unexpected_target(tmp_path, provider_http):
    responses, received = provider_http
    target_contacts = []

    class UnexpectedTarget(BaseHTTPRequestHandler):
        def do_GET(self):
            target_contacts.append(None)
            self.send_response(200)
            self.send_header("Content-Length", "2")
            self.end_headers()
            self.wfile.write(b"{}")

        do_POST = do_GET

        def log_message(self, format, *args):
            pass

    target = ThreadingHTTPServer(("127.0.0.1", 0), UnexpectedTarget)
    thread = threading.Thread(target=target.serve_forever, daemon=True)
    thread.start()
    try:
        responses.append(
            (
                302,
                {"error": "private redirect response"},
                {"Location": f"http://127.0.0.1:{target.server_port}/unexpected"},
            )
        )
        result = song_search.run_search(CLUE, str(tmp_path))
        assert result["status"] == "failed"
        assert result["code"] == "invalid_model"
        assert "private" not in result["detail"]
        assert target_contacts == []
        assert len(received) == 1
        assert list(tmp_path.rglob("*.bin")) == []
    finally:
        target.shutdown()
        target.server_close()
        thread.join()


@pytest.mark.parametrize("migrated_cache", [False, True])
def test_local_api_reuses_copied_inference_and_persisted_query_cache(
    client, other_client, tmp_path, monkeypatch, provider_http, migrated_cache
):
    responses, received = provider_http
    responses.extend([(200, completion(EXTRACTION)), (200, completion(SELECTION))])
    catalog_calls = []
    plays = {"value": "9M"}
    clock = SimpleNamespace(now=1_800_000_000.0)
    monkeypatch.setattr(db, "time", SimpleNamespace(time=lambda: clock.now))

    class Catalog:
        def __init__(self, **kwargs):
            pass

        def search(self, *args, **kwargs):
            catalog_calls.append(None)
            return [
                {
                    "resultType": "song",
                    "videoId": candidate["video_id"],
                    "title": candidate["title"],
                    "artists": [{"name": artist} for artist in candidate["artists"]],
                    "duration_seconds": candidate["duration_seconds"],
                    "views": plays["value"],
                }
                for candidate in CANDIDATES
            ]

    def forbidden_modal(*args, **kwargs):
        raise AssertionError("Local discovery must not use Modal")

    monkeypatch.setattr(ytmusicapi, "YTMusic", Catalog)
    monkeypatch.setattr(modal.Function, "from_name", forbidden_modal)
    target = config.DATA_DIR / "artifacts" / "song-search" / "results"
    imported_hashes = {}
    if migrated_cache:
        source = tmp_path / "previous-worker"
        seeded = song_search.run_search(CLUE, str(source))
        assert seeded["status"] == "done"
        shutil.copytree(source / "results", target)
        imported_hashes = {
            path.name: hashlib.sha256(path.read_bytes()).hexdigest()
            for path in target.iterdir()
        }

    started = client.post("/api/song-search", json={"query": CLUE})
    assert started.status_code == 202
    path = "/api/song-search/" + started.json()["search_id"]
    assert client.get(path).json() == {"status": "pending"}
    assert other_client.get(path).status_code == 404
    assert asyncio.run(song_search_worker.run_next_search())
    result = client.get(path).json()
    assert result["songs"][0]["url"].endswith("bbbbbbbbbbb")
    assert result["songs"][0]["play_count"] == 9_000_000
    assert len(received) == 2
    assert len(catalog_calls) == (2 if migrated_cache else 1)
    if migrated_cache:
        assert {
            path.name: hashlib.sha256(path.read_bytes()).hexdigest()
            for path in target.iterdir()
        } == imported_hashes
    db.init_db()
    db.recover_song_searches(song_search.SEARCH_TTL)
    cached = other_client.post("/api/song-search", json={"query": f"  {CLUE}\n"})
    cached_path = "/api/song-search/" + cached.json()["search_id"]
    assert other_client.get(cached_path).json() == result
    assert client.get(cached_path).status_code == 404
    assert not asyncio.run(song_search_worker.run_next_search())
    assert len(received) == 2
    assert len(catalog_calls) == (2 if migrated_cache else 1)

    clock.now += 86400
    plays["value"] = "19M"
    refreshed = client.post("/api/song-search", json={"query": CLUE})
    refreshed_path = "/api/song-search/" + refreshed.json()["search_id"]
    assert asyncio.run(song_search_worker.run_next_search())
    assert client.get(refreshed_path).json()["songs"][0]["play_count"] == 19_000_000
    assert len(received) == 2  # Expiry refreshes catalog, not unchanged inference.
    assert len(catalog_calls) == (3 if migrated_cache else 2)
    assert client.get("/api/jobs").json() == other_client.get("/api/jobs").json() == []
