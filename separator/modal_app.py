"""One finite inference pool; DAGs, caches, network lookups and exports run on VPS."""

import json
import os
import subprocess
import sys
import tempfile
from functools import cache
from pathlib import Path

import modal

from separator.inference import InferenceRequest, InferenceResult
from separator.producer_manifest import load_manifest, verify_runtime


def _deployment_settings() -> tuple[str, str]:
    """Keep production resources fixed; cheaper hardware is an isolated opt-in."""
    test_gpu = os.environ.get("MODAL_TEST_GPU")
    if test_gpu is None:
        return "audio-inference-v3", "L40S"
    if test_gpu != "L4":
        raise ValueError("MODAL_TEST_GPU must be L4 when set")
    target = os.environ.get("MODAL_APP_NAME", "")
    if (
        not target
        or target != target.strip()
        or target in {"audio-separator", "audio-separator-v2", "audio-inference-v3"}
    ):
        raise ValueError(
            "MODAL_TEST_GPU requires an explicit non-production MODAL_APP_NAME "
            "without surrounding whitespace"
        )
    browser_target = os.environ.get("E2E_MODAL_APP_NAME")
    if browser_target is not None and browser_target != target:
        raise ValueError(
            "E2E_MODAL_APP_NAME must match MODAL_APP_NAME for MODAL_TEST_GPU"
        )
    return target, test_gpu


def _idle_window() -> int:
    """Deployment-only positive seconds, matching the SDK's scaledown constraint."""
    value = os.environ.get("MODAL_GPU_IDLE_SECONDS", "60")
    if not value.isascii() or not value.isdecimal() or int(value) <= 0:
        raise ValueError("MODAL_GPU_IDLE_SECONDS must be a positive integer")
    return int(value)


_app_name, GPU = _deployment_settings()
IDLE_SECONDS = _idle_window()
# Sixty seconds is an explicit unoptimized starting point, not a savings claim.
# Infrastructure-only tuning never changes a producer/artifact identity.
MODEL_VOLUME_NAME = os.environ.get("MODEL_VOLUME_NAME", "audio-separator-models")
MODEL_CACHE = "/model-cache"
TIMEOUT = 1200  # Preserve the existing ceiling until unchanged-model timings exist.
ASR_PYTHON = "/opt/lyrics-reference/bin/python"
STRUCTURE_PYTHON = "/opt/lyrics-structure/bin/python"
_manifest_path = Path(
    os.environ.get(
        "PRODUCER_MANIFEST",
        str(Path(__file__).with_name("model_manifest.json"))
        if modal.is_local()
        else "/producer-manifest.json",
    )
)
_manifest = load_manifest(_manifest_path)
app = modal.App(_app_name)
model_volume = modal.Volume.from_name(MODEL_VOLUME_NAME)
# Source deployments never re-resolve native dependencies or rebuild model images.
# Intentional producer builds live in separator.build_image and require new capture.
image = (
    modal.Image.from_id(_manifest.image_id)
    .add_local_python_source("separator")
    .add_local_file(_manifest_path, "/producer-manifest.json")
)


@cache
def _verify_producer(operation: str, model: str | None) -> None:
    # Check actual GPU-host native libraries once per selected cold producer.
    # Weight SHA verification is preprovisioning work, never GPU hashing work.
    verify_runtime(
        _manifest,
        operation,
        model,
        asr_python=ASR_PYTHON,
        structure_python=STRUCTURE_PYTHON,
    )


@app.function(
    image=image,
    gpu=GPU,
    volumes={MODEL_CACHE: model_volume.with_mount_options(read_only=True)},
    timeout=TIMEOUT,
    min_containers=0,
    buffer_containers=0,
    max_containers=1,
    scaledown_window=IDLE_SECONDS,
    block_network=True,
)
def infer(request: InferenceRequest) -> InferenceResult:
    """Execute one prepared native model operation, without graph/cache/network work."""
    # Pickle does not call dataclass validation. Reject malformed inputs before I/O.
    request = InferenceRequest(
        operation=request.operation,
        audio_bytes=request.audio_bytes,
        filename=request.filename,
        producer_digest=request.producer_digest,
        parameters=request.parameters,
    )
    fingerprint = request.fingerprint()
    model = (
        request.parameters.get("model") if request.operation == "separation" else None
    )
    if model is not None and not isinstance(model, str):
        raise ValueError("Separation model must be a configured filename")
    if request.producer_digest != _manifest.digest_for(request.operation, model):
        raise ValueError("Inference producer does not match the deployed manifest")
    _verify_producer(request.operation, model)
    python = (
        ASR_PYTHON
        if request.operation in {"recognition", "alignment"}
        else STRUCTURE_PYTHON
        if request.operation in {"pitch", "structure"}
        else sys.executable
    )
    model_cache = Path(MODEL_CACHE)
    if request.operation in {"recognition", "alignment"}:
        model_cache /= "qwen-asr"
    elif request.operation == "structure":
        model_cache /= "songformer"
    with tempfile.TemporaryDirectory(prefix="model-stage-") as directory:
        temporary = Path(directory)
        source = temporary / "input"
        source.write_bytes(request.audio_bytes)
        metadata = temporary / "request.json"
        metadata.write_text(
            json.dumps(
                {
                    "operation": request.operation,
                    "filename": request.filename,
                    "producer_digest": request.producer_digest,
                    "parameters": request.parameters,
                },
                allow_nan=False,
            )
        )
        output = temporary / "result"
        subprocess.run(
            [
                python,
                "-m",
                "separator.inference_runtime",
                str(metadata),
                str(source),
                str(output),
                str(model_cache),
            ],
            check=True,
            timeout=TIMEOUT,
        )
        result = InferenceResult(fingerprint, output.read_bytes())
        result.for_request(request)
        return result
