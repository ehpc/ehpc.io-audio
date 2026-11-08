"""One finite inference pool; DAGs, caches, network lookups and exports run on VPS."""

import json
import os
import subprocess
import sys
import tempfile
import traceback
from functools import cache
from pathlib import Path

import modal

from separator.inference import InferenceRequest
from separator.inference_transport import (
    TRANSFER_MOUNT,
    InferenceTransferError,
    load_request,
    publish_file,
    transport_volume_name,
    validate_output_id,
)
from separator.producer_manifest import load_manifest, verify_runtime


def _deployment_settings() -> tuple[str, str]:
    """Keep production resources fixed; cheaper hardware is an isolated opt-in."""
    test_gpu = os.environ.get("MODAL_TEST_GPU")
    if test_gpu is None:
        return "audio-inference-v3", "L40S"
    if test_gpu not in {"L4", "L40S"}:
        raise ValueError("MODAL_TEST_GPU must be L4 or L40S when set")
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
_environment = os.environ.get("MODAL_ENVIRONMENT", "").strip() or "ehpc-audio"
transport_volume = modal.Volume.from_name(
    transport_volume_name(_app_name, _environment),
    environment_name=_environment,
    create_if_missing=True,
    version=2,
)
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


def _run_model(request: InferenceRequest, source: Path, temporary: Path) -> Path:
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
    with (temporary / "diagnostics.log").open("a") as diagnostics:
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
            stdout=diagnostics,
            stderr=subprocess.STDOUT,
        )
    return output


@app.function(
    image=image,
    gpu=GPU,
    volumes={
        MODEL_CACHE: model_volume.with_mount_options(read_only=True),
        TRANSFER_MOUNT: transport_volume,
    },
    timeout=TIMEOUT,
    min_containers=0,
    buffer_containers=0,
    max_containers=1,
    scaledown_window=IDLE_SECONDS,
    block_network=True,
)
def infer(output_id: str) -> str:
    """Only a bounded token uses RPC; bulk I/O uses the private mounted Volume."""
    validate_output_id(output_id)
    root = Path(TRANSFER_MOUNT)
    try:
        transport_volume.reload()
        request = load_request(root, output_id)
    except Exception:
        # Do not serialize arbitrary SDK/native exception payloads through RPC.
        raise InferenceTransferError(output_id, "load") from None
    with tempfile.TemporaryDirectory(prefix="model-stage-") as directory:
        temporary = Path(directory)
        try:
            output = _run_model(request, root / output_id / "input.bin", temporary)
            publish_file(root, output_id, request, output)
        except Exception:
            diagnostics = temporary / "diagnostics.log"
            with diagnostics.open("a") as output_log:
                traceback.print_exc(file=output_log)
            try:
                publish_file(root, output_id, request, diagnostics, failed=True)
                transport_volume.commit()
            except Exception:
                raise InferenceTransferError(output_id, "diagnostic-commit") from None
            raise InferenceTransferError(output_id, "execution") from None
    try:
        transport_volume.commit()
    except Exception:
        # Retain the completed files: a lost commit response is not permission
        # to run this model again. The VPS keeps the recorded call and intent.
        raise InferenceTransferError(output_id, "result-commit") from None
    return output_id
