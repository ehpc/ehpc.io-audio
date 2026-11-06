"""Real audio consumption, cache publication and privacy at the listening API."""

import hashlib
import json
import shutil
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread

import pytest
from fastapi.testclient import TestClient

from backend import config, db, modal_client, playback
from backend.models import ResultManifestEntry
from separator import cache_versions
from separator.pitch import PitchAnalysis, PitchTrack, pitch_to_json
from tests.audio_samples import decode_audio, ffmpeg_tone, frequency_amplitude

pytestmark = pytest.mark.skipif(
    not (shutil.which("ffmpeg") and shutil.which("ffprobe")),
    reason="native FFmpeg and FFprobe required",
)


def _mp3(tmp_path: Path, rate: int = 48000, frequency: float = 440) -> Path:
    wav = ffmpeg_tone(
        tmp_path / f"tone-{rate}-{frequency}.wav",
        (frequency, 660),
        amplitude=1.2,
        duration_s=0.8,
        sample_rate=rate,
    )
    source = wav.with_suffix(".mp3")
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-i",
            str(wav),
            "-c:a",
            "libmp3lame",
            "-q:a",
            "0",
            str(source),
        ],
        check=True,
        capture_output=True,
    )
    return source


def _pcm(path: Path) -> bytes:
    return subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-i",
            str(path),
            "-map",
            "0:a:0",
            "-c:a",
            "pcm_f32le",
            "-f",
            "f32le",
            "pipe:1",
        ],
        check=True,
        capture_output=True,
    ).stdout


def _encoded_frames(path: Path) -> bytes:
    return subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-i",
            str(path),
            "-map",
            "0:a:0",
            "-c:a",
            "copy",
            "-f",
            "data",
            "pipe:1",
        ],
        check=True,
        capture_output=True,
    ).stdout


def _discard_padding(source: Path) -> int:
    value = json.loads(
        subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-select_streams",
                "a:0",
                "-show_packets",
                "-show_entries",
                "packet_side_data=discard_padding",
                "-of",
                "json",
                str(source),
            ],
            check=True,
            capture_output=True,
        ).stdout
    )
    return sum(
        side.get("discard_padding", 0)
        for packet in value["packets"]
        for side in packet.get("side_data_list", [])
    )


def _job(
    client: TestClient,
    source: Path,
    name: str | None = None,
    *,
    private_only: bool = False,
) -> int:
    response = client.post(
        "/api/jobs",
        files={
            "file": (
                name or source.name,
                source.read_bytes(),
                "application/octet-stream",
            )
        },
    )
    assert response.status_code == 200
    job_id = response.json()["id"]
    directory = config.RESULTS_DIR / str(job_id)
    directory.mkdir(parents=True)
    shutil.copyfile(source, directory / "vocals.mp3")
    shutil.copyfile(source, directory / ".pitch-vocals.mp3")
    db.mark_done(
        job_id,
        []
        if private_only
        else [
            ResultManifestEntry(
                label="vocals",
                filename="vocals.mp3",
                size_bytes=source.stat().st_size,
                duration_s=0.8,
            )
        ],
        pitch_json=pitch_to_json(PitchAnalysis(0.8, 0.8, [PitchTrack("vocals", [])])),
    )
    return job_id


@pytest.fixture(autouse=True)
def _no_models(monkeypatch: pytest.MonkeyPatch) -> None:
    def forbidden(*args, **kwargs):
        pytest.fail("Listening requests must not run or recover models")

    for name in ("spawn", "spawn_with_lyrics", "cached_pitch_vocals"):
        monkeypatch.setattr(modal_client, name, forbidden)


@pytest.mark.parametrize(
    ("endpoint", "rate"),
    [("original", 48000), ("results/vocals", 44100), ("pitch-reference/vocals", 16000)],
)
def test_listening_consumption_preserves_signal_and_downloads(
    client: TestClient, tmp_path: Path, endpoint: str, rate: int
) -> None:
    source = _mp3(tmp_path, rate)
    # Actual format, not extension or upload MIME, determines eligibility.
    job_id = _job(
        client,
        source,
        "misleading.wav",
        private_only=endpoint == "pitch-reference/vocals",
    )
    before = db.get_job(job_id)
    original = config.UPLOADS_DIR / str(job_id) / "misleading.wav"
    original_hash = cache_versions.file_revision(original)
    public = config.RESULTS_DIR / str(job_id) / "vocals.mp3"
    public_hash = cache_versions.file_revision(public)
    response = client.get(f"/api/jobs/{job_id}/{endpoint}?playback=1")
    assert response.status_code == 200
    assert response.headers["content-type"] == "audio/mp4"
    assert response.headers["content-disposition"] == "inline"
    consumed = decode_audio(response.content)
    assert consumed.sample_rate == rate
    assert len(consumed.channels) == 2
    assert consumed.peak > 1.0  # Float decoder headroom must not be clipped.
    assert frequency_amplitude(consumed, 440) == pytest.approx(1.2, abs=0.03)
    assert frequency_amplitude(consumed, 660, channel=1) == pytest.approx(1.2, abs=0.03)
    indexed = tmp_path / "consumed.mp4"
    indexed.write_bytes(response.content)
    source_pcm, indexed_pcm = _pcm(source), _pcm(indexed)
    assert indexed_pcm[: len(source_pcm)] == source_pcm
    assert len(indexed_pcm) - len(source_pcm) == _discard_padding(source) * 2 * 4
    assert _encoded_frames(indexed) == _encoded_frames(source)
    assert db.get_job(job_id) == before
    assert cache_versions.file_revision(original) == original_hash
    assert cache_versions.file_revision(public) == public_hash
    download = client.get(f"/api/jobs/{job_id}/original")
    assert hashlib.sha256(download.content).hexdigest() == original_hash
    assert frequency_amplitude(decode_audio(download.content), 440) == pytest.approx(
        1.2, abs=0.03
    )


@pytest.mark.parametrize("kind", ["mpeg25", "wav", "flac"])
def test_out_of_scope_audio_still_plays_without_level_or_clock_changes(
    client: TestClient, tmp_path: Path, kind: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    if kind == "mpeg25":
        source = _mp3(tmp_path, 8000)
    else:
        source = ffmpeg_tone(
            tmp_path / "input.wav", (440, 660), amplitude=0.6, duration_s=0.8
        )
        if kind == "flac":
            target = source.with_suffix(".flac")
            subprocess.run(
                [
                    "ffmpeg",
                    "-v",
                    "error",
                    "-i",
                    str(source),
                    "-c:a",
                    "flac",
                    str(target),
                ],
                check=True,
                capture_output=True,
            )
            source = target
    job_id = _job(client, source)
    ordinary = client.get(f"/api/jobs/{job_id}/original")
    response = client.get(f"/api/jobs/{job_id}/original?playback=1")
    assert response.status_code == 200
    assert response.headers["content-type"] == ordinary.headers["content-type"]
    consumed = decode_audio(response.content)
    expected = decode_audio(ordinary.content)
    assert consumed.sample_rate == expected.sample_rate
    assert len(consumed.channels) == 2
    assert consumed.duration_s == expected.duration_s
    assert consumed.peak == expected.peak
    amplitude = 1.2 if kind == "mpeg25" else 0.6
    assert frequency_amplitude(consumed, 440) == pytest.approx(amplitude, abs=0.03)
    assert frequency_amplitude(consumed, 660, channel=1) == pytest.approx(
        amplitude, abs=0.03
    )
    assert not list((config.DATA_DIR / "artifacts" / "playback").glob("*.mp4"))

    def no_more_native(*args):
        pytest.fail("Cached format decisions must not reprobe on Range requests")

    monkeypatch.setattr(playback, "_run", no_more_native)
    middle = len(response.content) // 2
    parts = [
        client.get(f"/api/jobs/{job_id}/original?playback=1", headers={"Range": value})
        for value in (f"bytes=0-{middle - 1}", f"bytes={middle}-")
    ]
    assert all(part.status_code == 206 for part in parts)
    rebuilt = decode_audio(b"".join(part.content for part in parts))
    assert frequency_amplitude(rebuilt, 440) == pytest.approx(amplitude, abs=0.03)


def test_owner_checked_before_cache_and_missing_private_audio_never_recovers(
    client: TestClient,
    other_client: TestClient,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    job_id = _job(client, _mp3(tmp_path))
    endpoints = ["original", "results/vocals", "pitch-reference/vocals"]
    for endpoint in endpoints:
        result = client.get(f"/api/jobs/{job_id}/{endpoint}?playback=1")
        assert frequency_amplitude(decode_audio(result.content), 440) > 1
    (config.RESULTS_DIR / str(job_id) / "vocals.mp3").unlink()
    private = client.get(f"/api/jobs/{job_id}/pitch-reference/vocals?playback=1")
    assert frequency_amplitude(decode_audio(private.content), 440) > 1

    def forbidden_cache(*args):
        pytest.fail("Unauthorized/missing sources must not reach the playback cache")

    monkeypatch.setattr("backend.routes.results.listening_path", forbidden_cache)
    for endpoint in endpoints:
        for method in (other_client.get, other_client.head):
            assert (
                method(f"/api/jobs/{job_id}/{endpoint}?playback=1").status_code == 404
            )
    (config.RESULTS_DIR / str(job_id) / ".pitch-vocals.mp3").unlink()
    assert (
        client.get(f"/api/jobs/{job_id}/pitch-reference/vocals?playback=1").status_code
        == 404
    )
    assert (
        client.head(f"/api/jobs/{job_id}/results/vocals?playback=1").status_code == 404
    )


def test_cached_head_and_ranges_reconstruct_native_audio_without_native_work(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    job_id = _job(client, _mp3(tmp_path))
    url = f"/api/jobs/{job_id}/original?playback=1"
    first = client.get(url)
    length = len(first.content)

    def no_more_native(*args):
        pytest.fail("A valid listening cache hit must not probe or mux")

    monkeypatch.setattr(playback, "_run", no_more_native)
    head = client.head(url)
    assert head.status_code == 200 and not head.content
    assert int(head.headers["content-length"]) == length
    partial_head = client.head(url, headers={"Range": "bytes=0-127"})
    assert partial_head.status_code == 206 and not partial_head.content
    assert partial_head.headers["content-range"] == f"bytes 0-127/{length}"
    assert int(partial_head.headers["content-length"]) == 128
    cut = length // 2
    first_half = client.get(url, headers={"Range": f"bytes=0-{cut - 1}"})
    last_half = client.get(url, headers={"Range": f"bytes={cut}-"})
    assert first_half.status_code == last_half.status_code == 206
    assert first_half.content == first.content[:cut]
    assert last_half.content == first.content[cut:]
    consumed = decode_audio(first_half.content + last_half.content)
    assert frequency_amplitude(consumed, 440) == pytest.approx(1.2, abs=0.03)
    assert consumed.peak > 1.0
    invalid = client.get(url, headers={"Range": f"bytes={length}-"})
    assert invalid.status_code == 416


def test_corrupt_cache_is_rebuilt_before_audio_consumption(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    job_id = _job(client, _mp3(tmp_path))
    url = f"/api/jobs/{job_id}/original?playback=1"
    first = client.get(url)
    root = config.DATA_DIR / "artifacts" / "playback"
    cached = next(root.glob("*.mp4"))
    with cached.open("r+b") as handle:
        handle.seek(-100, 2)
        handle.write(b"corrupted audio")
    calls = []
    real_run = playback._run

    def count(command):
        calls.append(command[0])
        return real_run(command)

    monkeypatch.setattr(playback, "_run", count)
    rebuilt = client.get(url)
    assert "ffmpeg" in calls
    assert _pcm_from_response(tmp_path, rebuilt.content) == _pcm_from_response(
        tmp_path, first.content
    )
    calls.clear()
    next(root.glob("*.json")).write_text('{"checksum":"damaged"}')
    repaired = client.get(url)
    assert "ffmpeg" in calls
    assert frequency_amplitude(decode_audio(repaired.content), 440) > 1
    assert not list(root.glob(".pending-*"))


def _pcm_from_response(tmp_path: Path, data: bytes) -> bytes:
    path = tmp_path / "response.mp4"
    path.write_bytes(data)
    return _pcm(path)


@pytest.mark.parametrize("failure", ["mux", "timeout"])
def test_eligible_producer_errors_are_visible_without_fallback_or_publication(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, failure: str
) -> None:
    job_id = _job(client, _mp3(tmp_path))
    real_run = playback._run

    def fail_converter(command):
        if command[0] == "ffmpeg":
            if failure == "mux":
                command = [*command[:-2], "not-a-real-muxer", command[-1]]
            else:
                monkeypatch.setattr(playback, "_PREPARATION_TIMEOUT_S", 0.000001)
        return real_run(command)

    monkeypatch.setattr(playback, "_run", fail_converter)
    result = client.get(f"/api/jobs/{job_id}/original?playback=1")
    assert result.status_code == 503
    root = config.DATA_DIR / "artifacts" / "playback"
    assert not list(root.glob("*.mp4")) and not list(root.glob("*.json"))
    assert not list(root.glob(".pending-*"))
    original = client.get(f"/api/jobs/{job_id}/original")
    assert frequency_amplitude(decode_audio(original.content), 440) > 1


@pytest.mark.parametrize("change", ["source", "producer", "binary"])
def test_cache_invalidation_runs_real_producer_and_preserves_new_audio(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, change: str
) -> None:
    source = _mp3(tmp_path)
    root = tmp_path / "cache"
    native_calls: list[str] = []
    real_run = playback._run

    def tracked_run(command: list[str]) -> bytes:
        result = real_run(command)
        native_calls.append(command[0])
        return result

    monkeypatch.setattr(playback, "_run", tracked_run)
    first = playback.listening_path(source, root)
    assert first is not None
    native_calls.clear()
    if change == "source":
        replacement = _mp3(tmp_path, frequency=880)
        shutil.copyfile(replacement, source)
    elif change == "producer":
        monkeypatch.setattr(
            cache_versions, "PLAYBACK", cache_versions.PLAYBACK + "-changed"
        )
    else:
        real_revision = cache_versions.binary_revision
        monkeypatch.setattr(
            cache_versions,
            "binary_revision",
            lambda name: real_revision(name) + "-changed",
        )
    second = playback.listening_path(source, root)
    assert second is not None
    assert native_calls.count("ffmpeg") == 1
    consumed = decode_audio(second.read_bytes())
    assert frequency_amplitude(consumed, 880 if change == "source" else 440) > 1
    assert _pcm(second).startswith(_pcm(source))
    native_calls.clear()
    hit = playback.listening_path(source, root)
    assert hit is not None
    assert not native_calls
    assert (
        frequency_amplitude(
            decode_audio(hit.read_bytes()), 880 if change == "source" else 440
        )
        > 1
    )


def test_concurrent_processes_publish_one_real_indexed_file(tmp_path: Path) -> None:
    source = _mp3(tmp_path)
    root = tmp_path / "cache"
    trace = tmp_path / "producers.txt"
    script = """
import sys,time
from pathlib import Path
from backend import playback
source,root,trace=map(Path,sys.argv[1:])
real=playback._run
def run(command):
    if command[0]=='ffmpeg':
        with trace.open('a') as output: output.write('producer\\n')
        time.sleep(.1)
    return real(command)
playback._run=run
assert playback.listening_path(source,root).is_file()
"""
    processes = [
        subprocess.Popen(
            [sys.executable, "-c", script, str(source), str(root), str(trace)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        for _ in range(4)
    ]
    try:
        for process in processes:
            _, errors = process.communicate(timeout=30)
            assert process.returncode == 0, errors.decode()
    finally:
        for process in processes:
            if process.poll() is None:
                process.kill()
                process.wait()
    assert trace.read_text().splitlines() == ["producer"]
    indexed = next(root.glob("*.mp4"))
    assert _pcm(indexed).startswith(_pcm(source))
    assert frequency_amplitude(decode_audio(indexed.read_bytes()), 440) > 1
    assert not list(root.glob(".pending-*"))


def test_uploaded_playlist_cannot_make_listening_probe_fetch_remote_audio(
    client: TestClient, tmp_path: Path
) -> None:
    audio = _mp3(tmp_path).read_bytes()
    requested = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            requested.append(self.path)
            self.send_response(200)
            self.send_header("Content-Type", "audio/mpeg")
            self.end_headers()
            self.wfile.write(audio)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        playlist = (
            "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n"
            "#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:0.8,\n"
            f"http://127.0.0.1:{server.server_port}/audio.mp3\n#EXT-X-ENDLIST\n"
        ).encode()
        submitted = client.post(
            "/api/jobs",
            files={"file": ("source.m3u8", playlist, "application/vnd.apple.mpegurl")},
        )
        job_id = submitted.json()["id"]
        response = client.get(f"/api/jobs/{job_id}/original?playback=1")
        assert response.status_code == 503
        assert not requested
        root = config.DATA_DIR / "artifacts" / "playback"
        assert not list(root.glob("*.mp4")) and not list(root.glob("*.json"))
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
