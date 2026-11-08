"""Subprocess crash harness for durable CPU-backed inference acceptance tests."""

import json
import os
import sys
import threading
import traceback
from dataclasses import asdict, replace
from pathlib import Path
from types import SimpleNamespace

import pytest
from inference_fixture import cpu_inference
from transport_fixture import LocalVolume

from backend import config, db, inference, modal_client, reconcile_inference
from separator import artifact_cache
from separator.artifact_cache import atomic_write, digest
from separator.inference_transport import load_request, publish_file
from separator.processing import ProcessingContext
from separator.producer_manifest import load_manifest
from separator.structure import assemble_structure

CRASH_BEFORE_RECORD = 71
CRASH_AFTER_RECORD = 72
UNCERTAIN = 73
REJECTED = 74
CRASH_BEFORE_DISPATCH = 75
LOCAL_WRITE_FAILED = 76
CRASH_BEFORE_CACHE = 77
NATIVE_FAILED = 78
CRASH_AFTER_FAILURE_LOG = 79
CRASH_AFTER_FAILURE_RECEIPT = 80
CRASH_AFTER_FAILURE_TERMINAL = 81
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
    volume = LocalVolume(root / "private-transport")

    def forbidden(*args, **kwargs):
        raise AssertionError("completed or accepted inference was dispatched again")

    def verify_prepared(actual_manifest, request, *args):
        actual_manifest.verify_assets(producer)
        assert request.producer_digest == actual_manifest.digest_for(request.operation)

    def spawn(output_id, *, operation=None, producer_digest=None):
        if mode == "crash-not-dispatched":
            os._exit(CRASH_BEFORE_DISPATCH)
        if not mode.startswith("crash-") and mode not in {
            "produce",
            "local-write-fails",
            "cleanup-fails",
            "failure-crash-after-log",
            "failure-crash-after-receipt",
            "failure-crash-after-terminal",
            "failure-cleanup-fails",
        }:
            forbidden()
        request = load_request(volume.root, output_id)
        accepted = request
        if mode.endswith("-wrong-result"):
            accepted = replace(
                request, audio_bytes=(root / "different.wav").read_bytes()
            )
        try:
            data = cpu_inference(accepted, accepted.fingerprint(), root=producer)
        except Exception as error:
            # Preserve actual native CPU failure evidence, including FFmpeg's
            # stderr, rather than manufacturing a remote exception response.
            if not mode.startswith("failure-"):
                raise
            data = traceback.format_exc().encode() + getattr(error, "stderr", b"")
            failed = True
        else:
            failed = False
            assert not mode.startswith("failure-"), (
                "Expected invalid-audio decode failure"
            )
        # Acceptance survives abrupt interpreter death independently of the
        # orchestration database and its local completed-artifact cache.
        atomic_write(root / "remote-result.bin", data)
        publish_file(
            volume.root, output_id, accepted, root / "remote-result.bin", failed=failed
        )
        atomic_write(
            root / "remote-call.json",
            json.dumps(
                {
                    "call_id": CALL_ID,
                    "output_id": output_id,
                    "request_fingerprint": accepted.fingerprint(),
                    "failed": failed,
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
        return receipt["output_id"]

    patch = pytest.MonkeyPatch()
    patch.setattr(inference, "ensure_prepared", verify_prepared)
    patch.setattr(modal_client, "_get_transport_volume", lambda: volume)
    patch.setattr(modal_client, "spawn", spawn)
    patch.setattr(modal_client, "resume", resume)
    patch.setattr(modal_client, "poll", poll)
    original_read_result = modal_client.read_result

    def read_result(*args, **kwargs):
        try:
            return original_read_result(*args, **kwargs)
        except modal_client.InferenceStageFailure:
            if mode == "failure-crash-after-log":
                os._exit(CRASH_AFTER_FAILURE_LOG)
            raise

    patch.setattr(modal_client, "read_result", read_result)
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
    if mode.startswith(("crash-unrecorded", "crash-recorded")):
        patch.setattr(db, "set_active_stage", record_then_crash)
    if mode in {"cache-only", "failure-local-only"}:
        patch.setattr(inference, "ensure_prepared", forbidden)
        patch.setattr(modal_client, "spawn", forbidden)
        patch.setattr(modal_client, "resume", forbidden)
        patch.setattr(modal_client, "poll", forbidden)
    if mode == "cache-only":
        patch.setattr(db, "claim_inference_stage", forbidden)
    if mode == "failure-local-only":
        patch.setattr(modal_client, "read_result", forbidden)
    original_write = artifact_cache.atomic_write

    def write_artifact(path, data):
        if path.parent.name == "inference" and path.suffix == ".bin":
            if mode == "crash-before-cache":
                os._exit(CRASH_BEFORE_CACHE)
            if mode == "local-write-fails":
                raise OSError("owned artifact disk is unavailable")
        original_write(path, data)

    patch.setattr(artifact_cache, "atomic_write", write_artifact)
    original_cleanup = modal_client.cleanup

    def cleanup(output_id):
        receipt = json.loads((root / "remote-call.json").read_text())
        assert output_id == receipt["output_id"]
        # Remote deletion requires durable consumer evidence. Failure cleanup
        # additionally requires the recorded consumer's terminal DB state.
        if receipt.get("failed"):
            diagnostics = (
                config.DATA_DIR
                / "artifacts"
                / "inference-diagnostics"
                / f"{output_id}.log"
            )
            assert diagnostics.read_bytes() == (root / "remote-result.bin").read_bytes()
            receipts = (config.DATA_DIR / "artifacts" / "inference-requests").glob(
                "*.json"
            )
            binding = next(
                item
                for path in receipts
                if (item := json.loads(path.read_bytes()))["output_id"] == output_id
            )
            failed_job = db.get_job(binding["failure_job_id"])
            assert failed_job is not None and failed_job.status == "failed"
        else:
            paths = list((config.DATA_DIR / "artifacts" / "inference").glob("*.bin"))
            assert any(
                path.read_bytes() == (root / "remote-result.bin").read_bytes()
                for path in paths
            )
        append_durable(root / "cleanup-attempts.log", output_id)
        if mode in {"cleanup-fails", "failure-cleanup-fails"}:
            raise OSError("owned private Volume deletion is unavailable")
        original_cleanup(output_id)

    patch.setattr(modal_client, "cleanup", cleanup)
    if mode == "failure-sweep":
        count = inference.cleanup_completed_transfers()
        print(json.dumps({"status": "swept", "cleaned": count}), flush=True)
        return
    runner = inference.StageRunner(job_id, manifest, threading.Event())
    context = ProcessingContext(
        config.DATA_DIR / "artifacts",
        manifest,
        runner,
        on_committed=runner.committed,
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
    except modal_client.InferenceStageFailure as error:
        if mode == "failure-crash-after-receipt":
            os._exit(CRASH_AFTER_FAILURE_RECEIPT)
        db.mark_failed(job_id, str(error))
        if mode == "failure-crash-after-terminal":
            os._exit(CRASH_AFTER_FAILURE_TERMINAL)
        inference.cleanup_completed_transfers()
        print(json.dumps({"status": "native-failed", "error": str(error)}), flush=True)
        raise SystemExit(NATIVE_FAILED) from None
    except ValueError as error:
        print(json.dumps({"status": "rejected", "error": str(error)}), flush=True)
        raise SystemExit(REJECTED) from None
    except OSError as error:
        print(
            json.dumps({"status": "local-write-failed", "error": str(error)}),
            flush=True,
        )
        raise SystemExit(LOCAL_WRITE_FAILED) from None
    print(json.dumps({"status": "complete", "result": asdict(result)}), flush=True)


if __name__ == "__main__":
    main()
