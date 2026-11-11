"""Real Uvicorn drain and restart with a private finite CPU producer."""

import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import httpx
import pytest
from audio_samples import mp3_measurements, tone_wav

from separator.stems import INSTRUMENTS_STEM, VOCALS_STEM

pytestmark = pytest.mark.skipif(
    any(shutil.which(tool) is None for tool in ("ffmpeg", "ffprobe")),
    reason="the finite CPU producer requires FFmpeg",
)


def wait_until(predicate, process, *, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        assert process.poll() is None, f"server exited with {process.returncode}"
        value = predicate()
        if value:
            return value
        time.sleep(0.02)
    pytest.fail("timed out waiting for subprocess condition")


def test_server_drain_checkpoints_requeues_and_resumes_same_job(tmp_path):
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    origin = f"http://127.0.0.1:{port}"
    project = Path(__file__).resolve().parent.parent
    worker = Path(__file__).with_name("drain_http_worker.py")
    # A short private path avoids the platform's UNIX socket length limit.
    with tempfile.TemporaryDirectory(prefix="vocal-drain-") as socket_dir:
        env = {
            "PATH": os.environ.get("PATH", ""),
            "HOME": str(tmp_path),
            "PYTHONPATH": str(project),
            "TMPDIR": socket_dir,
            "DATA_DIR": str(tmp_path),
            "QUEUE_CONCURRENCY": "1",
            "AUTH_ORIGIN": origin,
            "AUTH_OTP_SECRET": "fixture-otp-secret-0123456789abcdef",
            "AUTH_INVITE_SECRET": "fixture-invite-secret-0123456789abcdef",
            "TEST_PORT": str(port),
        }
        provision = (
            "from backend import auth_store,db; db.init_db(); "
            "email='drain-test@example.invalid'; "
            "_,invite=auth_store.create_invite(None); "
            "challenge=auth_store.start(email,invite,'127.0.0.1'); "
            "print(auth_store.verify(email,challenge[1],invite)[0])"
        )
        token = subprocess.check_output(
            [sys.executable, "-c", provision], cwd=project, env=env, text=True
        ).strip()
        drain_client = None
        server = None
        log_path = tmp_path / "server.log"
        with (
            log_path.open("wb") as log,
            httpx.Client(
                base_url=origin,
                headers={"origin": origin},
                cookies={"auth_session": token},
                timeout=5,
                trust_env=False,
            ) as client,
        ):

            def start_server():
                process = subprocess.Popen(
                    [sys.executable, str(worker)],
                    cwd=project,
                    env=env,
                    stdout=log,
                    stderr=subprocess.STDOUT,
                )

                def ready():
                    try:
                        return client.get("/ready").status_code == 200
                    except httpx.ConnectError:
                        return False

                wait_until(ready, process)
                return process

            try:
                server = start_server()
                response = client.post(
                    "/api/jobs",
                    files={"file": ("source.wav", tone_wav((440,), 1), "audio/wav")},
                    data={"extract_vocals": "true", "extract_instruments": "true"},
                )
                assert response.status_code == 200, response.text
                job_id = response.json()["id"]
                wait_until(lambda: (tmp_path / "polling").exists(), server)
                accepted_path = tmp_path / "accepted.jsonl"
                accepted = [
                    json.loads(line) for line in accepted_path.read_text().splitlines()
                ]
                assert [entry["model"] for entry in accepted] == [VOCALS_STEM.model]
                assert client.get(f"/api/jobs/{job_id}").json()["status"] == "running"

                # Execute the production drain client against the private TMPDIR
                # socket; it must not finish while the accepted call is held.
                drain_client = subprocess.Popen(
                    [sys.executable, "-m", "backend.drain"],
                    cwd=project,
                    env=env,
                    stdout=log,
                    stderr=subprocess.STDOUT,
                )
                wait_until(lambda: client.get("/ready").status_code == 503, server)
                assert client.get("/health").status_code == 200
                assert client.post("/api/jobs", data={}).status_code == 503
                assert drain_client.poll() is None
                assert [
                    json.loads(line) for line in accepted_path.read_text().splitlines()
                ] == accepted

                (tmp_path / "release").touch()
                assert drain_client.wait(timeout=30) == 0
                assert client.get(f"/api/jobs/{job_id}").json()["status"] == "queued"
                assert [
                    json.loads(line) for line in accepted_path.read_text().splitlines()
                ] == accepted
                artifacts = list((tmp_path / "artifacts" / "inference").glob("*.bin"))
                assert len(artifacts) == 1
                artifact = artifacts[0]
                checkpoint = artifact.read_bytes()
                receipt = json.loads(
                    (
                        tmp_path
                        / "artifacts"
                        / "inference-requests"
                        / f"{artifact.stem}.json"
                    ).read_bytes()
                )
                assert receipt["cleaned"] is True

                server.terminate()
                assert server.wait(timeout=20) in (0, -15)
                server = start_server()

                def terminal():
                    result = client.get(f"/api/jobs/{job_id}").json()
                    return result if result["status"] in {"done", "failed"} else None

                result = wait_until(terminal, server)
                assert result["status"] == "done", result.get("error_message")
                assert {entry["label"] for entry in result["manifest"]} == {
                    "vocals",
                    "instruments",
                }
                for label, frequency in (("vocals", 440), ("instruments", 660)):
                    response = client.get(f"/api/jobs/{job_id}/results/{label}")
                    assert response.status_code == 200
                    duration, measured_frequency = mp3_measurements(response.content)
                    assert duration == pytest.approx(1, abs=0.1)
                    assert measured_frequency == pytest.approx(frequency, rel=0.02)
                assert artifact.read_bytes() == checkpoint
                accepted = [
                    json.loads(line) for line in accepted_path.read_text().splitlines()
                ]
                assert [entry["model"] for entry in accepted] == [
                    VOCALS_STEM.model,
                    INSTRUMENTS_STEM.model,
                ]
            finally:
                # Unblock a failed assertion so Uvicorn can exit its worker cleanly.
                (tmp_path / "release").touch()
                if drain_client is not None and drain_client.poll() is None:
                    drain_client.kill()
                    drain_client.wait(timeout=5)
                if server is not None and server.poll() is None:
                    server.terminate()
                    try:
                        server.wait(timeout=20)
                    except subprocess.TimeoutExpired:
                        server.kill()
                        server.wait(timeout=5)
