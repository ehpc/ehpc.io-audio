"""End-to-end tests: a real HTTP submit, picked up by the real queue worker, run
through the real stem graph, and served back as a real stem download.

The only thing faked is the Modal round-trip — the boundary where a GPU would
run — so every piece of the app between the browser and that boundary is
exercised for real: form parsing, sqlite, the worker loop, result persistence,
the SSE stream and the download routes. `tests/test_smoke.py` covers the other
side of that boundary against the deployed function.
"""

import asyncio
import json
import time
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import quote

import pytest
from fastapi.testclient import TestClient

from backend import config, db, events, modal_client, queue
from backend.models import JobStatus
from separator import stems
from separator.options import SeparationOptions
from separator.stems import SeparationResult, Stem, StemResult

_TERMINAL = (JobStatus.DONE, JobStatus.FAILED)
_UPLOAD_BYTES = b"ID3\x03\x00fake-mp3-payload"


@dataclass
class _FakeCall:
    """Stands in for modal.functions.FunctionCall in the worker's spawn/poll loop."""

    object_id: str
    result: SeparationResult
    polls: int = 0


def _fake_run_separator(
    input_path: Path,
    stem: Stem,
    out_dir: Path,
    model_cache: str,
    stem_cache: str,
    use_cache: bool = True,
) -> dict[str, tuple[StemResult, Path]]:
    """Stand-in for the audio-separator subprocess: per-label bytes, no GPU.

    Distinct bytes per label let the download assertions catch mis-wiring
    between a manifest entry and the file it points at.
    """
    return {
        output.label: (
            StemResult(data=f"{output.label}-audio".encode(), duration_s=1.5),
            out_dir / f"{output.label}.mp3",
        )
        for output in stem.outputs
    }


def _fake_modal(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> list[tuple[bytes, str, SeparationOptions]]:
    """Run the real stem graph in-process instead of on Modal.

    Returns the list of (audio_bytes, filename, options) the worker handed over,
    so tests can assert what actually reached the separator.
    """
    spawned: list[tuple[bytes, str, SeparationOptions]] = []

    def spawn(
        audio_bytes: bytes, filename: str, options: SeparationOptions
    ) -> _FakeCall:
        spawned.append((audio_bytes, filename, options))
        return _FakeCall(
            object_id=f"fc-{len(spawned)}",
            result=stems.run_separation(
                Path(filename), options, tmp_path / str(len(spawned)), "mc", "sc"
            ),
        )

    def poll(call: _FakeCall, timeout: float) -> SeparationResult | None:
        # The first poll reports "not ready" so the worker's wait loop is exercised.
        call.polls += 1
        return call.result if call.polls > 1 else None

    monkeypatch.setattr(stems, "run_separator", _fake_run_separator)
    monkeypatch.setattr(modal_client, "spawn", spawn)
    monkeypatch.setattr(modal_client, "poll", poll)
    return spawned


def _submit_upload(
    client: TestClient, filename: str = "song.mp3", **options: bool
) -> int:
    response = client.post(
        "/api/jobs",
        files={"file": (filename, _UPLOAD_BYTES, "audio/mpeg")},
        data={name: str(value).lower() for name, value in options.items()},
    )
    assert response.status_code == 200
    return response.json()["id"]


def _wait_for_terminal(
    client: TestClient, job_id: int, timeout_s: float = 10.0
) -> dict:
    deadline = time.monotonic() + timeout_s
    job = client.get(f"/api/jobs/{job_id}").json()
    while job["status"] not in _TERMINAL:
        assert time.monotonic() < deadline, (
            f"job {job_id} stuck in {job['status']} after {timeout_s}s"
        )
        time.sleep(0.01)
        job = client.get(f"/api/jobs/{job_id}").json()
    return job


def test_upload_is_separated_and_stems_are_downloadable(
    worker_client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    spawned = _fake_modal(monkeypatch, tmp_path)

    job_id = _submit_upload(worker_client)
    job = _wait_for_terminal(worker_client, job_id)

    assert job["status"] == JobStatus.DONE, job["error_message"]
    assert [entry["label"] for entry in job["manifest"]] == ["vocals", "instruments"]
    # The bytes the browser uploaded are the bytes the separator received.
    assert spawned == [(_UPLOAD_BYTES, "song.mp3", SeparationOptions())]

    for label in ("vocals", "instruments"):
        stem = worker_client.get(f"/api/jobs/{job_id}/results/{label}")
        assert stem.status_code == 200
        assert stem.content == f"{label}-audio".encode()
        assert stem.headers["content-type"] == "audio/mpeg"
        # Starlette percent-encodes the download name (RFC 5987 filename*=).
        assert quote(f"song - {label}.mp3") in stem.headers["content-disposition"]

    original = worker_client.get(f"/api/jobs/{job_id}/original")
    assert original.status_code == 200
    assert original.content == _UPLOAD_BYTES


def test_submitted_options_reach_the_separator_and_shape_the_manifest(
    worker_client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # Which labels a given option set produces is test_stems' job; what matters
    # here is that the checkboxes survive the form -> sqlite -> worker trip and
    # that every stem they produce is served.
    spawned = _fake_modal(monkeypatch, tmp_path)

    job_id = _submit_upload(
        worker_client, decrowd_vocals=True, dereverb=True, genders=True
    )
    job = _wait_for_terminal(worker_client, job_id)

    assert job["status"] == JobStatus.DONE, job["error_message"]
    assert spawned[0][2] == SeparationOptions(
        decrowd_vocals=True, dereverb=True, genders=True
    )
    labels = [entry["label"] for entry in job["manifest"]]
    assert set(labels) >= {
        "vocals-dry",
        "vocals-decrowded",
        "vocals-decrowded-dry",
        "vocals-male",
        "vocals-female",
    }, labels
    for label in labels:
        stem = worker_client.get(f"/api/jobs/{job_id}/results/{label}")
        assert stem.status_code == 200, label
        assert stem.content == f"{label}-audio".encode()


def test_url_job_downloads_titles_and_separates(
    worker_client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _fake_modal(monkeypatch, tmp_path)

    def fake_download(url: str, dest: str, **kwargs: object) -> tuple[bytes, str]:
        (Path(dest) / "My Song.mp3").write_bytes(_UPLOAD_BYTES)
        return _UPLOAD_BYTES, "My Song.mp3"

    monkeypatch.setattr(queue, "download_mp3", fake_download)

    submitted = worker_client.post("/api/jobs", data={"url": "https://example.com/x"})
    job_id = submitted.json()["id"]
    job = _wait_for_terminal(worker_client, job_id)

    assert job["status"] == JobStatus.DONE, job["error_message"]
    assert job["title"] == "My Song"  # history shows the track, not the raw URL
    assert job["has_original"] is True

    stem = worker_client.get(f"/api/jobs/{job_id}/results/vocals")
    assert stem.content == b"vocals-audio"
    assert quote("My Song - vocals.mp3") in stem.headers["content-disposition"]


def test_failed_separation_surfaces_the_error_and_serves_no_stems(
    worker_client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    def boom(*args: object, **kwargs: object) -> object:
        raise RuntimeError("gpu exploded")

    monkeypatch.setattr(modal_client, "spawn", boom)

    job_id = _submit_upload(worker_client)
    job = _wait_for_terminal(worker_client, job_id)

    assert job["status"] == JobStatus.FAILED
    assert job["error_message"] == "gpu exploded"
    assert job["manifest"] is None
    assert worker_client.get(f"/api/jobs/{job_id}/results/vocals").status_code == 404


def test_event_stream_serves_the_finished_job(
    worker_client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # Subscribing after the job is terminal, because the endpoint then answers
    # from the job row and closes. Subscribing to a *live* job over HTTP would
    # hang the whole suite if the publish path ever regressed (the stream would
    # simply never end), so that half is covered without HTTP below.
    _fake_modal(monkeypatch, tmp_path)
    job_id = _submit_upload(worker_client)
    _wait_for_terminal(worker_client, job_id)

    with worker_client.stream("GET", f"/api/jobs/{job_id}/events") as response:
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")
        frames = [
            json.loads(line.removeprefix("data: "))
            for line in response.iter_lines()
            if line.startswith("data: ")
        ]

    assert [frame["status"] for frame in frames] == [JobStatus.DONE]
    assert [entry["label"] for entry in frames[0]["manifest"]] == [
        "vocals",
        "instruments",
    ]


def test_worker_publishes_progress_to_stream_subscribers(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # The live half of the SSE contract: a subscriber gets a running event when
    # the worker picks the job up and a done event carrying the manifest. Driven
    # directly (the `client` fixture runs no worker, so nothing else claims the
    # job) to keep a regression here a failure rather than a hang.
    _fake_modal(monkeypatch, tmp_path)
    job_id = _submit_upload(client)

    async def run_claimed_job() -> list[dict]:
        subscription = events.subscribe(job_id)
        try:
            job = await asyncio.to_thread(db.claim_oldest_queued)
            assert job is not None and job.id == job_id
            await queue._run_job(job)
            return [subscription.get_nowait() for _ in range(subscription.qsize())]
        finally:
            events.unsubscribe(job_id, subscription)

    payloads = asyncio.run(run_claimed_job())

    assert [payload["status"] for payload in payloads] == [
        JobStatus.RUNNING,
        JobStatus.DONE,
    ]
    assert [entry["label"] for entry in payloads[-1]["manifest"]] == [
        "vocals",
        "instruments",
    ]


def test_results_are_persisted_under_the_data_dir(
    worker_client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # Stems must survive a restart, so they live on disk rather than in memory.
    _fake_modal(monkeypatch, tmp_path)
    job_id = _submit_upload(worker_client)
    _wait_for_terminal(worker_client, job_id)

    results = config.RESULTS_DIR / str(job_id)
    assert sorted(p.name for p in results.glob("*.mp3")) == [
        "instruments.mp3",
        "vocals.mp3",
    ]
    assert (results / "vocals.mp3").read_bytes() == b"vocals-audio"
