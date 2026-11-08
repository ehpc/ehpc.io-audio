"""Private staged files, with only an opaque token crossing the Function RPC."""

import hashlib
import json
import os
import tempfile
from pathlib import Path

from separator.artifact_cache import atomic_write
from separator.inference import OPERATIONS, InferenceRequest

TRANSFER_MOUNT = "/inference-transport"
COMPLETION_LIMIT = 4096


class InferenceTransferError(RuntimeError):
    """Bounded, pickle-safe terminal failure; full diagnostics stay private."""

    def __init__(self, output_id: str, phase: str) -> None:
        super().__init__(output_id, phase)
        self.output_id = output_id
        self.phase = phase

    def __str__(self) -> str:
        return f"Inference {self.phase} failed; private transfer {self.output_id}"


def transport_volume_name(app_name: str, environment_name: str) -> str:
    if not app_name.strip() or not environment_name.strip():
        raise ValueError("Transport requires an explicit app and environment")
    identity = json.dumps([app_name, environment_name], separators=(",", ":"))
    return "audio-transport-" + hashlib.sha256(identity.encode()).hexdigest()[:32]


def validate_output_id(output_id: str) -> str:
    if (
        not isinstance(output_id, str)
        or len(output_id) != 32
        or any(character not in "0123456789abcdef" for character in output_id)
    ):
        raise ValueError("Invalid private inference transfer identity")
    return output_id


def transfer_directory(root: Path, output_id: str) -> Path:
    directory = root / validate_output_id(output_id)
    if directory.is_symlink():
        raise ValueError("Inference transfer directory cannot be a symlink")
    return directory


def _file(directory: Path, name: str) -> Path:
    path = directory / name
    if path.is_symlink():
        raise ValueError("Inference transfer file cannot be a symlink")
    return path


def write_request(root: Path, output_id: str, request: InferenceRequest) -> None:
    directory = transfer_directory(root, output_id)
    atomic_write(_file(directory, "input.bin"), request.audio_bytes)
    atomic_write(
        _file(directory, "request.json"),
        json.dumps(
            {
                "request_fingerprint": request.fingerprint(),
                "audio_size": len(request.audio_bytes),
                "request": {
                    "operation": request.operation,
                    "filename": request.filename,
                    "producer_digest": request.producer_digest,
                    "parameters": request.parameters,
                },
            },
            allow_nan=False,
            sort_keys=True,
        ).encode(),
    )


def load_request(root: Path, output_id: str) -> InferenceRequest:
    directory = transfer_directory(root, output_id)
    metadata = json.loads(_file(directory, "request.json").read_bytes())
    audio = _file(directory, "input.bin").read_bytes()
    request = InferenceRequest(audio_bytes=audio, **metadata["request"])
    if (
        type(metadata["audio_size"]) is not int
        or len(audio) != metadata["audio_size"]
        or request.fingerprint() != metadata["request_fingerprint"]
    ):
        raise ValueError("Staged inference request failed integrity verification")
    return request


def publish_file(
    root: Path,
    output_id: str,
    request: InferenceRequest,
    source: Path,
    *,
    failed: bool = False,
) -> None:
    """Publish a complete file/receipt; the caller must then commit its Volume."""
    directory = transfer_directory(root, output_id)
    directory.mkdir(parents=True, exist_ok=True)
    target = _file(directory, "diagnostics.log" if failed else "result.bin")
    hasher = hashlib.sha256()
    size = 0
    descriptor, temporary = tempfile.mkstemp(dir=directory, prefix=".pending-")
    try:
        with os.fdopen(descriptor, "wb") as output, source.open("rb") as input_file:
            while block := input_file.read(1024 * 1024):
                hasher.update(block)
                size += len(block)
                output.write(block)
            output.flush()
            os.fsync(output.fileno())
        if not size:
            raise ValueError("Inference produced an empty transfer")
        Path(temporary).replace(target)
        atomic_write(
            _file(directory, "completion.json"),
            json.dumps(
                {
                    "output_id": output_id,
                    "request_fingerprint": request.fingerprint(),
                    "operation": request.operation,
                    "status": "failed" if failed else "complete",
                    "size": size,
                    "sha256": hasher.hexdigest(),
                },
                sort_keys=True,
            ).encode(),
        )
    finally:
        Path(temporary).unlink(missing_ok=True)


def decode_completion(data: bytes, output_id: str, fingerprint: str) -> dict:
    validate_output_id(output_id)
    if len(data) > COMPLETION_LIMIT:
        raise ValueError("Inference completion receipt is too large")
    receipt = json.loads(data)
    if (
        not isinstance(receipt, dict)
        or receipt.get("output_id") != output_id
        or receipt.get("request_fingerprint") != fingerprint
        or not isinstance(receipt.get("operation"), str)
        or receipt["operation"] not in OPERATIONS
        or not isinstance(receipt.get("status"), str)
        or receipt["status"] not in {"complete", "failed"}
        or type(receipt.get("size")) is not int
        or receipt["size"] <= 0
        or not isinstance(receipt.get("sha256"), str)
        or len(receipt["sha256"]) != 64
        or any(character not in "0123456789abcdef" for character in receipt["sha256"])
    ):
        raise ValueError("Inference completion does not match its private request")
    return receipt
