"""Owned subprocess server for the drain/restart regression, never Modal inference."""

import json
import os
import time
from dataclasses import dataclass
from pathlib import Path
from unittest.mock import patch

import uvicorn
from inference_fixture import StemSignal, cpu_inference, fixture_manifest
from transport_fixture import LocalVolume, produce_result

from backend import config, inference, modal_client, queue
from backend.main import app
from separator.inference_transport import load_request

ROOT = Path(os.environ["DATA_DIR"])
PRODUCER = ROOT / "cpu-producer"
VOLUME = LocalVolume(ROOT / "private-transport")
fixture_manifest(
    PRODUCER,
    signals={"vocals": StemSignal(440, 1), "instruments": StemSignal(660, 1)},
)
config.PRODUCER_MANIFEST = PRODUCER / "fixture-manifest.json"
config.QUEUE_POLL_INTERVAL_S = 0.02
patch.object(queue, "detect_key", lambda audio, name, root: "C major").start()


@dataclass
class Call:
    output_id: str
    object_id: str


def prepare(manifest, request, artifact_root, volume_name, environment):
    manifest.verify_assets(PRODUCER)
    model = (
        request.parameters.get("model") if request.operation == "separation" else None
    )
    assert request.producer_digest == manifest.digest_for(request.operation, model)


def spawn(output_id, *, operation=None, producer_digest=None):
    request = load_request(VOLUME.root, output_id)
    with (ROOT / "accepted.jsonl").open("a") as log:
        log.write(
            json.dumps({"model": request.parameters["model"], "output_id": output_id})
            + "\n"
        )
        log.flush()
    produce_result(
        VOLUME,
        output_id,
        lambda staged: cpu_inference(staged, staged.fingerprint(), root=PRODUCER),
    )
    return Call(output_id, output_id)


def poll(call, timeout):
    # Hold the first already-accepted call inside polling, not inside spawn's
    # dispatch lock, so the real lifecycle command can close admission.
    if not (ROOT / "release").exists():
        (ROOT / "polling").touch()
        while not (ROOT / "release").exists():
            time.sleep(0.01)
    return call.output_id


patch.object(inference, "ensure_prepared", prepare).start()
patch.object(modal_client, "_get_transport_volume", lambda: VOLUME).start()
patch.object(modal_client, "spawn", spawn).start()
patch.object(modal_client, "resume", lambda call_id: Call(call_id, call_id)).start()
patch.object(modal_client, "poll", poll).start()

if __name__ == "__main__":
    uvicorn.run(
        app, host="127.0.0.1", port=int(os.environ["TEST_PORT"]), log_level="error"
    )
