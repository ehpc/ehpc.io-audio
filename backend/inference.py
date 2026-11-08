"""Durable inference calls; all cache lookup and preparation precede GPU spawn."""

import json
import logging
import tempfile
import threading
from pathlib import Path

from backend import config, db, modal_client
from backend.models import JobRecord
from separator.artifact_cache import atomic_write
from separator.inference import InferenceRequest, InferenceResult
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


class StageRunner:
    def __init__(self, job_id: int, manifest: ProducerManifest, stop: threading.Event):
        self.job_id = job_id
        self.manifest = manifest
        self.stop = stop

    def __call__(self, request: InferenceRequest, key: str) -> bytes:
        if self.stop.is_set():
            raise InterruptedError("Audio processing is shutting down")
        # Reject unserializable inputs before recording any dispatch intent.
        fingerprint = request.fingerprint()
        if len(key) != 64 or any(
            character not in "0123456789abcdef" for character in key
        ):
            raise ValueError("Invalid semantic stage identity")
        ensure_prepared(
            self.manifest,
            request,
            config.prepared_models_root(),
            config.MODEL_VOLUME_NAME,
            config.MODAL_ENVIRONMENT,
        )
        if self.stop.is_set():
            raise InterruptedError("Audio processing is shutting down")
        receipt = config.DATA_DIR / "artifacts" / "inference-requests" / f"{key}.json"
        identity = {
            "request_fingerprint": fingerprint,
            "operation": request.operation,
            "producer_digest": request.producer_digest,
        }
        if receipt.is_file():
            if json.loads(receipt.read_bytes()) != identity:
                raise ValueError("Semantic stage does not match its recorded request")
        else:
            atomic_write(receipt, json.dumps(identity, sort_keys=True).encode())
        claim = db.claim_inference_stage(self.job_id, key)
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
                call = modal_client.spawn(request)
            except Exception as error:
                # Acceptance can precede a lost response. Preserve the global
                # intent, including for a new equivalent job, rather than repay.
                raise UncertainInferenceDispatch from error
            db.set_active_stage(owner.id, key, call.object_id)
        while not self.stop.is_set():
            result = modal_client.poll(call, config.MODAL_CALL_POLL_TIMEOUT_S)
            if result is not None:
                if not isinstance(result, InferenceResult):
                    raise ValueError("Inference returned an invalid transport payload")
                return result.for_request(request)
        # Leave the recorded call running. Startup requeues the job and resumes
        # this exact call, while earlier atomic artifacts avoid repeated stages.
        raise InterruptedError("Audio processing is shutting down")


def process_source(
    job: JobRecord,
    audio: bytes,
    filename: str,
    metadata: ReferenceMetadata | None,
    stop: threading.Event,
) -> ProcessingResult:
    manifest = load_manifest(config.PRODUCER_MANIFEST)
    context = ProcessingContext(
        config.DATA_DIR / "artifacts", manifest, StageRunner(job.id, manifest, stop)
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
