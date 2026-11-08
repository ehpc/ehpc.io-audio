"""Owned HTTP proof: native audio and finite synthetic CPU inference, never NN."""

import json
import os
from dataclasses import dataclass
from pathlib import Path
from unittest.mock import patch

import uvicorn
from fastapi.responses import FileResponse
from inference_fixture import StemSignal, cpu_inference, fixture_manifest

from backend import config, inference, modal_client
from backend.main import app
from separator import audio, cache_versions, stems
from separator.artifact_cache import atomic_write
from separator.inference import InferenceRequest, InferenceResult

ROOT = Path(os.environ["DATA_DIR"])
TRACE = ROOT / "producer-trace.jsonl"
PRODUCER = ROOT / "cpu-producer"
RESPONSES = ROOT / "cpu-responses"
RESPONSES.mkdir(parents=True, exist_ok=True)
fixture_manifest(
    PRODUCER,
    signals={"vocals": StemSignal(440, 1), "instruments": StemSignal(660, 1)},
)
config.PRODUCER_MANIFEST = PRODUCER / "fixture-manifest.json"


def observed(name, producer):
    def call(*args, **kwargs):
        prohibited = os.environ.get("CACHE_FORBID", "").split(",")
        if name in prohibited:
            raise AssertionError(f"persistent hit recomputed {name}")
        with TRACE.open("a") as handle:
            handle.write(json.dumps(name) + "\n")
        return producer(*args, **kwargs)

    return call


if os.environ.get("CACHE_KEY_VERSION"):
    patch.object(cache_versions, "KEY", os.environ["CACHE_KEY_VERSION"]).start()
for symbol, name in (
    ("_decode_key_audio", "decode"),
    ("_detect_decoded_key", "key"),
    ("_transform_audio", "transform"),
):
    setattr(audio, symbol, observed(name, getattr(audio, symbol)))
stems.mix_audio = observed("mix", stems.mix_audio)
# Both import sites must retain the same real yt-dlp observer.
from backend import queue  # noqa: E402
from backend.routes import key_analysis  # noqa: E402

queue.download_mp3 = observed("download", queue.download_mp3)
key_analysis.download_mp3 = queue.download_mp3


@dataclass
class Call:
    result: InferenceResult
    object_id: str


def prepare(manifest, request, artifact_root, volume_name, environment):
    # Verify this actual CPU producer's assets instead of a neural model volume.
    manifest.verify_assets(PRODUCER)
    model = (
        request.parameters.get("model") if request.operation == "separation" else None
    )
    assert request.producer_digest == manifest.digest_for(request.operation, model)


def spawn(request: InferenceRequest) -> Call:
    if request.operation != "separation":
        raise AssertionError("This HTTP cache proof requests only separation")
    payload = produce(request)
    fingerprint = request.fingerprint()
    # Keep accepted responses outside the artifact cache so an interrupted VPS
    # can resume its recorded finite call after this process is restarted.
    atomic_write(RESPONSES / f"{fingerprint}.bin", payload)
    return Call(InferenceResult(fingerprint, payload), fingerprint)


def resume(call_id: str) -> Call:
    if len(call_id) != 64 or any(char not in "0123456789abcdef" for char in call_id):
        raise ValueError("Invalid owned CPU call identity")
    return Call(
        InferenceResult(call_id, (RESPONSES / f"{call_id}.bin").read_bytes()), call_id
    )


produce = observed(
    "stem", lambda request: cpu_inference(request, request.fingerprint(), root=PRODUCER)
)
patch.object(inference, "ensure_prepared", prepare).start()
patch.object(modal_client, "spawn", spawn).start()
patch.object(modal_client, "resume", resume).start()
patch.object(modal_client, "poll", lambda call, timeout: call.result).start()
config.QUEUE_POLL_INTERVAL_S = 0.02


@app.get("/owned-source.wav")
def owned_source():
    return FileResponse(ROOT / "source.wav")


# The production SPA fallback is deliberately last; the owned proof source must
# precede it too, without modifying any production route.
app.router.routes.insert(0, app.router.routes.pop())


if __name__ == "__main__":
    uvicorn.run(
        app, host="127.0.0.1", port=int(os.environ["CACHE_PORT"]), log_level="error"
    )
