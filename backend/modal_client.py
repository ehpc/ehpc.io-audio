import hashlib
import logging
import math
import os
import subprocess
import sys
import tempfile
from contextlib import suppress
from functools import cache
from pathlib import Path
from time import monotonic

import modal
from modal.exception import TimeoutError as ModalTimeoutError

from backend import config
from separator.inference import InferenceRequest
from separator.inference_transport import (
    COMPLETION_LIMIT,
    decode_completion,
    transport_volume_name,
    validate_output_id,
    write_request,
)

log = logging.getLogger(__name__)


class InferenceStageFailure(RuntimeError):
    """A verified terminal model failure whose complete diagnostics are durable."""

    def __init__(self, operation: str, output_id: str, sha256: str, size: int) -> None:
        self.operation = operation
        self.output_id = output_id
        self.sha256 = sha256
        self.size = size
        super().__init__(
            f"{operation} inference failed; private diagnostic {output_id}"
        )


@cache
def _get_function() -> modal.Function:
    return modal.Function.from_name(
        config.MODAL_APP_NAME, "infer", environment_name=config.MODAL_ENVIRONMENT
    )


@cache
def _get_transport_volume() -> modal.Volume:
    return modal.Volume.from_name(
        transport_volume_name(config.MODAL_APP_NAME, config.MODAL_ENVIRONMENT),
        environment_name=config.MODAL_ENVIRONMENT,
    )


def stage_input(
    request: InferenceRequest, output_id: str, *, timeout: float | None = None
) -> None:
    """Stage input before dispatch; kill and reap a stalled upload process."""
    validate_output_id(output_id)
    budget = config.MODAL_INPUT_UPLOAD_TIMEOUT_S if timeout is None else timeout
    if not math.isfinite(budget) or not (
        0 < budget <= config.MODAL_INPUT_UPLOAD_TIMEOUT_S
    ):
        raise ValueError("Invalid inference input upload deadline")
    deadline = monotonic() + budget
    with tempfile.TemporaryDirectory(prefix="inference-input-") as directory:
        root = Path(directory)
        write_request(root, output_id, request)
        remaining = deadline - monotonic()
        if remaining <= 0:
            raise TimeoutError("Inference input upload timed out before dispatch")
        _run_staging_upload(root, output_id, remaining)


def _run_staging_upload(root: Path, output_id: str, timeout: float) -> None:
    diagnostics = config.DATA_DIR / "artifacts" / "inference-diagnostics"
    diagnostics.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        prefix=f"upload-{output_id}-", suffix=".log", dir=diagnostics, delete=False
    ) as output:
        path = Path(output.name)
        try:
            subprocess.run(
                [sys.executable, "-m", "backend.stage_upload", str(root), output_id],
                stdout=output,
                stderr=subprocess.STDOUT,
                check=True,
                timeout=timeout,
            )
        except subprocess.TimeoutExpired as error:
            output.write(f"\n{type(error).__name__}: {error}\n".encode())
            log.warning("Input upload timed out; private diagnostics: %s", path)
            raise TimeoutError(
                "Inference input upload timed out before dispatch"
            ) from None
        except (subprocess.CalledProcessError, OSError) as error:
            output.write(f"\n{type(error).__name__}: {error}\n".encode())
            log.warning("Input upload failed; private diagnostics: %s", path)
            raise RuntimeError(
                "Inference input upload failed before dispatch"
            ) from None
        else:
            path.unlink()


def spawn(
    output_id: str,
    *,
    operation: str | None = None,
    producer_digest: str | None = None,
) -> modal.functions.FunctionCall[str]:
    validate_output_id(output_id)
    call = _get_function().spawn(output_id)
    log.info(
        "spawned %s inference (call_id=%s producer_digest=%s)",
        operation,
        call.object_id,
        producer_digest,
    )
    return call


def resume(call_id: str) -> modal.functions.FunctionCall[str]:
    return modal.FunctionCall.from_id(call_id)


def poll(call: modal.functions.FunctionCall[str], timeout: float) -> str | None:
    try:
        return call.get(timeout=timeout)
    except (TimeoutError, ModalTimeoutError):
        return None


def read_result(
    output_id: str,
    expected_fingerprint: str,
    *,
    diagnostics_root: Path | None = None,
) -> bytes:
    """Verify a committed result on CPU; NEVER acknowledge/delete it here."""
    validate_output_id(output_id)
    volume = _get_transport_volume()
    metadata = bytearray()
    for block in volume.read_file(f"/{output_id}/completion.json"):
        if len(metadata) + len(block) > COMPLETION_LIMIT:
            raise ValueError("Inference completion receipt is too large")
        metadata.extend(block)
    receipt = decode_completion(bytes(metadata), output_id, expected_fingerprint)
    failed = receipt["status"] == "failed"
    name = "diagnostics.log" if failed else "result.bin"
    diagnostic_directory = (
        diagnostics_root
        if diagnostics_root is not None
        else config.DATA_DIR / "artifacts" / "inference-diagnostics"
    )
    if failed:
        diagnostic_directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        diagnostic_directory.chmod(0o700)
    descriptor, temporary = tempfile.mkstemp(
        dir=diagnostic_directory if failed else None, prefix=".inference-result-"
    )
    try:
        hasher = hashlib.sha256()
        size = 0
        with os.fdopen(descriptor, "w+b") as output:
            for block in volume.read_file(f"/{output_id}/{name}"):
                size += len(block)
                if size > receipt["size"]:
                    raise ValueError("Inference transfer exceeds its committed size")
                hasher.update(block)
                output.write(block)
            if size != receipt["size"] or hasher.hexdigest() != receipt["sha256"]:
                raise ValueError("Inference transfer failed integrity verification")
            output.flush()
            os.fsync(output.fileno())
            if not failed:
                output.seek(0)
                return output.read()
        Path(temporary).replace(diagnostic_directory / f"{output_id}.log")
        directory_fd = os.open(diagnostic_directory, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
        raise InferenceStageFailure(
            receipt["operation"], output_id, receipt["sha256"], receipt["size"]
        )
    finally:
        Path(temporary).unlink(missing_ok=True)


def cleanup(output_id: str) -> None:
    """Caller must first validate and durably publish its local artifact."""
    validate_output_id(output_id)
    # A previous process may have deleted it before recording its acknowledgment.
    with suppress(FileNotFoundError):
        _get_transport_volume().remove_file(f"/{output_id}", recursive=True)
