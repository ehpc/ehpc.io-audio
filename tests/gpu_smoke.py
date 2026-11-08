"""Real isolated GPU calls with shared read-only weights and private CPU outputs."""

import logging
import os
from pathlib import Path
from uuid import uuid4

from backend import config, modal_client
from separator.inference import InferenceRequest
from separator.inference_transport import InferenceTransferError
from separator.prepare_models import ensure_prepared
from separator.processing import ProcessingContext
from separator.producer_manifest import load_manifest

logger = logging.getLogger(__name__)


def gpu_context(root: Path) -> ProcessingContext:
    """Use the deployed test pool, never a second function or production app."""
    if (
        not os.environ.get("MODAL_APP_NAME")
        or config.MODAL_APP_NAME
        in {"audio-separator", "audio-separator-v2", "audio-inference-v3"}
        or os.environ.get("MODAL_APP_NAME") != config.MODAL_APP_NAME
        or os.environ.get("MODAL_TEST_GPU") not in {"L4", "L40S"}
    ):
        raise RuntimeError(
            "GPU smoke requires an explicit isolated app and MODAL_TEST_GPU=L4 or L40S"
        )
    manifest = load_manifest(config.PRODUCER_MANIFEST)
    pending: dict[str, str] = {}

    def infer(request: InferenceRequest, key: str) -> bytes:
        ensure_prepared(
            manifest,
            request,
            config.prepared_models_root(),
            config.MODEL_VOLUME_NAME,
            config.MODAL_ENVIRONMENT,
        )
        output_id = uuid4().hex
        pending[key] = output_id
        modal_client.stage_input(request, output_id)
        failure: InferenceTransferError | None = None
        try:
            returned_id = modal_client.spawn(
                output_id,
                operation=request.operation,
                producer_digest=request.producer_digest,
            ).get()
        except InferenceTransferError as error:
            if error.output_id != output_id:
                raise ValueError(
                    "Inference failure belongs to another transfer"
                ) from error
            failure = error
        else:
            if returned_id != output_id:
                raise ValueError("Inference returned another transport identity")
        try:
            return modal_client.read_result(
                output_id,
                request.fingerprint(),
                diagnostics_root=root / "diagnostics",
            )
        except FileNotFoundError:
            if failure is not None:
                raise failure from None
            raise

    def on_committed(key: str, _artifact_path: Path) -> None:
        output_id = pending.get(key)
        if output_id is not None:
            try:
                modal_client.cleanup(output_id)
            except Exception as error:
                logger.warning(
                    "Deferred cleanup of test transfer %s (%s)",
                    output_id,
                    type(error).__name__,
                )
            else:
                del pending[key]

    root.mkdir(parents=True, exist_ok=True)
    return ProcessingContext(root, manifest, infer, on_committed=on_committed)
