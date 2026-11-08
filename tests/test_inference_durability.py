"""Actual interpreter crashes must not turn accepted CPU stages into redispatches."""

import json
import os
import subprocess
import sys
from dataclasses import replace
from pathlib import Path

import pytest
from audio_samples import tone_wav
from inference_crash_worker import (
    CALL_ID,
    CRASH_AFTER_FAILURE_LOG,
    CRASH_AFTER_FAILURE_RECEIPT,
    CRASH_AFTER_FAILURE_TERMINAL,
    CRASH_AFTER_RECORD,
    CRASH_BEFORE_CACHE,
    CRASH_BEFORE_DISPATCH,
    CRASH_BEFORE_RECORD,
    LOCAL_WRITE_FAILED,
    NATIVE_FAILED,
    REJECTED,
    UNCERTAIN,
)
from inference_fixture import fixture_manifest

from backend import config, db
from separator.artifact_cache import digest
from separator.inference import InferenceRequest
from separator.inference_transport import load_request, validate_output_id
from separator.options import SeparationOptions
from separator.processing import ProcessingContext
from separator.producer_manifest import load_manifest
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


@pytest.fixture
def native_failure_stage(durable_stage):
    root, owner, _, request = durable_stage
    # The finite producer really executes FFmpeg against invalid staged audio.
    # Its native decoder failure becomes the private diagnostics artifact.
    source = b"owned input that is not a decodable audio container\n"
    (root / "source.wav").write_bytes(source)
    request = replace(request, audio_bytes=source)
    manifest = load_manifest(root / "producer" / "fixture-manifest.json")
    context = ProcessingContext(
        config.DATA_DIR / "artifacts",
        manifest,
        lambda *args: pytest.fail("fixture setup cannot invoke inference"),
    )
    key = context.key("structure", digest(source))
    unrelated = root / "private-transport" / ("f" * 32) / "input.bin"
    unrelated.parent.mkdir(parents=True)
    unrelated.write_bytes(b"another private request must survive cleanup")
    return root, owner, key, request


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


def request_receipt(root, key):
    path = root / "data" / "artifacts" / "inference-requests" / f"{key}.json"
    return json.loads(path.read_text())


def assert_private_binding(root, key, request):
    receipt = request_receipt(root, key)
    output_id = validate_output_id(receipt["output_id"])
    assert output_id != key and output_id != request.fingerprint()
    assert receipt["request_fingerprint"] == request.fingerprint()
    assert receipt["operation"] == request.operation
    assert receipt["producer_digest"] == request.producer_digest
    staged = load_request(root / "private-transport", output_id)
    assert staged.audio_bytes == request.audio_bytes
    assert staged.fingerprint() == request.fingerprint()
    remote = json.loads((root / "remote-call.json").read_text())
    assert remote["output_id"] == output_id
    assert remote["call_id"] == CALL_ID
    return receipt


def assert_result_receipt(root, key, output_id, *, cleanup_pending, cleaned):
    receipt = request_receipt(root, key)
    result = (root / "remote-result.bin").read_bytes()
    assert receipt["output_id"] == output_id
    assert receipt["result_sha256"] == digest(result)
    assert receipt["result_size"] == len(result)
    assert receipt["cleanup_pending"] is cleanup_pending
    assert receipt.get("cleaned", False) is cleaned


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
    receipt = assert_private_binding(root, key, request)

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
    assert request_receipt(root, key) == receipt
    assert not (root / "cleanup-attempts.log").exists()


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
    receipt = assert_private_binding(root, key, request)
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
    assert not (root / "private-transport" / receipt["output_id"]).exists()
    assert (root / "cleanup-attempts.log").read_text().splitlines() == [
        receipt["output_id"]
    ]
    assert_result_receipt(
        root, key, receipt["output_id"], cleanup_pending=False, cleaned=True
    )

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
        assert "does not match" in result["error"]
        assert not artifact_path(root, key).exists()
    assert (root / "accepted.log").read_text().splitlines() == [
        remote["request_fingerprint"]
    ]
    assert not list(artifact_path(root, key).parent.glob(".pending-*"))
    persisted = db.get_job(owner)
    assert persisted is not None and persisted.modal_call_id == CALL_ID
    assert_private_binding(root, key, request)
    assert not (root / "cleanup-attempts.log").exists()
    assert (
        root / "private-transport" / remote["output_id"] / "completion.json"
    ).is_file()


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
    assert "does not match" in result["error"]
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
    assert_private_binding(root, key, request)
    assert not (root / "cleanup-attempts.log").exists()


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


@pytest.mark.parametrize(
    ("mode", "exit_code"),
    [
        ("crash-before-cache", CRASH_BEFORE_CACHE),
        ("local-write-fails", LOCAL_WRITE_FAILED),
    ],
)
def test_remote_completion_survives_failed_local_publication(
    durable_stage, mode, exit_code
):
    root, owner, key, request = durable_stage
    run_worker(root, owner, mode, exit_code)
    assert_single_acceptance(root, request)
    receipt = assert_private_binding(root, key, request)
    assert not artifact_path(root, key).exists()
    assert not (root / "cleanup-attempts.log").exists()
    persisted = db.get_job(owner)
    assert persisted is not None
    assert (persisted.active_stage_key, persisted.modal_call_id) == (key, CALL_ID)
    remote = root / "private-transport" / receipt["output_id"]
    assert (remote / "result.bin").read_bytes() == (
        root / "remote-result.bin"
    ).read_bytes()
    assert (remote / "completion.json").is_file()
    assert_result_receipt(
        root, key, receipt["output_id"], cleanup_pending=False, cleaned=False
    )

    db.mark_failed(owner, "Local artifact publication did not complete")
    result = run_worker(root, new_equivalent_job(), "resume", 0)
    assert result["result"]["sections"] == [
        {"start_s": 0, "end_s": 1.25, "label": "verse"}
    ]
    assert (
        artifact_path(root, key).read_bytes()
        == (root / "remote-result.bin").read_bytes()
    )
    assert (root / "resumed.log").read_text().splitlines() == [CALL_ID]
    assert (root / "cleanup-attempts.log").read_text().splitlines() == [
        receipt["output_id"]
    ]
    assert not remote.exists()
    assert_result_receipt(
        root, key, receipt["output_id"], cleanup_pending=False, cleaned=True
    )
    assert_single_acceptance(root, request)
    assert run_worker(root, new_equivalent_job(), "cache-only", 0) == result


def test_cleanup_failure_retries_after_restart_without_recomputing(durable_stage):
    root, owner, key, request = durable_stage
    result = run_worker(root, owner, "cleanup-fails", 0)
    assert result["result"]["sections"] == [
        {"start_s": 0, "end_s": 1.25, "label": "verse"}
    ]
    assert_single_acceptance(root, request)
    receipt = assert_private_binding(root, key, request)
    artifact = artifact_path(root, key)
    assert artifact.read_bytes() == (root / "remote-result.bin").read_bytes()
    original_stat = artifact.stat()
    remote = root / "private-transport" / receipt["output_id"]
    assert (remote / "result.bin").read_bytes() == artifact.read_bytes()
    assert (root / "cleanup-attempts.log").read_text().splitlines() == [
        receipt["output_id"]
    ]
    assert_result_receipt(
        root, key, receipt["output_id"], cleanup_pending=True, cleaned=False
    )

    # Admission, producer preparation, dispatch, resume and polling all raise
    # in this mode: only a validated durable cache hit may drive cleanup retry.
    assert run_worker(root, new_equivalent_job(), "cache-only", 0) == result
    assert not remote.exists()
    assert not (root / "resumed.log").exists()
    assert (root / "cleanup-attempts.log").read_text().splitlines() == [
        receipt["output_id"],
        receipt["output_id"],
    ]
    assert artifact.stat().st_ino == original_stat.st_ino
    assert artifact.stat().st_mtime_ns == original_stat.st_mtime_ns
    assert artifact.read_bytes() == (root / "remote-result.bin").read_bytes()
    assert_single_acceptance(root, request)
    assert_result_receipt(
        root, key, receipt["output_id"], cleanup_pending=False, cleaned=True
    )

    # The successful retry is durable too; further cache hits do not delete or
    # contact the producer again.
    assert run_worker(root, new_equivalent_job(), "cache-only", 0) == result
    assert len((root / "cleanup-attempts.log").read_text().splitlines()) == 2


def assert_native_failure_evidence(root, key, request):
    assert (root / "accepted.log").read_text().splitlines() == [request.fingerprint()]
    remote = json.loads((root / "remote-call.json").read_bytes())
    assert remote["failed"] is True
    assert remote["request_fingerprint"] == request.fingerprint()
    output_id = validate_output_id(remote["output_id"])
    diagnostics = (
        root / "data" / "artifacts" / "inference-diagnostics" / f"{output_id}.log"
    )
    evidence = diagnostics.read_bytes()
    assert evidence == (root / "remote-result.bin").read_bytes()
    assert b"CalledProcessError" in evidence
    assert b"ffmpeg" in evidence
    assert b"returned non-zero exit status" in evidence
    assert not artifact_path(root, key).exists()
    unrelated = root / "private-transport" / ("f" * 32) / "input.bin"
    assert unrelated.read_bytes() == b"another private request must survive cleanup"
    return output_id, diagnostics, evidence


@pytest.mark.parametrize(
    ("mode", "exit_code"),
    [
        ("failure-crash-after-log", CRASH_AFTER_FAILURE_LOG),
        ("failure-crash-after-receipt", CRASH_AFTER_FAILURE_RECEIPT),
        ("failure-crash-after-terminal", CRASH_AFTER_FAILURE_TERMINAL),
    ],
)
def test_native_failure_crashes_preserve_evidence_and_never_recompute(
    native_failure_stage, mode, exit_code
):
    root, owner, key, request = native_failure_stage
    run_worker(root, owner, mode, exit_code)
    output_id, diagnostics, evidence = assert_native_failure_evidence(
        root, key, request
    )
    remote = root / "private-transport" / output_id
    assert (remote / "diagnostics.log").read_bytes() == evidence
    assert not (root / "cleanup-attempts.log").exists()
    persisted = db.get_job(owner)
    assert persisted is not None and persisted.modal_call_id == CALL_ID
    receipt = request_receipt(root, key)
    if mode == "failure-crash-after-log":
        assert "failure_sha256" not in receipt
    else:
        assert receipt["failure_sha256"] == digest(evidence)
        assert receipt["failure_size"] == len(evidence)
        assert receipt["failure_operation"] == "structure"
        assert receipt["failure_job_id"] == owner
        assert receipt["cleanup_pending"] is True

    terminal = mode == "failure-crash-after-terminal"
    assert (persisted.status == "failed") is terminal
    sweep = run_worker(root, owner, "failure-sweep", 0)
    assert sweep == {"status": "swept", "cleaned": int(terminal)}
    assert remote.exists() is not terminal
    if not terminal:
        # A durable log/receipt is not sufficient authorization to delete while
        # the failed consumer still lacks its durable terminal job state.
        assert not (root / "cleanup-attempts.log").exists()
        retry_mode = (
            "failure-resume"
            if mode == "failure-crash-after-log"
            else "failure-local-only"
        )
        failed = run_worker(root, owner, retry_mode, NATIVE_FAILED)
        assert failed["status"] == "native-failed"
        assert not remote.exists()

    finalized = request_receipt(root, key)
    assert finalized["failure_sha256"] == digest(evidence)
    assert finalized["failure_size"] == len(evidence)
    assert finalized["cleaned"] is True
    assert finalized["cleanup_pending"] is False
    assert (root / "cleanup-attempts.log").read_text().splitlines() == [output_id]
    original_stat = diagnostics.stat()
    for consumer in (owner, new_equivalent_job()):
        failed = run_worker(root, consumer, "failure-local-only", NATIVE_FAILED)
        assert failed["status"] == "native-failed"
        assert len(failed["error"]) < 2048
        assert "CalledProcessError" not in failed["error"]
        job = db.get_job(consumer)
        assert job is not None and job.status == "failed"
        assert_native_failure_evidence(root, key, request)
    assert diagnostics.stat().st_ino == original_stat.st_ino
    assert diagnostics.stat().st_mtime_ns == original_stat.st_mtime_ns
    assert (root / "cleanup-attempts.log").read_text().splitlines() == [output_id]
    resumed = root / "resumed.log"
    if mode == "failure-crash-after-log":
        assert resumed.read_text().splitlines() == [CALL_ID]
    else:
        assert not resumed.exists()


@pytest.mark.parametrize("lost_evidence", ["missing", "corrupted"])
def test_failed_transfer_cleanup_retry_requires_intact_durable_diagnostics(
    native_failure_stage, lost_evidence
):
    root, owner, key, request = native_failure_stage
    failed = run_worker(root, owner, "failure-cleanup-fails", NATIVE_FAILED)
    assert failed["status"] == "native-failed"
    output_id, diagnostics, evidence = assert_native_failure_evidence(
        root, key, request
    )
    remote = root / "private-transport" / output_id
    assert (remote / "diagnostics.log").read_bytes() == evidence
    receipt = request_receipt(root, key)
    assert receipt["failure_job_id"] == owner
    assert receipt["failure_sha256"] == digest(evidence)
    assert receipt["failure_size"] == len(evidence)
    assert receipt["cleanup_pending"] is True
    assert not receipt.get("cleaned", False)
    persisted = db.get_job(owner)
    assert persisted is not None and persisted.status == "failed"
    assert (root / "cleanup-attempts.log").read_text().splitlines() == [output_id]

    if lost_evidence == "missing":
        diagnostics.unlink()
    else:
        diagnostics.write_bytes(bytes([evidence[0] ^ 1]) + evidence[1:])
    assert run_worker(root, owner, "failure-sweep", 0) == {
        "status": "swept",
        "cleaned": 0,
    }
    assert remote.exists()
    assert (root / "cleanup-attempts.log").read_text().splitlines() == [output_id]
    diagnostics.write_bytes(evidence)

    assert run_worker(root, owner, "failure-sweep", 0) == {
        "status": "swept",
        "cleaned": 1,
    }
    assert not remote.exists()
    finalized = request_receipt(root, key)
    assert finalized["cleaned"] is True
    assert finalized["cleanup_pending"] is False
    assert (root / "cleanup-attempts.log").read_text().splitlines() == [
        output_id,
        output_id,
    ]
    for consumer in (owner, new_equivalent_job()):
        repeated = run_worker(root, consumer, "failure-local-only", NATIVE_FAILED)
        assert repeated == failed
        assert_native_failure_evidence(root, key, request)
    assert not (root / "resumed.log").exists()
    assert len((root / "cleanup-attempts.log").read_text().splitlines()) == 2
