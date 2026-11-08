"""Actual interpreter crashes must not turn accepted CPU stages into redispatches."""

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
from audio_samples import tone_wav
from inference_crash_worker import (
    CALL_ID,
    CRASH_AFTER_RECORD,
    CRASH_BEFORE_DISPATCH,
    CRASH_BEFORE_RECORD,
    REJECTED,
    UNCERTAIN,
)
from inference_fixture import fixture_manifest

from backend import config, db
from separator.artifact_cache import digest
from separator.inference import InferenceRequest
from separator.options import SeparationOptions
from separator.processing import ProcessingContext
from separator.structure import assemble_structure


@pytest.fixture
def durable_stage(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DATA_DIR", tmp_path / "data")
    monkeypatch.setattr(config, "DB_PATH", config.DATA_DIR / "jobs.db")
    db.init_db()
    source = tone_wav((220,), 1.25)
    (tmp_path / "source.wav").write_bytes(source)
    (tmp_path / "different.wav").write_bytes(tone_wav((440,), 0.5))
    manifest = fixture_manifest(tmp_path / "producer")
    owner = db.insert_job(
        "original-session",
        "upload",
        "source.wav",
        SeparationOptions(extract_lyrics=True),
    )

    def forbidden(*args):
        raise AssertionError("fixture setup cannot invoke a model")

    context = ProcessingContext(config.DATA_DIR / "artifacts", manifest, forbidden)
    key = context.key("structure", digest(source))
    request = InferenceRequest(
        "structure", source, "source.wav", manifest.digest_for("structure")
    )
    return tmp_path, owner, key, request


def run_worker(root, job_id, mode, expected):
    worker = Path(__file__).with_name("inference_crash_worker.py")
    project = worker.parent.parent
    environment = {
        **os.environ,
        "DATA_DIR": str(root / "data"),
        "QUEUE_CONCURRENCY": "0",
        "PYTHONPATH": os.pathsep.join(
            filter(None, [str(project), os.environ.get("PYTHONPATH", "")])
        ),
    }
    completed = subprocess.run(
        [sys.executable, str(worker), str(root), str(job_id), mode],
        cwd=project,
        env=environment,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert completed.returncode == expected, completed.stdout + completed.stderr
    return json.loads(completed.stdout) if completed.stdout.strip() else None


def artifact_path(root, key):
    return root / "data" / "artifacts" / "inference" / f"{key}.bin"


def new_equivalent_job():
    return db.insert_job(
        "different-session",
        "upload",
        "renamed.wav",
        SeparationOptions(extract_lyrics=True),
    )


def assert_single_acceptance(root, request):
    assert (root / "accepted.log").read_text().splitlines() == [request.fingerprint()]
    raw = json.loads((root / "remote-result.bin").read_bytes())
    structure = assemble_structure(**raw)
    assert structure.sections[0].label == "verse"
    assert structure.sections[0].start_s == 0
    assert structure.sections[0].end_s == pytest.approx(1.25)


def test_crash_after_acceptance_before_call_record_blocks_restart_and_new_job(
    durable_stage,
):
    root, owner, key, request = durable_stage
    run_worker(root, owner, "crash-unrecorded", CRASH_BEFORE_RECORD)
    assert_single_acceptance(root, request)
    assert not artifact_path(root, key).exists()
    persisted = db.get_job(owner)
    assert persisted is not None
    assert persisted.active_stage_key == key
    assert persisted.modal_call_id is None
    receipt = root / "data" / "artifacts" / "inference-requests" / f"{key}.json"
    assert json.loads(receipt.read_text()) == {
        "request_fingerprint": request.fingerprint(),
        "operation": "structure",
        "producer_digest": request.producer_digest,
    }

    assert run_worker(root, owner, "resume", UNCERTAIN) == {"status": "uncertain"}
    db.mark_failed(owner, "Dispatch acceptance was not durably acknowledged")
    replacement = new_equivalent_job()
    assert run_worker(root, replacement, "resume", UNCERTAIN) == {"status": "uncertain"}
    claim = db.claim_inference_stage(replacement, key)
    assert not claim.newly_claimed
    assert claim.owner.id == owner and claim.owner.modal_call_id is None
    assert not artifact_path(root, key).exists()
    assert not (root / "resumed.log").exists()
    assert_single_acceptance(root, request)


@pytest.mark.parametrize("replacement_job", [False, True], ids=["same-job", "new-job"])
def test_recorded_call_survives_restart_and_resumes_without_redispatch(
    durable_stage, replacement_job
):
    root, owner, key, request = durable_stage
    run_worker(root, owner, "crash-recorded", CRASH_AFTER_RECORD)
    assert_single_acceptance(root, request)
    persisted = db.get_job(owner)
    assert persisted is not None
    assert (persisted.active_stage_key, persisted.modal_call_id) == (key, CALL_ID)
    assert not artifact_path(root, key).exists()
    if replacement_job:
        db.mark_failed(owner, "Worker exited after recording the accepted call")
    consumer = new_equivalent_job() if replacement_job else owner
    result = run_worker(root, consumer, "resume", 0)
    assert result["status"] == "complete"
    assert result["result"]["sections"] == [
        {"start_s": 0, "end_s": 1.25, "label": "verse"}
    ]
    assert (root / "resumed.log").read_text().splitlines() == [CALL_ID]
    assert (
        artifact_path(root, key).read_bytes()
        == (root / "remote-result.bin").read_bytes()
    )
    assert_single_acceptance(root, request)

    # A further independent interpreter consumes the completed artifact before
    # asset preparation, claiming, resume, polling, or dispatch can run.
    assert run_worker(root, new_equivalent_job(), "cache-only", 0) == result
    assert (root / "resumed.log").read_text().splitlines() == [CALL_ID]
    assert_single_acceptance(root, request)


def test_mismatched_resumed_result_is_rejected_without_publishing_artifact(
    durable_stage,
):
    root, owner, key, request = durable_stage
    run_worker(root, owner, "crash-recorded-wrong-result", CRASH_AFTER_RECORD)
    remote = json.loads((root / "remote-call.json").read_text())
    assert remote["request_fingerprint"] != request.fingerprint()
    # The wrong result is itself a valid CPU inference artifact for other audio,
    # not malformed bytes that would be rejected by the stage validator anyway.
    actual = assemble_structure(**json.loads((root / "remote-result.bin").read_bytes()))
    assert actual.sections[0].end_s == pytest.approx(0.5)
    for consumer in (owner, new_equivalent_job()):
        result = run_worker(root, consumer, "resume", REJECTED)
        assert result["status"] == "rejected"
        assert "does not match the requested model stage" in result["error"]
        assert not artifact_path(root, key).exists()
    assert (root / "accepted.log").read_text().splitlines() == [
        remote["request_fingerprint"]
    ]
    assert not list(artifact_path(root, key).parent.glob(".pending-*"))
    persisted = db.get_job(owner)
    assert persisted is not None and persisted.modal_call_id == CALL_ID


def test_completed_stage_cache_precedes_an_uncertain_global_claim(durable_stage):
    root, owner, key, request = durable_stage
    run_worker(root, owner, "crash-recorded", CRASH_AFTER_RECORD)
    first = run_worker(root, owner, "resume", 0)
    assert artifact_path(root, key).is_file()
    # Completed bytes are authoritative even if a restored dispatch ledger has
    # retained only its intent and lost the corresponding remote call identifier.
    db.set_active_stage(owner, key, None)
    consumer = new_equivalent_job()
    claim = db.claim_inference_stage(consumer, key)
    assert not claim.newly_claimed
    assert claim.owner.id == owner and claim.owner.modal_call_id is None
    assert run_worker(root, consumer, "cache-only", 0) == first
    assert (root / "resumed.log").read_text().splitlines() == [CALL_ID]
    assert_single_acceptance(root, request)


def test_operator_cannot_attach_a_completed_response_for_another_request(durable_stage):
    root, owner, key, request = durable_stage
    run_worker(root, owner, "crash-unrecorded-wrong-result", CRASH_BEFORE_RECORD)
    remote = json.loads((root / "remote-call.json").read_text())
    assert remote["request_fingerprint"] != request.fingerprint()
    wrong = assemble_structure(**json.loads((root / "remote-result.bin").read_bytes()))
    assert wrong.sections[0].end_s == pytest.approx(0.5)
    db.mark_failed(owner, "Acceptance was not acknowledged")
    result = run_worker(root, owner, "reconcile-call", REJECTED)
    assert "does not match the recorded model request" in result["error"]
    persisted = db.get_job(owner)
    assert persisted is not None
    assert persisted.active_stage_key == key and persisted.modal_call_id is None
    assert persisted.status == "failed"
    replacement = new_equivalent_job()
    assert run_worker(root, replacement, "resume", UNCERTAIN) == {"status": "uncertain"}
    assert not artifact_path(root, key).exists()
    assert (root / "accepted.log").read_text().splitlines() == [
        remote["request_fingerprint"]
    ]


def test_operator_attaches_exact_completed_call_without_repaying_or_rewriting_history(
    durable_stage,
):
    root, owner, key, request = durable_stage
    run_worker(root, owner, "crash-unrecorded", CRASH_BEFORE_RECORD)
    assert_single_acceptance(root, request)
    db.mark_failed(owner, "Uncertain dispatch retained for operator reconciliation")
    original = db.get_job(owner)
    assert original is not None
    assert run_worker(root, owner, "reconcile-call", 0) == {
        "job_id": owner,
        "result": "attached-verified-completed-call",
    }
    attached = db.get_job(owner)
    assert attached is not None
    assert (attached.active_stage_key, attached.modal_call_id) == (key, CALL_ID)
    assert attached.status == original.status == "failed"
    assert attached.error_message == original.error_message
    assert attached.finished_at == original.finished_at
    # Reconciliation binds identity; normal processing validates and publishes
    # the bytes. It must not silently requeue the old failed job.
    assert not artifact_path(root, key).exists()
    result = run_worker(root, new_equivalent_job(), "resume", 0)
    assert result["result"]["sections"] == [
        {"start_s": 0, "end_s": 1.25, "label": "verse"}
    ]
    assert (
        artifact_path(root, key).read_bytes()
        == (root / "remote-result.bin").read_bytes()
    )
    assert_single_acceptance(root, request)
    assert run_worker(root, new_equivalent_job(), "cache-only", 0) == result


def test_operator_release_requires_drained_admission_and_verified_non_dispatch(
    durable_stage,
):
    root, owner, key, request = durable_stage
    # This process dies at entry to spawn, before even the finite CPU producer
    # executes. Unlike lost acknowledgement, non-acceptance is known here.
    run_worker(root, owner, "crash-not-dispatched", CRASH_BEFORE_DISPATCH)
    assert not (root / "accepted.log").exists()
    assert not (root / "remote-result.bin").exists()
    persisted = db.get_job(owner)
    assert persisted is not None
    assert persisted.active_stage_key == key and persisted.modal_call_id is None
    db.mark_failed(owner, "Process died before the producer accepted any work")
    original = db.get_job(owner)
    assert original is not None

    rejected = run_worker(root, owner, "reconcile-active-release", REJECTED)
    assert "Drain model admission" in rejected["error"]
    blocked = db.claim_inference_stage(new_equivalent_job(), key)
    assert not blocked.newly_claimed and blocked.owner.id == owner
    assert not (root / "accepted.log").exists()

    assert run_worker(root, owner, "reconcile-release", 0) == {
        "job_id": owner,
        "result": "released-verified-non-dispatch",
    }
    released = db.get_job(owner)
    assert released is not None
    assert released.active_stage_key is None and released.modal_call_id is None
    assert released.status == original.status == "failed"
    assert released.error_message == original.error_message
    assert released.finished_at == original.finished_at
    assert not (root / "accepted.log").exists()
    result = run_worker(root, new_equivalent_job(), "produce", 0)
    assert result["result"]["sections"] == [
        {"start_s": 0, "end_s": 1.25, "label": "verse"}
    ]
    assert_single_acceptance(root, request)
    assert run_worker(root, new_equivalent_job(), "cache-only", 0) == result


def test_operator_cannot_release_a_recorded_accepted_call(durable_stage):
    root, owner, key, request = durable_stage
    run_worker(root, owner, "crash-recorded", CRASH_AFTER_RECORD)
    rejected = run_worker(root, owner, "reconcile-release", REJECTED)
    assert "already has a recorded model call" in rejected["error"]
    persisted = db.get_job(owner)
    assert persisted is not None
    assert (persisted.active_stage_key, persisted.modal_call_id) == (key, CALL_ID)
    assert not artifact_path(root, key).exists()
    assert_single_acceptance(root, request)
