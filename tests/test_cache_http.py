"""Real HTTP/restart proof with owned PCM and CPU separation, never production/NN."""

import json
import os
import socket
import subprocess
import sys
import time
from collections import Counter
from contextlib import contextmanager
from io import BytesIO
from pathlib import Path

import httpx
import pytest
from audio_samples import mp3_measurements, tone_wav
from mutagen.id3 import ID3


@contextmanager
def server(root, port, prohibit="", key_version=""):
    environment = dict(
        os.environ,
        DATA_DIR=str(root),
        PYTHONPATH=str(Path(__file__).resolve().parent.parent),
        QUEUE_CONCURRENCY="2",
        COOKIE_SECRET="owned-cache-proof",
        COOKIE_SECURE="false",
        CACHE_PORT=str(port),
        CACHE_FORBID=prohibit,
        CACHE_KEY_VERSION=key_version,
    )
    process = subprocess.Popen(
        [sys.executable, str(Path(__file__).with_name("cache_http_worker.py"))],
        env=environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    try:
        with httpx.Client(base_url=f"http://127.0.0.1:{port}", timeout=30) as client:
            deadline = time.monotonic() + 20
            while True:
                assert process.poll() is None, process.communicate()[0].decode()
                try:
                    if client.get("/api/jobs").status_code == 200:
                        break
                except httpx.ConnectError:
                    pass
                assert time.monotonic() < deadline
                time.sleep(0.05)
            yield client
    finally:
        process.terminate()
        try:
            process.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.communicate()


def finish(client, response):
    response.raise_for_status()
    job_id = response.json()["id"]
    deadline = time.monotonic() + 30
    while True:
        result = client.get(f"/api/jobs/{job_id}").json()
        if result["status"] in {"done", "failed"}:
            assert result["status"] == "done", result.get("error_message")
            return result
        assert time.monotonic() < deadline
        time.sleep(0.05)


def trace(root):
    return Counter(
        json.loads(line)
        for line in (root / "producer-trace.jsonl").read_text().splitlines()
    )


def test_http_cross_session_restart_reuses_native_artifacts(tmp_path):
    (tmp_path / "source.wav").write_bytes(tone_wav((440, 660), 1, channels=2))
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    mix = {
        "id": "mix-first",
        "name": "First private name",
        "components": ["vocals", "instruments"],
    }
    with server(tmp_path, port) as client:
        url = f"http://127.0.0.1:{port}/owned-source.wav"
        preview = client.post("/api/key-analysis", data={"url": url})
        assert preview.status_code == 200, preview.text
        job = finish(
            client,
            client.post("/api/jobs", data={"url": url, "mixes": json.dumps([mix])}),
        )
        original = client.get(f"/api/jobs/{job['id']}/original").content
        assert job["original_key"] == preview.json()["original_key"]
        first_id = job["id"]
        first = trace(tmp_path)
        assert first == Counter(download=1, decode=1, key=1, stem=2, mix=1)
    mix.update(id="mix-second", name="Second private name")
    options = {
        "mixes": json.dumps([mix]),
        "pitch_semitones": "2",
        "tempo_percent": "125",
    }
    with server(tmp_path, port, "download,decode,key,stem,mix") as client:
        job = finish(
            client,
            client.post(
                "/api/jobs",
                files={"file": ("different-filename.mp3", original, "audio/mpeg")},
                data=options,
            ),
        )
        assert client.get(f"/api/jobs/{first_id}").status_code == 404
        assert client.get(f"/api/jobs/{first_id}/original").status_code == 404
        assert [item["id"] for item in client.get("/api/jobs").json()] == [job["id"]]
        modified = client.get(f"/api/jobs/{job['id']}/results/mix-second").content
        second_id = job["id"]
        second = trace(tmp_path)
        assert second - first == Counter(transform=2)
    mix.update(id="mix-third", name="Third private name")
    options["mixes"] = json.dumps([mix])
    with server(tmp_path, port, "download,decode,key,stem,mix,transform") as client:
        job = finish(
            client,
            client.post(
                "/api/jobs",
                files={"file": ("third.mp3", original, "audio/mpeg")},
                data=options,
            ),
        )
        assert client.get(f"/api/jobs/{second_id}").status_code == 404
        repeated = client.get(f"/api/jobs/{job['id']}/results/mix-third").content
        assert trace(tmp_path) == second
        assert (
            ID3(BytesIO(repeated))["TIT2"].text[0]
            != ID3(BytesIO(modified))["TIT2"].text[0]
        )
        first_audio = BytesIO(modified)
        repeated_audio = BytesIO(repeated)
        ID3(first_audio).delete(first_audio)
        ID3(repeated_audio).delete(repeated_audio)
        assert first_audio.getvalue() == repeated_audio.getvalue()
        assert mp3_measurements(repeated)[0] == pytest.approx(0.8, abs=0.1)
    with server(
        tmp_path, port, "download,decode,stem,mix,transform", "owned-key-version-change"
    ) as client:
        job = finish(
            client,
            client.post(
                "/api/jobs",
                files={"file": ("fourth.mp3", original, "audio/mpeg")},
                data=options,
            ),
        )
        assert job["status"] == "done"
        assert trace(tmp_path) - second == Counter(key=1)
    print(
        "CACHE_HTTP_PROOF "
        + json.dumps(
            {
                "initial": dict(first),
                "changed_pitch_tempo": dict(second),
                "after_restart_and_key_version": dict(trace(tmp_path)),
                "private_history": True,
            }
        )
    )
