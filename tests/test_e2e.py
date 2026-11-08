"""End-to-end tests: a real HTTP submit, picked up by the real queue worker, run
through the real stem graph, and served back as a real stem download.

Finite inference runs through a synthetic CPU producer instead of Modal. The
VPS graph, form parsing, sqlite, worker loop, result persistence, SSE stream,
native audio processing and download routes all execute for real.
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
from inference_fixture import StemSignal, cpu_inference, fixture_manifest

from backend import config, db, events, inference, modal_client, queue
from backend.models import JobStatus
from backend.routes import jobs as jobs_route
from separator import audio, stems
from separator.inference import InferenceRequest, InferenceResult
from separator.options import SeparationOptions

_TERMINAL = (JobStatus.DONE, JobStatus.FAILED)
_UPLOAD_BYTES = tone_wav((440.0,), duration_s=1)
_STEM_FREQUENCIES = {
    "vocals": 330,
    "instruments": 220,
    "vocals-decrowded": 440,
    "vocals-decrowded-dry": 550,
    "vocals-male": 660,
    "vocals-male-dry": 770,
    "vocals-female": 880,
    "vocals-female-dry": 990,
}
pytestmark = pytest.mark.skipif(
    any(shutil.which(tool) is None for tool in ("ffmpeg", "ffprobe")),
    reason="CPU inference and decoded download measurements require FFmpeg",
)


@pytest.fixture(autouse=True)
def _key_analysis(monkeypatch: pytest.MonkeyPatch) -> None:
    # Native key detection has dedicated coverage; use a stable key for HTTP metadata.
    monkeypatch.setattr(queue, "detect_key", lambda audio, name, root: "C major")


@dataclass
class _CpuCall:
    object_id: str
    result: InferenceResult
    polls: int = 0


def _cpu_modal(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    *,
    signals: dict[str, StemSignal] | None = None,
) -> list[InferenceRequest]:
    """Replace finite remote inference, retaining VPS orchestration and artifacts."""
    root = tmp_path / "cpu-producer"
    fixture_manifest(
        root,
        signals=(
            {
                label: StemSignal(frequency, 1)
                for label, frequency in _STEM_FREQUENCIES.items()
            }
            if signals is None
            else signals
        ),
    )
    monkeypatch.setattr(config, "PRODUCER_MANIFEST", root / "fixture-manifest.json")
    spawned: list[InferenceRequest] = []

    def prepare(manifest, request, artifact_root, volume_name, environment):
        # This provider consumes local fixture assets, not a remote model volume.
        manifest.verify_assets(root)
        model = (
            request.parameters.get("model")
            if request.operation == "separation"
            else None
        )
        assert request.producer_digest == manifest.digest_for(request.operation, model)

    def spawn(request: InferenceRequest) -> _CpuCall:
        spawned.append(request)
        return _CpuCall(
            object_id=f"fc-cpu-{len(spawned)}",
            result=InferenceResult(
                request.fingerprint(),
                cpu_inference(request, request.fingerprint(), root=root),
            ),
        )

    def poll(call: _CpuCall, timeout: float) -> InferenceResult | None:
        call.polls += 1
        return call.result if call.polls > 1 else None

    monkeypatch.setattr(inference, "ensure_prepared", prepare)
    monkeypatch.setattr(modal_client, "spawn", spawn)
    monkeypatch.setattr(modal_client, "poll", poll)
    return spawned


def _assert_stem_audio(data: bytes, label: str) -> None:
    duration, frequency = mp3_measurements(data)
    assert duration == pytest.approx(1, abs=0.1)
    assert frequency == pytest.approx(_STEM_FREQUENCIES[label], rel=0.02)


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
    spawned = _cpu_modal(monkeypatch, tmp_path)

    job_id = _submit_upload(
        worker_client, extract_vocals=True, extract_instruments=True
    )
    job = _wait_for_terminal(worker_client, job_id)

    assert job["status"] == JobStatus.DONE, job["error_message"]
    assert [entry["label"] for entry in job["manifest"]] == ["vocals", "instruments"]
    # Each independent base model receives the original uploaded bytes.
    assert len(spawned) == 2
    assert all(request.audio_bytes == _UPLOAD_BYTES for request in spawned)
    assert [request.parameters["model"] for request in spawned] == [
        stems.VOCALS_STEM.model,
        stems.INSTRUMENTS_STEM.model,
    ]

    for label in ("vocals", "instruments"):
        stem = worker_client.get(f"/api/jobs/{job_id}/results/{label}")
        assert stem.status_code == 200
        _assert_stem_audio(stem.content, label)
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
    _cpu_modal(monkeypatch, tmp_path)

    job_id = _submit_upload(
        worker_client, decrowd_vocals=True, dereverb=True, genders=True
    )
    job = _wait_for_terminal(worker_client, job_id)

    assert job["status"] == JobStatus.DONE, job["error_message"]
    stored = db.get_job(job_id)
    assert stored is not None
    assert stored.options == SeparationOptions(
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
        _assert_stem_audio(stem.content, label)


def test_url_job_downloads_titles_and_separates(
    worker_client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _cpu_modal(monkeypatch, tmp_path)

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
    _assert_stem_audio(stem.content, "vocals")
    assert (
        quote("My Song - vocals - source-key-C-major.mp3")
        in stem.headers["content-disposition"]
    )


def test_failed_separation_surfaces_the_error_and_serves_no_stems(
    worker_client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _cpu_modal(monkeypatch, tmp_path)

    def boom(*args: object, **kwargs: object) -> object:
        raise RuntimeError("gpu exploded")

    monkeypatch.setattr(modal_client, "poll", boom)

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
    _cpu_modal(monkeypatch, tmp_path)
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
    _cpu_modal(monkeypatch, tmp_path)
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
        return await asyncio.wait_for(consume_stream(), timeout=10)

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
    _cpu_modal(monkeypatch, tmp_path)
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
    _cpu_modal(monkeypatch, tmp_path)
    job_id = _submit_upload(
        worker_client, extract_vocals=True, extract_instruments=True
    )
    _wait_for_terminal(worker_client, job_id)

    results = config.RESULTS_DIR / str(job_id)
    assert sorted(p.name for p in results.glob("*.mp3")) == [
        "instruments.mp3",
        "vocals.mp3",
    ]
    _assert_stem_audio((results / "vocals.mp3").read_bytes(), "vocals")


@pytest.mark.skipif(
    any(
        shutil.which(tool) is None
        for tool in ("rubberband", "keyfinder-cli", "ffprobe")
    ),
    reason="Native audio tools are required (available in nix develop)",
)
def test_pitch_and_tempo_modify_every_download_but_not_the_original(
    worker_client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    source = tone_wav((261.6256, 329.6276, 391.9954))
    monkeypatch.setattr(queue, "detect_key", audio.detect_key)
    _cpu_modal(monkeypatch, tmp_path, signals={})

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

    def analyze(data: bytes, filename: str, root: Path) -> str | None:
        analyses.append(filename)
        return audio.detect_key(data, filename, root)

    def forbidden(*args: object, **kwargs: object) -> object:
        raise AssertionError("download-only jobs must never spawn Modal")

    monkeypatch.setattr(queue, "detect_key", analyze)
    monkeypatch.setattr(modal_client, "spawn", forbidden)
    options = {}
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
    tmp_path: Path,
    pitch: float,
    tempo: float,
) -> None:
    source = tone_wav((440.0,), duration_s=2)
    _cpu_modal(
        monkeypatch,
        tmp_path,
        signals={"instruments": StemSignal(220, 2)},
    )
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
