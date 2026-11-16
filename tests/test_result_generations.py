"""Result readers select one published generation without mutating it."""

import asyncio
import sqlite3
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend import config, db, pitch_reference
from backend.models import (
    ResultManifestEntry,
    job_to_dto,
    pitch_vocals_path,
    result_directory,
)
from backend.routes import results
from separator.pitch import PitchAnalysis, PitchTrack, pitch_to_json


def _job(client: TestClient) -> int:
    job_id = client.post(
        "/api/jobs", files={"file": ("source.mp3", b"source", "audio/mpeg")}
    ).json()["id"]
    db.mark_done(
        job_id,
        [
            ResultManifestEntry(
                label="vocals", filename="vocals.mp3", size_bytes=3, duration_s=1
            )
        ],
        pitch_json=pitch_to_json(PitchAnalysis(1, 1, [PitchTrack("vocals", [])])),
    )
    return job_id


def _select(job_id: int, generation: str | None) -> None:
    with sqlite3.connect(config.DB_PATH) as connection:
        connection.execute(
            "UPDATE jobs SET result_generation = ? WHERE id = ?", (generation, job_id)
        )


def _put(job_id: int, generation: str | None, name: str, content: bytes) -> Path:
    directory = config.RESULTS_DIR / str(job_id)
    if generation is not None:
        directory = directory / "generations" / generation
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / name
    path.write_bytes(content)
    return path


def test_generation_selection_and_inflight_snapshot(
    client: TestClient, other_client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    job_id = _job(client)
    old = _put(job_id, None, "vocals.mp3", b"old")
    first = _put(job_id, "first", "vocals.mp3", b"first")
    second = _put(job_id, "second", "vocals.mp3", b"second")
    monkeypatch.setattr(
        results, "ensure_download_title", lambda path, name: path.stat().st_size
    )
    monkeypatch.setattr(results, "listening_path", lambda path, root: None)
    url = f"/api/jobs/{job_id}/results/vocals"
    assert client.get(url).content == b"old"
    assert client.get(f"/api/jobs/{job_id}/original").content == b"source"

    _select(job_id, "first")
    selected = db.get_job(job_id)
    assert selected is not None
    assert result_directory(selected) == first.parent
    assert client.get(f"/api/jobs/{job_id}").json()["result_revision"] == "first"
    response = client.get(url)
    assert response.content == b"first"
    assert response.headers["cache-control"] == "private, no-cache"
    assert client.head(url).headers["cache-control"] == "private, no-cache"
    assert (
        client.get(url + "?playback=1").headers["cache-control"] == "private, no-cache"
    )
    assert client.get(url, headers={"range": "bytes=1-2"}).content == b"ir"
    assert other_client.get(url).status_code == 404
    _select(job_id, "second")
    assert client.get(url).content == b"second"
    assert client.get(f"/api/jobs/{job_id}").json()["result_revision"] == "second"

    # A request holding the old row retains its old path even after publication.
    monkeypatch.setattr(results.db, "get_job", lambda _: selected)
    _select(job_id, "second")
    pending = asyncio.run(results.get_result(job_id, "vocals", selected.session_id))
    assert Path(pending.path) == first
    assert Path(pending.path).read_bytes() == b"first"
    assert old.read_bytes() == b"old"
    assert second.read_bytes() == b"second"


def test_private_pitch_reference_and_recovery_are_generation_scoped(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    job_id = _job(client)
    # No public vocals in this manifest: use the private reference fallback.
    db.mark_done(
        job_id,
        [],
        pitch_json=pitch_to_json(PitchAnalysis(1, 1, [PitchTrack("vocals", [])])),
    )
    old = _put(job_id, None, ".pitch-vocals.mp3", b"old pitch")
    current = _put(job_id, "new", ".pitch-vocals.mp3", b"new pitch")
    _select(job_id, "new")
    job = db.get_job(job_id)
    assert job is not None
    assert pitch_vocals_path(job) == current
    assert job_to_dto(job, None).has_pitch_vocals is True
    monkeypatch.setattr(results, "listening_path", lambda path, root: None)
    url = f"/api/jobs/{job_id}/pitch-reference/vocals"
    assert client.get(url).content == b"new pitch"
    assert client.head(url).headers["cache-control"] == "private, no-cache"
    assert (
        client.get(url + "?playback=1").headers["cache-control"] == "private, no-cache"
    )

    current.unlink()
    monkeypatch.setattr(results, "recover_vocals", lambda source: b"recovered")
    monkeypatch.setattr(
        pitch_reference, "transform_audio", lambda data, options, root: data
    )
    assert client.post(url).status_code == 204
    assert current.read_bytes() == b"recovered"
    assert old.read_bytes() == b"old pitch"
