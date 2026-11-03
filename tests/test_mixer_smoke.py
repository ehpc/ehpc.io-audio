"""Ephemeral real-GPU HTTP/queue/RPC proof; never contacts a deployed app."""

import io
import json
import math
import os
import socket
import subprocess
import threading
import time
import uuid
import wave
from dataclasses import asdict
from pathlib import Path

import httpx
import modal
import pytest
import uvicorn
from audio_samples import decode_audio
from mixer_rpc import isolated_separate
from mutagen.id3 import ID3

from backend import config, modal_client
from backend.main import app as web_app
from separator.audio import mix_audio
from separator.modal_app import GPU, TIMEOUT, image
from separator.options import OPTIONS_SCHEMA_VERSION, MixSpec, SeparationOptions

pytestmark = [pytest.mark.smoke, pytest.mark.timeout(TIMEOUT * 2 + 300)]


@pytest.mark.parametrize("cleanup", [False, True], ids=["raw", "clean"])
def test_ephemeral_gpu_queue_delivers_arbitrary_mixes(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, cleanup: bool
) -> None:
    """Exercise real models, RPC, queue, HTTP downloads, names and original bytes."""
    source = subprocess.run(
        [
            "node",
            "--input-type=module",
            "-e",
            "import { vocalFixture } from './frontend/e2e/fixture.mjs';"
            "process.stdout.write(await vocalFixture(20261103));",
        ],
        check=True,
        capture_output=True,
        timeout=180,
    ).stdout
    with wave.open(io.BytesIO(source)) as pcm:
        duration = pcm.getnframes() / pcm.getframerate()
    components = [
        ("drums", "bass"),
        ("drums", "vocals"),
        ("bass", "vocals"),
        ("drums", "other"),
        ("drums", "bass", "vocals"),
        *((part, "instruments") for part in ("female", "male", "lead", "backing")),
    ]
    mixes = tuple(
        MixSpec(f"mix-{index + 1}", " + ".join(parts), parts)
        for index, parts in enumerate(components)
    )
    evidence = Path(os.environ.get("MIXER_EVIDENCE_DIR", str(tmp_path)))
    if cleanup:
        evidence /= "clean"
    evidence.mkdir(parents=True, exist_ok=True)
    name = f"stem-mixer-proof-{uuid.uuid4().hex[:12]}"
    remote_app = modal.App(name)
    with modal.Volume.ephemeral() as volume:
        function = remote_app.function(
            image=image.add_local_python_source("mixer_rpc"),
            gpu=GPU,
            timeout=TIMEOUT,
            volumes={"/private-models": volume},
        )(isolated_separate)
        with modal.enable_output(), remote_app.run():
            monkeypatch.setattr(modal_client, "_get_function", lambda name: function)
            monkeypatch.setattr(config, "QUEUE_CONCURRENCY", 1)
            monkeypatch.setattr(config, "QUEUE_POLL_INTERVAL_S", 0.1)
            listener = socket.socket()
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
            server = uvicorn.Server(
                uvicorn.Config(web_app, log_level="warning", loop="asyncio")
            )
            thread = threading.Thread(target=server.run, kwargs={"sockets": [listener]})
            thread.start()
            try:
                deadline = time.monotonic() + 15
                while not server.started:
                    assert thread.is_alive() and time.monotonic() < deadline
                    time.sleep(0.05)
                with httpx.Client(
                    base_url=f"http://127.0.0.1:{port}", timeout=30
                ) as client:
                    submitted = client.post(
                        "/api/jobs",
                        files={"file": ("Real music.wav", source, "audio/wav")},
                        data={
                            "mixes": json.dumps([asdict(mix) for mix in mixes]),
                            "decrowd": str(cleanup).lower(),
                            "decrowd_vocals": str(cleanup).lower(),
                            "dereverb": str(cleanup).lower(),
                        },
                    )
                    submitted.raise_for_status()
                    job_id = submitted.json()["id"]
                    deadline = time.monotonic() + TIMEOUT + 120
                    while True:
                        job = client.get(f"/api/jobs/{job_id}").json()
                        if job["status"] in {"done", "failed"}:
                            break
                        assert time.monotonic() < deadline
                        time.sleep(1)
                    assert job["status"] == "done", job["error_message"]
                    cleanup_labels = (
                        [
                            "vocals-decrowded",
                            "vocals-decrowded-dry",
                            "instruments-decrowded",
                        ]
                        if cleanup
                        else []
                    )
                    assert [entry["label"] for entry in job["manifest"]] == [
                        *cleanup_labels,
                        *(mix.id for mix in mixes),
                    ]
                    assert client.get(f"/api/jobs/{job_id}/original").content == source
                    report = {
                        "app": name,
                        "job_id": job_id,
                        "source_duration_s": duration,
                        "options": job["options"],
                        "audio": [],
                    }
                    references = {}
                    if cleanup:
                        reference = function.remote(
                            source,
                            "reference.wav",
                            SeparationOptions(
                                extract_vocals=True,
                                extract_instruments=True,
                                genders=True,
                                lead_backing=True,
                                drums=True,
                                decrowd=True,
                                decrowd_vocals=True,
                                dereverb=True,
                            ),
                            options_schema=OPTIONS_SCHEMA_VERSION,
                        )
                        for label, result in reference.items():
                            path = tmp_path / f"{label}.mp3"
                            path.write_bytes(result.data)
                            references[label] = path
                    component_labels = {
                        "drums": "drums",
                        "bass": "bass",
                        "other": "other-instruments",
                        "vocals": "vocals-decrowded-dry",
                        "instruments": "instruments-decrowded",
                        "female": "vocals-female-dry",
                        "male": "vocals-male-dry",
                        "lead": "lead-dry",
                        "backing": "backing-dry",
                    }
                    for entry in job["manifest"]:
                        response = client.get(
                            f"/api/jobs/{job_id}/results/{entry['label']}"
                        )
                        response.raise_for_status()
                        data = response.content
                        (evidence / entry["filename"]).write_bytes(data)
                        audio = decode_audio(data)
                        assert len(audio.channels) == 2
                        if entry["label"].startswith("mix-"):
                            assert audio.sample_rate == 48000
                        assert audio.duration_s == pytest.approx(duration, abs=0.15)
                        assert 1e-6 < audio.peak < 1
                        assert ID3(io.BytesIO(data))["TIT2"].text == [
                            entry["download_name"].removesuffix(".mp3")
                        ]
                        report["audio"].append(
                            {
                                **entry,
                                "sample_rate": audio.sample_rate,
                                "channels": len(audio.channels),
                                "duration": audio.duration_s,
                                "peak": audio.peak,
                            }
                        )
                        if cleanup and entry["label"].startswith("mix-"):
                            mix = next(mix for mix in mixes if mix.id == entry["label"])
                            expected_path = tmp_path / "expected.mp3"
                            mix_audio(
                                [
                                    references[component_labels[part]]
                                    for part in mix.components
                                ],
                                expected_path,
                            )
                            expected = decode_audio(expected_path.read_bytes())
                            errors = [
                                (actual - wanted) ** 2
                                for actual, wanted in zip(
                                    audio.channels[0], expected.channels[0], strict=True
                                )
                            ]
                            rms_error = math.sqrt(sum(errors) / len(errors))
                            assert rms_error < 0.002
                            report["audio"][-1]["clean_reference_rms_error"] = rms_error
                    (evidence / "proof.json").write_text(json.dumps(report, indent=2))
                    print(f"MIXER_PROOF {evidence / 'proof.json'}")
            finally:
                server.should_exit = True
                thread.join(timeout=15)
                listener.close()
                assert not thread.is_alive()
