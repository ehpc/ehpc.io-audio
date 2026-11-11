"""Durable inference calls; all cache lookup and preparation precede GPU spawn."""

import hashlib
import json
import logging
import tempfile
import threading
import uuid
from pathlib import Path

from backend import config, db, drain, modal_client
from backend.models import JobRecord, JobStatus
from separator.artifact_cache import atomic_write, digest, sync_file
from separator.inference import InferenceRequest
from separator.inference_transport import InferenceTransferError, validate_output_id
from separator.lyrics_reference import ReferenceMetadata
from separator.prepare_models import ensure_prepared
from separator.processing import (
    ProcessingContext,
    ProcessingResult,
    cached_pitch_vocals,
    run_processing,
)
from separator.producer_manifest import ProducerManifest, load_manifest

log = logging.getLogger(__name__)


class UncertainInferenceDispatch(RuntimeError):
    def __init__(self) -> None:
        super().__init__("Model dispatch uncertain; not automatically repeated")


def _receipt_path(key: str) -> Path:
    if len(key) != 64 or any(character not in "0123456789abcdef" for character in key):
        raise ValueError("Invalid semantic stage identity")
    return config.DATA_DIR / "artifacts" / "inference-requests" / f"{key}.json"


def _write_receipt(path: Path, receipt: dict) -> None:
    atomic_write(path, json.dumps(receipt, sort_keys=True).encode())
    sync_file(path)


def _matches_file(path: Path, sha256: str, size: int) -> bool:
    if not path.is_file() or path.stat().st_size != size:
        return False
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest() == sha256


def _diagnostic_path(receipt: dict) -> Path:
    output_id = validate_output_id(receipt["output_id"])
    return config.DATA_DIR / "artifacts" / "inference-diagnostics" / f"{output_id}.log"


def _recorded_failure(receipt: dict) -> modal_client.InferenceStageFailure:
    if not _matches_file(
        _diagnostic_path(receipt), receipt["failure_sha256"], receipt["failure_size"]
    ):
        raise ValueError("Recorded model failure diagnostics are missing or corrupt")
    return modal_client.InferenceStageFailure(
        receipt["failure_operation"],
        receipt["output_id"],
        receipt["failure_sha256"],
        receipt["failure_size"],
    )


def _acknowledge(path: Path, artifact: Path) -> bool:
    if not path.is_file():
        return False  # Legacy/local artifacts have no remote transfer to remove.
    receipt = json.loads(path.read_bytes())
    if receipt.get("cleaned"):
        return False
    if "failure_sha256" in receipt:
        job = db.get_job(receipt["failure_job_id"])
        if job is None or job.status != JobStatus.FAILED:
            return False
        artifact = _diagnostic_path(receipt)
        sha256, size = receipt["failure_sha256"], receipt["failure_size"]
    elif "result_sha256" in receipt:
        sha256, size = receipt["result_sha256"], receipt["result_size"]
    else:
        return False
    # A failure needs both terminal job state and complete durable diagnostics.
    if not _matches_file(artifact, sha256, size):
        return False
    sync_file(artifact)
    receipt["cleanup_pending"] = True
    _write_receipt(path, receipt)
    try:
        modal_client.cleanup(receipt["output_id"])
    except Exception as error:
        # Retain an explicit durable debt, not an inference retry. Do not expose
        # signed SDK URLs or private native diagnostics in the public job error.
        log.warning(
            "private transfer %s cleanup remains pending (%s)",
            receipt["output_id"],
            type(error).__name__,
        )
        return False
    receipt["cleanup_pending"] = False
    receipt["cleaned"] = True
    _write_receipt(path, receipt)
    return True


def cleanup_completed_transfers() -> int:
    """CPU-only restart/operator cleanup; unresolved accepted work is untouched."""
    root = config.DATA_DIR / "artifacts"
    cleaned = 0
    for path in (root / "inference-requests").glob("*.json"):
        key = path.stem
        if len(key) != 64 or any(
            character not in "0123456789abcdef" for character in key
        ):
            continue
        receipt = json.loads(path.read_bytes())
        if receipt.get("cleanup_pending"):
            cleaned += _acknowledge(path, root / "inference" / f"{key}.bin")
    return cleaned


def _completed_stage(key: str) -> bool:
    """Only a validated, durably committed artifact permits replacing ownership."""
    path = _receipt_path(key)
    if not path.is_file():
        return False
    receipt = json.loads(path.read_bytes())
    if "result_sha256" not in receipt or "result_size" not in receipt:
        return False
    artifact = config.DATA_DIR / "artifacts" / "inference" / f"{key}.bin"
    if not _matches_file(artifact, receipt["result_sha256"], receipt["result_size"]):
        return False
    sync_file(artifact)
    return True


class StageRunner:
    def __init__(self, job_id: int, manifest: ProducerManifest, stop: threading.Event):
        self.job_id = job_id
        self.manifest = manifest
        self.stop = stop

    def committed(self, key: str, artifact: Path) -> None:
        _acknowledge(_receipt_path(key), artifact)

    def _read_result(self, path: Path, receipt: dict) -> bytes:
        try:
            return modal_client.read_result(
                receipt["output_id"], receipt["request_fingerprint"]
            )
        except modal_client.InferenceStageFailure as failure:
            if (
                failure.output_id != receipt["output_id"]
                or failure.operation != receipt["operation"]
            ):
                raise ValueError(
                    "Model failure belongs to another request"
                ) from failure
            receipt.update(
                failure_operation=failure.operation,
                failure_sha256=failure.sha256,
                failure_size=failure.size,
                failure_job_id=self.job_id,
                cleanup_pending=True,
            )
            _write_receipt(path, receipt)
            raise

    def __call__(self, request: InferenceRequest, key: str) -> bytes:
        if self.stop.is_set():
            raise InterruptedError("Audio processing is shutting down")
        # Recorded accepted calls must remain resumable even during a drain.
        # Reject unserializable inputs before recording any dispatch intent.
        fingerprint = request.fingerprint()
        path = _receipt_path(key)
        identity = {
            "request_fingerprint": fingerprint,
            "operation": request.operation,
            "producer_digest": request.producer_digest,
        }
        receipt: dict
        if path.is_file():
            receipt = json.loads(path.read_bytes())
            if any(receipt.get(name) != value for name, value in identity.items()):
                raise ValueError("Semantic stage does not match its recorded request")
            output_id = validate_output_id(receipt.get("output_id"))
            if "failure_sha256" in receipt:
                failure = _recorded_failure(receipt)
                if not receipt.get("cleaned"):
                    receipt["failure_job_id"] = self.job_id
                    receipt["cleanup_pending"] = True
                    _write_receipt(path, receipt)
                raise failure
        else:
            output_id = uuid.uuid4().hex
            receipt = {**identity, "output_id": output_id}
            _write_receipt(path, receipt)
        job = db.get_job(self.job_id)
        previous = job.active_stage_key if job is not None else None
        completed = (
            (previous, job.modal_call_id)
            if job is not None and previous and _completed_stage(previous)
            else None
        )
        claim = db.claim_inference_stage(self.job_id, key, completed)
        owner = claim.owner
        if not claim.newly_claimed:
            if owner.modal_call_id is None:
                log.error(
                    "job %s is blocked by uncertain %s dispatch owned by job %s",
                    self.job_id,
                    request.operation,
                    owner.id,
                )
                raise UncertainInferenceDispatch
            call = modal_client.resume(owner.modal_call_id)
        else:
            try:
                with drain.state.dispatch():
                    pass
                ensure_prepared(
                    self.manifest,
                    request,
                    config.prepared_models_root(),
                    config.MODEL_VOLUME_NAME,
                    config.MODAL_ENVIRONMENT,
                )
                if self.stop.is_set():
                    raise InterruptedError("Audio processing is shutting down")
                modal_client.stage_input(request, output_id)
                if self.stop.is_set():
                    raise InterruptedError("Audio processing is shutting down")
            except Exception:
                # Upload/preparation cannot accept a GPU call. This is the only
                # automatic release; once spawn begins, acceptance is uncertain.
                db.release_inference_stage(owner.id, key)
                raise
            try:
                with drain.state.dispatch():
                    try:
                        call = modal_client.spawn(
                            output_id,
                            operation=request.operation,
                            producer_digest=request.producer_digest,
                        )
                    except Exception as error:
                        raise UncertainInferenceDispatch from error
                    db.set_active_stage(owner.id, key, call.object_id)
            except drain.DrainDeferred:
                db.release_inference_stage(owner.id, key)
                raise
        while not self.stop.is_set():
            try:
                result = modal_client.poll(call, config.MODAL_CALL_POLL_TIMEOUT_S)
            except InferenceTransferError as error:
                if error.output_id != output_id:
                    raise ValueError(
                        "Inference failure belongs to another transfer"
                    ) from error
                # A typed remote exception proves the call ended. Preserve full
                # model diagnostics, or recover a valid result after lost commit
                # acknowledgment; untyped transport failures remain resumable.
                try:
                    data = self._read_result(path, receipt)
                except FileNotFoundError:
                    raise error from None
            else:
                if result is None:
                    continue
                if result != output_id:
                    raise ValueError("Inference returned another private transfer")
                data = self._read_result(path, receipt)
            receipt["result_sha256"] = digest(data)
            receipt["result_size"] = len(data)
            receipt["cleanup_pending"] = False
            _write_receipt(path, receipt)
            return data
        # Leave the recorded call and all staged files intact for restart.
        raise InterruptedError("Audio processing is shutting down")


def process_source(
    job: JobRecord,
    audio: bytes,
    filename: str,
    metadata: ReferenceMetadata | None,
    stop: threading.Event,
) -> ProcessingResult:
    cleanup_completed_transfers()
    manifest = load_manifest(config.PRODUCER_MANIFEST)
    runner = StageRunner(job.id, manifest, stop)
    context = ProcessingContext(
        config.DATA_DIR / "artifacts", manifest, runner, on_committed=runner.committed
    )
    with tempfile.TemporaryDirectory(prefix="audio-stages-") as directory:
        root = Path(directory)
        source = root / Path(filename).name
        source.write_bytes(audio)
        return run_processing(source, job.options, root, context, metadata)


def recover_vocals(audio: bytes) -> bytes | None:
    return cached_pitch_vocals(
        audio, config.DATA_DIR / "artifacts", load_manifest(config.PRODUCER_MANIFEST)
    )
