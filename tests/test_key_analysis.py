import asyncio
import shutil
import threading
from pathlib import Path

import pytest
from audio_samples import tone_wav
from fastapi.testclient import TestClient

from backend import modal_client
from backend.routes import key_analysis

_NATIVE = shutil.which("keyfinder-cli") is not None


@pytest.mark.parametrize(
    "data",
    [
        {},
        {"url": "ftp://example.com/song.mp3"},
        {"url": "not a URL"},
        {"url": "http://["},
    ],
)
def test_invalid_preview_source_is_actionable_and_stateless(
    client: TestClient, data: dict[str, str]
) -> None:
    response = client.post("/api/key-analysis", data=data)
    assert response.status_code == 400
    assert client.get("/api/jobs").json() == []


def test_preview_requires_exactly_one_source(client: TestClient) -> None:
    response = client.post(
        "/api/key-analysis",
        data={"url": "https://example.com/song"},
        files={"file": ("song.wav", b"audio", "audio/wav")},
    )
    assert response.status_code == 400
    assert client.get("/api/jobs").json() == []


@pytest.mark.skipif(not _NATIVE, reason="keyfinder-cli required")
@pytest.mark.parametrize("silent", [False, True])
def test_real_upload_preview_without_a_job_or_gpu(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, silent: bool
) -> None:
    def forbidden(*args: object, **kwargs: object) -> object:
        raise AssertionError("preview must not spawn Modal")

    monkeypatch.setattr(modal_client, "spawn", forbidden)
    source = tone_wav(() if silent else (261.6256, 329.6276, 391.9954), duration_s=8)
    response = client.post(
        "/api/key-analysis", files={"file": ("song.wav", source, "audio/wav")}
    )
    assert response.status_code == 200
    assert response.json() == {"original_key": None if silent else "C major"}
    assert "session_id" in client.cookies
    assert client.get("/api/jobs").json() == []


@pytest.mark.skipif(not _NATIVE, reason="keyfinder-cli required")
def test_native_preview_decode_failure_is_visible(client: TestClient) -> None:
    response = client.post(
        "/api/key-analysis", files={"file": ("broken.wav", b"not audio", "audio/wav")}
    )
    assert response.status_code == 422
    assert client.get("/api/jobs").json() == []


def test_cancelled_download_keeps_temp_files_until_worker_exits(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    started = threading.Event()
    release = threading.Event()
    directories: list[Path] = []

    def download(url: str, destination: str, **kwargs: object) -> tuple[bytes, str]:
        directory = Path(destination)
        directories.append(directory)
        (directory / "partial.mp3").write_bytes(b"in progress")
        started.set()
        assert release.wait(10)
        assert directory.is_dir()
        raise RuntimeError("cancelled test download finished")

    monkeypatch.setattr(key_analysis, "download_mp3", download)

    async def exercise() -> None:
        task = asyncio.create_task(
            key_analysis.analyze_key(
                "session", url="https://example.com/song", file=None
            )
        )
        try:
            assert await asyncio.to_thread(started.wait, 5)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
            assert directories[0].is_dir()
        finally:
            release.set()
        for _ in range(100):
            if not directories[0].exists():
                break
            await asyncio.sleep(0.01)
        assert not directories[0].exists()

    asyncio.run(exercise())
