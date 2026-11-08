"""Subprocess crash harness for durable CPU-backed inference acceptance tests."""

import json
import os
import sys
import threading
from dataclasses import asdict, replace
from pathlib import Path
from types import SimpleNamespace

import pytest
from inference_fixture import cpu_inference

from backend import config, db, inference, modal_client, reconcile_inference
from separator.artifact_cache import atomic_write, digest
from separator.inference import InferenceResult
from separator.processing import ProcessingContext
from separator.producer_manifest import load_manifest
from separator.structure import assemble_structure

CRASH_BEFORE_RECORD = 71
CRASH_AFTER_RECORD = 72
UNCERTAIN = 73
REJECTED = 74
CRASH_BEFORE_DISPATCH = 75
CALL_ID = "fc-owned-cpu-durable-stage"


def append_durable(path: Path, value: str) -> None:
    with path.open("a") as output:
        output.write(value + "\n")
        output.flush()
        os.fsync(output.fileno())


def main() -> None:
    root, job_id, mode = Path(sys.argv[1]), int(sys.argv[2]), sys.argv[3]
    config.DATA_DIR = root / "data"
    config.DB_PATH = config.DATA_DIR / "jobs.db"
    db.init_db()
    producer = root / "producer"
    manifest = load_manifest(producer / "fixture-manifest.json")
    source = (root / "source.wav").read_bytes()

    def forbidden(*args, **kwargs):
        raise AssertionError("completed or accepted inference was dispatched again")

    def verify_prepared(actual_manifest, request, *args):
        actual_manifest.verify_assets(producer)
        assert request.producer_digest == actual_manifest.digest_for(request.operation)

    def spawn(request):
        if mode == "crash-not-dispatched":
            os._exit(CRASH_BEFORE_DISPATCH)
        if not mode.startswith("crash-") and mode != "produce":
            forbidden()
        accepted = request
        if mode.endswith("-wrong-result"):
            accepted = replace(
                request, audio_bytes=(root / "different.wav").read_bytes()
            )
        data = cpu_inference(accepted, accepted.fingerprint(), root=producer)
        # Acceptance survives abrupt interpreter death, independently of the
        # orchestration database and its local completed-artifact cache.
        atomic_write(root / "remote-result.bin", data)
        atomic_write(
            root / "remote-call.json",
            json.dumps(
                {
                    "call_id": CALL_ID,
                    "request_fingerprint": accepted.fingerprint(),
                }
            ).encode(),
        )
        append_durable(root / "accepted.log", accepted.fingerprint())
        return SimpleNamespace(object_id=CALL_ID)

    original_record = db.set_active_stage

    def record_then_crash(owner_id, key, call_id):
        assert call_id == CALL_ID
        assert (root / "remote-result.bin").is_file()
        if mode.startswith("crash-unrecorded"):
            os._exit(CRASH_BEFORE_RECORD)
        original_record(owner_id, key, call_id)
        os._exit(CRASH_AFTER_RECORD)

    def resume(call_id):
        assert call_id == CALL_ID
        append_durable(root / "resumed.log", call_id)
        return SimpleNamespace(object_id=call_id)

    def poll(call, timeout):
        receipt = json.loads((root / "remote-call.json").read_text())
        assert call.object_id == receipt["call_id"]
        return InferenceResult(
            receipt["request_fingerprint"], (root / "remote-result.bin").read_bytes()
        )

    patch = pytest.MonkeyPatch()
    patch.setattr(inference, "ensure_prepared", verify_prepared)
    patch.setattr(modal_client, "spawn", spawn)
    patch.setattr(modal_client, "resume", resume)
    patch.setattr(modal_client, "poll", poll)
    if mode.startswith("reconcile-"):
        config.QUEUE_CONCURRENCY = 1 if mode == "reconcile-active-release" else 0
        sys.argv = [
            "backend.reconcile_inference",
            "--job-id",
            str(job_id),
            "--admission-drained",
        ]
        sys.argv += (
            ["--call-id", CALL_ID]
            if mode == "reconcile-call"
            else ["--verified-not-dispatched"]
        )
        try:
            reconcile_inference.main()
        except (RuntimeError, ValueError) as error:
            print(json.dumps({"status": "rejected", "error": str(error)}), flush=True)
            raise SystemExit(REJECTED) from None
        return
    if mode.startswith("crash-"):
        patch.setattr(db, "set_active_stage", record_then_crash)
    if mode == "cache-only":
        patch.setattr(inference, "ensure_prepared", forbidden)
        patch.setattr(db, "claim_inference_stage", forbidden)
        patch.setattr(modal_client, "spawn", forbidden)
        patch.setattr(modal_client, "resume", forbidden)
        patch.setattr(modal_client, "poll", forbidden)
    context = ProcessingContext(
        config.DATA_DIR / "artifacts",
        manifest,
        inference.StageRunner(job_id, manifest, threading.Event()),
    )
    try:
        result = context.stage(
            "structure",
            source,
            "source.wav",
            {},
            digest(source),
            lambda data: assemble_structure(**json.loads(data)),
        )
    except inference.UncertainInferenceDispatch:
        print(json.dumps({"status": "uncertain"}), flush=True)
        raise SystemExit(UNCERTAIN) from None
    except ValueError as error:
        print(json.dumps({"status": "rejected", "error": str(error)}), flush=True)
        raise SystemExit(REJECTED) from None
    print(json.dumps({"status": "complete", "result": asdict(result)}), flush=True)


if __name__ == "__main__":
    main()
