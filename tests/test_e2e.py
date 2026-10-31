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
import shutil
import subprocess
import threading
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import cast
from urllib.parse import quote

import pytest
from audio_samples import mp3_measurements, tone_wav
from fastapi.testclient import TestClient

from backend import config, db, events, modal_client, queue
from backend.models import JobStatus
from backend.routes import jobs as jobs_route
from separator import audio, stems
from separator.options import SeparationOptions
from separator.stems import SeparationResult, Stem, StemResult

_TERMINAL = (JobStatus.DONE, JobStatus.FAILED)
_UPLOAD_BYTES = b"ID3\x03\x00fake-mp3-payload"


@pytest.fixture(autouse=True)
def _key_analysis(monkeypatch: pytest.MonkeyPatch) -> None:
    # These separation scenarios use placeholder bytes, not decodable audio.
    monkeypatch.setattr(queue, "detect_key", lambda audio, name: "C major")


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

    job_id = _submit_upload(
        worker_client, extract_vocals=True, extract_instruments=True
    )
    job = _wait_for_terminal(worker_client, job_id)

    assert job["status"] == JobStatus.DONE, job["error_message"]
    assert [entry["label"] for entry in job["manifest"]] == ["vocals", "instruments"]
    # The bytes the browser uploaded are the bytes the separator received.
    assert spawned == [
        (
            _UPLOAD_BYTES,
            "song.mp3",
            SeparationOptions(extract_vocals=True, extract_instruments=True),
        )
    ]

    for label in ("vocals", "instruments"):
        stem = worker_client.get(f"/api/jobs/{job_id}/results/{label}")
        assert stem.status_code == 200
        assert stem.content.endswith(f"{label}-audio".encode())
        assert stem.headers["content-type"] == "audio/mpeg"
        # Starlette percent-encodes the download name (RFC 5987 filename*=).
        assert (
            quote(f"song - {label} - source-key-C-major.mp3")
            in stem.headers["content-disposition"]
        )

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
        "vocals-decrowded",
        "vocals-decrowded-dry",
        "vocals-male",
        "vocals-female",
    }, labels
    for label in labels:
        stem = worker_client.get(f"/api/jobs/{job_id}/results/{label}")
        assert stem.status_code == 200, label
        assert stem.content.endswith(f"{label}-audio".encode())


def test_url_job_downloads_titles_and_separates(
    worker_client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _fake_modal(monkeypatch, tmp_path)

    def fake_download(url: str, dest: str, **kwargs: object) -> tuple[bytes, str]:
        (Path(dest) / "My Song.mp3").write_bytes(_UPLOAD_BYTES)
        return _UPLOAD_BYTES, "My Song.mp3"

    monkeypatch.setattr(queue, "download_mp3", fake_download)

    submitted = worker_client.post(
        "/api/jobs",
        data={"url": "https://example.com/x", "extract_vocals": "true"},
    )
    job_id = submitted.json()["id"]
    job = _wait_for_terminal(worker_client, job_id)

    assert job["status"] == JobStatus.DONE, job["error_message"]
    assert job["title"] == "My Song"  # history shows the track, not the raw URL
    assert job["has_original"] is True

    stem = worker_client.get(f"/api/jobs/{job_id}/results/vocals")
    assert stem.content.endswith(b"vocals-audio")
    assert (
        quote("My Song - vocals - source-key-C-major.mp3")
        in stem.headers["content-disposition"]
    )


def test_failed_separation_surfaces_the_error_and_serves_no_stems(
    worker_client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    def boom(*args: object, **kwargs: object) -> object:
        raise RuntimeError("gpu exploded")

    monkeypatch.setattr(modal_client, "spawn", boom)

    job_id = _submit_upload(worker_client, extract_vocals=True)
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
    job_id = _submit_upload(
        worker_client, extract_vocals=True, extract_instruments=True
    )
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


def test_event_stream_heartbeats_and_delivers_terminal_event(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _fake_modal(monkeypatch, tmp_path)
    job_id = _submit_upload(client, extract_vocals=True, extract_instruments=True)
    monkeypatch.setattr(jobs_route, "_SSE_HEARTBEAT_INTERVAL", 0.001)

    async def consume_stream() -> tuple[dict, str, list[dict]]:
        record = db.get_job(job_id)
        assert record is not None
        response = await jobs_route.job_events(job_id, record.session_id)
        assert response.headers["cache-control"] == "no-cache"
        assert response.headers["x-accel-buffering"] == "no"
        stream = cast(AsyncIterator[str], aiter(response.body_iterator))
        initial = json.loads((await anext(stream)).removeprefix("data: "))
        heartbeat = await anext(stream)
        job = await asyncio.to_thread(db.claim_oldest_queued)
        assert job is not None and job.id == job_id
        await queue._run_job(job)
        payloads = [
            json.loads(chunk.removeprefix("data: "))
            async for chunk in stream
            if chunk.startswith("data: ")
        ]
        return initial, heartbeat, payloads

    async def bounded_stream() -> tuple[dict, str, list[dict]]:
        return await asyncio.wait_for(consume_stream(), timeout=1)

    initial, heartbeat, payloads = asyncio.run(bounded_stream())

    assert initial["status"] == JobStatus.QUEUED
    assert heartbeat == ": keep-alive\n\n"
    assert payloads[0]["status"] == JobStatus.RUNNING
    assert payloads[-1]["status"] == JobStatus.DONE
    assert payloads[-1]["original_key"] == "C major"
    assert [entry["label"] for entry in payloads[-1]["manifest"]] == [
        "vocals",
        "instruments",
    ]


def test_event_stream_snapshot_catches_completion_after_subscription(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    job_id = _submit_upload(client)
    original_subscribe = events.subscribe

    def subscribe_then_complete(target_id: int) -> asyncio.Queue[dict]:
        subscription = original_subscribe(target_id)
        db.mark_done(target_id, [])
        return subscription

    monkeypatch.setattr(events, "subscribe", subscribe_then_complete)

    async def consume_stream() -> list[dict]:
        record = db.get_job(job_id)
        assert record is not None
        response = await jobs_route.job_events(job_id, record.session_id)
        stream = cast(AsyncIterator[str], aiter(response.body_iterator))
        return [json.loads(chunk.removeprefix("data: ")) async for chunk in stream]

    async def bounded_stream() -> list[dict]:
        return await asyncio.wait_for(consume_stream(), timeout=1)

    frames = asyncio.run(bounded_stream())

    assert [frame["status"] for frame in frames] == [JobStatus.DONE]
    assert frames[0]["id"] == job_id
    assert frames[0]["manifest"] == []


def test_worker_publishes_progress_to_stream_subscribers(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # The live half of the SSE contract: a subscriber gets a running event when
    # the worker picks the job up and a done event carrying the manifest. Driven
    # directly (the `client` fixture runs no worker, so nothing else claims the
    # job) to keep a regression here a failure rather than a hang.
    _fake_modal(monkeypatch, tmp_path)
    job_id = _submit_upload(client, extract_vocals=True, extract_instruments=True)

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

    assert payloads[0]["status"] == JobStatus.RUNNING
    assert payloads[-1]["status"] == JobStatus.DONE
    assert any(payload["original_key"] == "C major" for payload in payloads[:-1])
    assert [entry["label"] for entry in payloads[-1]["manifest"]] == [
        "vocals",
        "instruments",
    ]


def test_results_are_persisted_under_the_data_dir(
    worker_client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # Stems must survive a restart, so they live on disk rather than in memory.
    _fake_modal(monkeypatch, tmp_path)
    job_id = _submit_upload(
        worker_client, extract_vocals=True, extract_instruments=True
    )
    _wait_for_terminal(worker_client, job_id)

    results = config.RESULTS_DIR / str(job_id)
    assert sorted(p.name for p in results.glob("*.mp3")) == [
        "instruments.mp3",
        "vocals.mp3",
    ]
    assert (results / "vocals.mp3").read_bytes().endswith(b"vocals-audio")


@pytest.mark.skipif(
    any(
        shutil.which(tool) is None
        for tool in ("rubberband", "keyfinder-cli", "ffprobe")
    ),
    reason="Native audio tools are required (available in nix develop)",
)
def test_pitch_and_tempo_modify_every_download_but_not_the_original(
    worker_client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tone_wav((261.6256, 329.6276, 391.9954))
    monkeypatch.setattr(queue, "detect_key", audio.detect_key)
    call = _FakeCall(
        object_id="fc-audio",
        result={
            label: StemResult(data=source, duration_s=1.0)
            for label in ("vocals", "instruments")
        },
    )
    monkeypatch.setattr(modal_client, "spawn", lambda *args: call)
    monkeypatch.setattr(modal_client, "poll", lambda *args: call.result)

    response = worker_client.post(
        "/api/jobs",
        files={"file": ("C major.wav", source, "audio/wav")},
        data={
            "extract_vocals": "true",
            "extract_instruments": "true",
            "pitch_semitones": "2",
            "tempo_percent": "120",
        },
    )
    assert response.status_code == 200
    job_id = response.json()["id"]
    job = _wait_for_terminal(worker_client, job_id, timeout_s=30)
    assert job["status"] == JobStatus.DONE, job["error_message"]
    assert job["original_key"] == "C major"
    assert job["output_key"] == "D major"
    assert worker_client.get(f"/api/jobs/{job_id}/original").content == source
    assert [entry["label"] for entry in job["manifest"]] == [
        "song",
        "vocals",
        "instruments",
    ]

    for entry in job["manifest"]:
        assert "pitch+2st" in entry["filename"]
        assert "tempo120pct" in entry["filename"]
        assert entry["download_name"] == (
            f"C major - {entry['label']} - source-key-C-major"
            " - pitch+2st - tempo120pct.mp3"
        )
        assert "source-key" not in entry["filename"]
        result = worker_client.get(f"/api/jobs/{job_id}/results/{entry['label']}")
        assert result.status_code == 200
        assert quote(entry["download_name"]) in result.headers["content-disposition"]
        assert len(result.content) == entry["size_bytes"]
        path = config.RESULTS_DIR / str(job_id) / entry["filename"]
        duration = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                str(path),
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        assert float(duration.stdout) == pytest.approx(4 / 1.2, abs=0.12)

    # Reloads/history must retain the analysis and transformations, not just SSE.
    historical = worker_client.get("/api/jobs").json()[0]
    assert historical["original_key"] == "C major"
    assert historical["output_key"] == "D major"
    assert historical["options"]["pitch_semitones"] == 2
    assert historical["options"]["tempo_percent"] == 120


@pytest.mark.skipif(
    any(
        shutil.which(tool) is None
        for tool in ("ffmpeg", "rubberband", "keyfinder-cli", "yt-dlp")
    ),
    reason="Native audio and downloader tools required",
)
@pytest.mark.parametrize("source_type", ["upload", "url"])
@pytest.mark.parametrize("modified", [False, True])
def test_whole_song_jobs_bypass_modal_and_preserve_original(
    worker_client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    source_type: str,
    modified: bool,
) -> None:
    source = tone_wav((440.0,), duration_s=2)
    analyses = []

    def analyze(data: bytes, filename: str) -> str | None:
        analyses.append(filename)
        return audio.detect_key(data, filename)

    def forbidden(*args: object, **kwargs: object) -> object:
        raise AssertionError("download-only jobs must never spawn Modal")

    monkeypatch.setattr(queue, "detect_key", analyze)
    monkeypatch.setattr(modal_client, "spawn", forbidden)
    options = {"no_cache": "true"}
    if modified:
        options.update(pitch_semitones="12", tempo_percent="125")
    handler = partial(SimpleHTTPRequestHandler, directory=str(tmp_path))
    with ThreadingHTTPServer(("127.0.0.1", 0), handler) as server:
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            if source_type == "url":
                wav = tmp_path / "source.wav"
                mp3 = tmp_path / "source.mp3"
                wav.write_bytes(source)
                subprocess.run(
                    ["ffmpeg", "-v", "error", "-i", str(wav), "-q:a", "0", str(mp3)],
                    check=True,
                    capture_output=True,
                )
                source = mp3.read_bytes()
                url = f"http://127.0.0.1:{server.server_port}/source.mp3"
                preview = worker_client.post("/api/key-analysis", data={"url": url})
                assert preview.status_code == 200
                assert preview.json() == {
                    "original_key": audio.detect_key(source, "source.mp3")
                }
                assert worker_client.get("/api/jobs").json() == []
                response = worker_client.post(
                    "/api/jobs",
                    data={
                        **options,
                        "url": url,
                    },
                )
            else:
                response = worker_client.post(
                    "/api/jobs",
                    files={"file": ("source.wav", source, "audio/wav")},
                    data=options,
                )
            assert response.status_code == 200
            job_id = response.json()["id"]
            job = _wait_for_terminal(worker_client, job_id, timeout_s=30)
        finally:
            server.shutdown()
            thread.join()
    assert job["status"] == JobStatus.DONE, job["error_message"]
    assert len(analyses) == 1
    stored = db.get_job(job_id)
    assert stored is not None and stored.modal_call_id is None
    assert job["has_original"] is True
    original = worker_client.get(f"/api/jobs/{job_id}/original")
    assert original.content == source
    extension = "mp3" if source_type == "url" else "wav"
    assert f"original.{extension}" in original.headers["content-disposition"]
    assert [entry["label"] for entry in job["manifest"]] == (
        ["song"] if modified else []
    )
    if modified:
        result = worker_client.get(f"/api/jobs/{job_id}/results/song")
        assert result.status_code == 200
        duration, frequency = mp3_measurements(result.content)
        assert duration == pytest.approx(2 / 1.25, abs=0.12)
        assert frequency == pytest.approx(880, rel=0.02)
        assert "pitch%2B12st" in result.headers["content-disposition"]
    else:
        assert (
            worker_client.get(f"/api/jobs/{job_id}/results/vocals").status_code == 404
        )
    historical = worker_client.get("/api/jobs").json()[0]
    assert historical["manifest"] == job["manifest"]


@pytest.mark.skipif(
    any(shutil.which(tool) is None for tool in ("ffmpeg", "rubberband", "ffprobe")),
    reason="Native audio tools required",
)
@pytest.mark.parametrize(("pitch", "tempo"), [(12, 125), (-2.5, 80), (0.125, 100)])
def test_pitched_full_source_is_not_reconstructed_from_selected_stem(
    worker_client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    pitch: float,
    tempo: float,
) -> None:
    source = tone_wav((440.0,), duration_s=2)
    separated = tone_wav((220.0,), duration_s=2)
    call = _FakeCall(
        "fc-distinct-source",
        {"instruments": StemResult(separated, 1.0)},
    )
    monkeypatch.setattr(modal_client, "spawn", lambda *args: call)
    monkeypatch.setattr(modal_client, "poll", lambda *args: call.result)
    response = worker_client.post(
        "/api/jobs",
        files={"file": ("complete-source.wav", source, "audio/wav")},
        data={
            "extract_instruments": "true",
            "pitch_semitones": str(pitch),
            "tempo_percent": str(tempo),
        },
    )
    assert response.status_code == 200
    job_id = response.json()["id"]
    job = _wait_for_terminal(worker_client, job_id, timeout_s=30)
    assert job["status"] == JobStatus.DONE, job["error_message"]
    assert [entry["label"] for entry in job["manifest"]] == ["song", "instruments"]
    assert worker_client.get(f"/api/jobs/{job_id}/original").content == source
    for entry, frequency in zip(job["manifest"], (440, 220), strict=True):
        result = worker_client.get(f"/api/jobs/{job_id}/results/{entry['label']}")
        assert result.status_code == 200
        duration, actual_frequency = mp3_measurements(result.content)
        assert duration == pytest.approx(2 * 100 / tempo, abs=0.12)
        assert actual_frequency == pytest.approx(
            frequency * 2 ** (pitch / 12), rel=0.02
        )
        metadata = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format_tags=title",
                "-of",
                "json",
                str(config.RESULTS_DIR / str(job_id) / entry["filename"]),
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        assert (
            json.loads(metadata.stdout)["format"]["tags"]["title"]
            == entry["download_name"][:-4]
        )
        assert "source-key-C-major" in entry["download_name"]
    historical = worker_client.get("/api/jobs").json()[0]
    assert historical["manifest"] == job["manifest"]
