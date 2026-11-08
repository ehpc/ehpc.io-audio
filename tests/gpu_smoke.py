"""Real isolated GPU calls with shared read-only weights and private CPU outputs."""

import os
from pathlib import Path

from backend import config, modal_client
from separator.inference import InferenceRequest
from separator.prepare_models import ensure_prepared
from separator.processing import ProcessingContext
from separator.producer_manifest import load_manifest


def gpu_context(root: Path) -> ProcessingContext:
    """Use the deployed test pool, never a second function or production app."""
    if (
        not os.environ.get("MODAL_APP_NAME")
        or config.MODAL_APP_NAME
        in {"audio-separator", "audio-separator-v2", "audio-inference-v3"}
        or os.environ.get("MODAL_APP_NAME") != config.MODAL_APP_NAME
        or os.environ.get("MODAL_TEST_GPU") != "L4"
    ):
        raise RuntimeError(
            "GPU smoke requires an explicit isolated app and MODAL_TEST_GPU=L4"
        )
    manifest = load_manifest(config.PRODUCER_MANIFEST)

    def infer(request: InferenceRequest, _key: str) -> bytes:
        ensure_prepared(
            manifest,
            request,
            config.prepared_models_root(),
            config.MODEL_VOLUME_NAME,
            config.MODAL_ENVIRONMENT,
        )
        return modal_client.spawn(request).get().for_request(request)

    root.mkdir(parents=True, exist_ok=True)
    return ProcessingContext(root, manifest, infer)
