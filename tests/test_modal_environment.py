import runpy
from collections.abc import Callable
from types import SimpleNamespace
from typing import Any

import pytest

from backend import config, modal_client
from separator.options import SeparationOptions
from separator.processing import ProcessingResult
from separator.stems import StemResult

type EndpointKey = tuple[str, str]
type RemoteOperation = Callable[..., Any]


class Operation:
    """Synchronous/asynchronous entrypoints at the controlled SDK boundary."""

    def __init__(self, function: RemoteOperation):
        self.function = function

    def __call__(self, *args, **kwargs):
        return self.function(*args, **kwargs)

    async def aio(self, *args, **kwargs):
        return self.function(*args, **kwargs)


@pytest.fixture
def environment_registry(monkeypatch):
    # A missing explicit destination really selects the wrong existing worker,
    # rather than making a copied-kwargs assertion pass or fail.
    endpoints: dict[EndpointKey, Any] = {}
    calls: dict[str, Any] = {}
    for environment, title, video_id in (
        ("main", "Obsolete worker song", "aaaaaaaaaaa"),
        ("ehpc-audio", "Migrated worker song", "bbbbbbbbbbb"),
        ("isolated-review", "Review worker song", "ccccccccccc"),
    ):
        endpoints[environment, "search_song"] = {
            "status": "done",
            "songs": [
                {
                    "title": title,
                    "artists": ["Owned routing fixture"],
                    "url": f"https://music.youtube.com/watch?v={video_id}",
                    "duration_seconds": 120,
                    "thumbnail_url": None,
                    "play_count": None,
                    "play_count_approximate": False,
                }
            ],
        }
        endpoints[environment, "separate"] = {
            "vocals": StemResult(f"{environment} separated audio".encode(), 1.0)
        }
        endpoints[environment, "separate_with_lyrics"] = ProcessingResult(
            audio={"vocals": StemResult(f"{environment} analyzed audio".encode(), 1.0)}
        )

    def lookup(app_name, function_name, *, environment_name=None):
        result = endpoints[environment_name or "main", function_name]

        def spawn(*args, **kwargs):
            call_id = f"fc-owned-routing-{len(calls)}"
            call = SimpleNamespace(
                object_id=call_id,
                get=Operation(lambda **kwargs: result),
            )
            calls[call_id] = call
            return call

        return SimpleNamespace(spawn=Operation(spawn))

    modal_client._get_function.cache_clear()
    monkeypatch.setattr(modal_client.modal.Function, "from_name", lookup)
    monkeypatch.setattr(modal_client.modal.FunctionCall, "from_id", calls.__getitem__)
    try:
        yield endpoints
    finally:
        modal_client._get_function.cache_clear()


def configure_environment(monkeypatch, override):
    if override is None:
        monkeypatch.delenv("MODAL_ENVIRONMENT", raising=False)
    else:
        monkeypatch.setenv("MODAL_ENVIRONMENT", override)
    # Read production config with the selected process environment without
    # reloading/mutating unrelated configuration in the shared test process.
    configured = runpy.run_path(config.__file__)["MODAL_ENVIRONMENT"]
    monkeypatch.setattr(config, "MODAL_ENVIRONMENT", configured)


@pytest.mark.parametrize(
    ("override", "expected_title"),
    [
        (None, "Migrated worker song"),
        ("", "Migrated worker song"),
        (" \t ", "Migrated worker song"),
        ("isolated-review", "Review worker song"),
        (" isolated-review ", "Review worker song"),
    ],
)
def test_http_search_uses_configured_environment_not_ambient_main(
    client, monkeypatch, environment_registry, override, expected_title
):
    configure_environment(monkeypatch, override)
    started = client.post("/api/song-search", json={"query": "Find a song"})
    assert started.status_code == 202
    result = client.get("/api/song-search/" + started.json()["search_id"])
    assert result.status_code == 200
    assert result.json()["songs"][0]["title"] == expected_title
    assert client.get("/api/jobs").json() == []


def test_missing_destination_worker_does_not_fall_back_to_existing_main(
    client, monkeypatch, environment_registry
):
    configure_environment(monkeypatch, None)
    del environment_registry["ehpc-audio", "search_song"]
    response = client.post("/api/song-search", json={"query": "Find a song"})
    assert response.status_code == 503
    assert client.get("/api/jobs").json() == []


@pytest.mark.parametrize("analysis", [False, True])
def test_audio_rpc_returns_destination_audio_not_obsolete_main(
    monkeypatch, environment_registry, analysis
):
    configure_environment(monkeypatch, None)
    options = SeparationOptions(extract_vocals=True, extract_lyrics=analysis)
    spawn = modal_client.spawn_with_lyrics if analysis else modal_client.spawn
    call = spawn(b"owned input", "owned.wav", options)
    result = modal_client.poll(call, timeout=0)
    if analysis:
        assert isinstance(result, ProcessingResult)
        audio = result.audio
        expected = b"ehpc-audio analyzed audio"
    else:
        assert isinstance(result, dict)
        audio = result
        expected = b"ehpc-audio separated audio"
    assert audio["vocals"].data == expected
