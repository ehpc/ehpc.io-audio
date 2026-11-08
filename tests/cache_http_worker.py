"""Owned HTTP proof: native audio and finite synthetic CPU inference, never NN."""

import json
import os
from dataclasses import dataclass
from pathlib import Path
from unittest.mock import patch

import uvicorn
from fastapi.responses import FileResponse
from inference_fixture import StemSignal, cpu_inference, fixture_manifest
from transport_fixture import LocalVolume, produce_result

from backend import config, inference, modal_client
from backend.main import app
from separator import audio, cache_versions, stems
from separator.inference import InferenceRequest
from separator.inference_transport import validate_output_id

ROOT = Path(os.environ["DATA_DIR"])
TRACE = ROOT / "producer-trace.jsonl"
PRODUCER = ROOT / "cpu-producer"
VOLUME = LocalVolume(ROOT / "private-transport")
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
    output_id: str
    object_id: str


def prepare(manifest, request, artifact_root, volume_name, environment):
    # Verify this actual CPU producer's assets instead of a neural model volume.
    manifest.verify_assets(PRODUCER)
    model = (
        request.parameters.get("model") if request.operation == "separation" else None
    )
    assert request.producer_digest == manifest.digest_for(request.operation, model)


def spawn(output_id: str, *, operation=None, producer_digest=None) -> Call:
    # The actual staged input, not the RPC arguments, drives finite inference.
    produce_result(VOLUME, output_id, produce)
    return Call(output_id, output_id)


def resume(call_id: str) -> Call:
    validate_output_id(call_id)
    return Call(call_id, call_id)


def produce(request: InferenceRequest) -> bytes:
    if request.operation != "separation":
        raise AssertionError("This HTTP cache proof requests only separation")
    return cpu_inference(request, request.fingerprint(), root=PRODUCER)


produce = observed("stem", produce)
patch.object(inference, "ensure_prepared", prepare).start()
patch.object(modal_client, "_get_transport_volume", lambda: VOLUME).start()
patch.object(modal_client, "spawn", spawn).start()
patch.object(modal_client, "resume", resume).start()
patch.object(modal_client, "poll", lambda call, timeout: call.output_id).start()
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
