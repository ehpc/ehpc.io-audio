"""Explicit CPU-only import of completed legacy cache bytes, never GPU inference.

CLI requires --volume, --environment, --destination-root, --source-inventory and
one or more --path selections. The trusted inventory is an object mapping relative
paths to {"type": "file", "size": <integer>, "sha256": <actual digest>}. Only
selected completed artifact paths are copied; weights and arbitrary files are
never imported. Bytes remain opaque until their producer provenance is proven.

An OPTIONAL --verified-gpu-receipt / --producer-manifest pair authorizes publishing
legacy-producer-manifest.json only after successful imports. The trusted operator
receipt must contain producer_manifest_sha256 (SHA-256 of the exact manifest file)
and operations: [{operation, producer_digest, call_id, status: "succeeded", model?}].
All five operation families must be represented; separation specifies its model.
This tool validates supplied evidence, not its external authenticity. It never
creates a GPU receipt, infers old provenance from CPU checks, invents decoded PCM
metadata, downloads models, invokes inference, or deploys Modal functions.
"""

import argparse
import hashlib
import json
import os
import re
import stat
import tempfile
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

import modal

from separator.artifact_cache import locked
from separator.inference import OPERATIONS
from separator.producer_manifest import ProducerManifest

_BIN_DIRECTORIES = frozenset(
    {
        "stems/versioned/outputs",
        "analysis-results/lyrics",
        "analysis-results/pitch",
        "analysis-results/structure",
        "qwen-asr/results/recognition",
        "qwen-asr/results/recognition-alignment",
    }
)


def _digest(value: object) -> bool:
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value) is not None


def _selected_path(value: object) -> str:
    if not isinstance(value, str) or not value or "\\" in value or "\x00" in value:
        raise ValueError("Invalid artifact path")
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in value.split("/")):
        raise ValueError(f"Unsafe artifact path: {value}")
    directory = str(path.parent)
    extension = ".json" if directory == "lyrics-references" else ".bin"
    if (
        (directory not in _BIN_DIRECTORIES and directory != "lyrics-references")
        or path.suffix != extension
        or not _digest(path.stem)
    ):
        raise ValueError(f"Path is not a completed cache artifact: {value}")
    return value


@dataclass(frozen=True)
class Artifact:
    path: str
    size: int
    sha256: str


def _selection(inventory: object, paths: Sequence[str]) -> list[Artifact]:
    if not isinstance(inventory, Mapping):
        raise ValueError("Source inventory must map paths to file records")
    if isinstance(paths, (str, bytes)) or not paths:
        raise ValueError("Select one or more explicit artifact paths")
    selected = []
    seen = set()
    for path in paths:
        path = _selected_path(path)
        if path in seen:
            raise ValueError(f"Duplicate selected artifact: {path}")
        seen.add(path)
        record = inventory.get(path)
        if (
            not isinstance(record, Mapping)
            or record.get("type") != "file"
            or type(record.get("size")) is not int
            or record["size"] < 0
            or not _digest(record.get("sha256"))
        ):
            raise ValueError(f"Missing complete regular-file inventory record: {path}")
        selected.append(Artifact(path, record["size"], record["sha256"]))
    return selected


def _destination(root: Path, relative: str) -> Path:
    """Reject destination links instead of following them into other user files."""
    path = root
    for component in PurePosixPath(relative).parts:
        path = path / component
        if path.is_symlink():
            raise ValueError(f"Destination symlink is not an import target: {path}")
    return path


def _matches_existing(path: Path, artifact: Artifact) -> bool:
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return False
    except OSError as error:
        raise ValueError(f"Unsafe existing destination: {path}") from error
    with os.fdopen(descriptor, "rb") as handle:
        before = os.fstat(handle.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_size != artifact.size:
            raise ValueError(f"Conflicting local artifact: {path}")
        digest = hashlib.file_digest(handle, "sha256").hexdigest()
        after = os.fstat(handle.fileno())
        if digest != artifact.sha256 or (
            before.st_size,
            before.st_mtime_ns,
            before.st_ctime_ns,
        ) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise ValueError(f"Conflicting local artifact: {path}")
    return True


def _publish_stream(path: Path, artifact: Artifact, chunks: Iterable[bytes]) -> None:
    """Bound memory to one SDK chunk and disk to the declared complete file size."""
    descriptor, temporary = tempfile.mkstemp(
        dir=path.parent, prefix=".pending-migration-"
    )
    try:
        with os.fdopen(descriptor, "wb") as handle:
            hasher = hashlib.sha256()
            size = 0
            for chunk in chunks:
                size += len(chunk)
                if size > artifact.size:
                    raise ValueError(
                        f"Artifact stream exceeds inventory size: {artifact.path}"
                    )
                handle.write(chunk)
                hasher.update(chunk)
            if size != artifact.size or hasher.hexdigest() != artifact.sha256:
                raise ValueError(
                    f"Artifact stream failed integrity verification: {artifact.path}"
                )
            handle.flush()
            os.fsync(handle.fileno())
        try:
            # An atomic no-clobber link publishes the same fully fsynced inode.
            # Unlike replace(), it cannot overwrite a user file created midstream.
            os.link(temporary, path)
        except FileExistsError:
            if not _matches_existing(path, artifact):
                raise RuntimeError(
                    f"Destination disappeared during publication: {path}"
                ) from None
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        Path(temporary).unlink(missing_ok=True)


def _unique_object(pairs: list[tuple[str, object]]) -> dict:
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError(f"Duplicate JSON key: {key}")
        value[key] = item
    return value


def _read_json(path: Path) -> object:
    return json.loads(path.read_bytes(), object_pairs_hook=_unique_object)


def _verified_manifest(
    manifest_path: Path | None, receipt_path: Path | None
) -> bytes | None:
    if manifest_path is None and receipt_path is None:
        return None
    if manifest_path is None or receipt_path is None:
        raise ValueError(
            "producer-manifest and verified-gpu-receipt must be supplied together"
        )
    raw = manifest_path.read_bytes()
    manifest = ProducerManifest.from_dict(
        json.loads(raw, object_pairs_hook=_unique_object)
    )
    receipt = _read_json(receipt_path)
    if (
        not isinstance(receipt, dict)
        or receipt.get("producer_manifest_sha256") != hashlib.sha256(raw).hexdigest()
        or not isinstance(receipt.get("operations"), list)
    ):
        raise ValueError("GPU receipt does not attest this exact producer manifest")
    observed = set()
    calls = set()
    for result in receipt["operations"]:
        if not isinstance(result, dict):
            raise ValueError("Invalid GPU operation receipt")
        operation = result.get("operation")
        call_id = result.get("call_id")
        if (
            not isinstance(operation, str)
            or operation not in OPERATIONS
            or result.get("status") != "succeeded"
            or not isinstance(call_id, str)
            or re.fullmatch(r"fc-[A-Za-z0-9]+", call_id) is None
            or call_id in calls
            or result.get("producer_digest")
            != manifest.digest_for(operation, result.get("model"))
        ):
            raise ValueError(
                "GPU receipt lacks a successful matching operation/call identity"
            )
        observed.add(operation)
        calls.add(call_id)
    if observed != OPERATIONS:
        raise ValueError("GPU receipt must verify all five operation families")
    return raw


def migrate_artifacts(
    volume: modal.Volume,
    inventory: Mapping[str, object],
    destination_root: Path,
    paths: Sequence[str],
    *,
    producer_manifest: Path | None = None,
    verified_gpu_receipt: Path | None = None,
) -> dict:
    """Import explicitly selected trusted-inventory bytes through read-only SDK I/O.

    Existing exact local bytes are freshly hashed and skipped, never trusted by
    mtime. Conflicts are preserved and rejected. Without the optional verified GPU
    evidence pair, imported legacy keys remain opaque and no producer alias is
    created. Exact-decoder raw-recognition metadata must be imported separately.
    """
    selected = _selection(inventory, paths)
    producer_bytes = _verified_manifest(producer_manifest, verified_gpu_receipt)
    root = Path(destination_root).resolve()
    # Reject known local conflicts before doing any remote reads or publications.
    for artifact in selected:
        _matches_existing(_destination(root, artifact.path), artifact)
    alias = root / "legacy-producer-manifest.json"
    alias_record = None
    if producer_bytes is not None:
        alias = _destination(root, alias.name)
        alias_record = Artifact(
            alias.name, len(producer_bytes), hashlib.sha256(producer_bytes).hexdigest()
        )
        _matches_existing(alias, alias_record)
    imported, present = [], []
    for artifact in selected:
        path = _destination(root, artifact.path)
        path.parent.mkdir(parents=True, exist_ok=True)
        lock_path = _destination(
            root, str(PurePosixPath(artifact.path).with_suffix(".lock"))
        )
        with locked(lock_path):
            if _matches_existing(path, artifact):
                present.append(artifact.path)
                continue
            _publish_stream(path, artifact, volume.read_file(artifact.path))
            imported.append(artifact.path)
    if alias_record is not None and producer_bytes is not None:
        with locked(_destination(root, "legacy-producer-manifest.lock")):
            if not _matches_existing(alias, alias_record):
                _publish_stream(alias, alias_record, (producer_bytes,))
    return {
        "imported": imported,
        "already_present": present,
        "legacy_producer_attested": producer_bytes is not None,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--volume", required=True, help="Existing read-only source model/cache volume"
    )
    parser.add_argument("--environment", required=True)
    parser.add_argument(
        "--destination-root",
        type=Path,
        required=True,
        help="VPS artifact root receiving the existing relative cache layout",
    )
    parser.add_argument(
        "--source-inventory",
        type=Path,
        required=True,
        help="Trusted path -> {type, size, sha256} JSON inventory",
    )
    parser.add_argument(
        "--path",
        action="append",
        required=True,
        help="Exact completed-cache relative path; repeat to select additional files",
    )
    parser.add_argument("--verified-gpu-receipt", type=Path)
    parser.add_argument("--producer-manifest", type=Path)
    arguments = parser.parse_args()
    inventory = _read_json(arguments.source_inventory)
    if not isinstance(inventory, Mapping):
        raise ValueError("Source inventory must map paths to file records")
    # from_name constructs a lazy read-only SDK handle; no compute or deployment.
    volume = modal.Volume.from_name(
        arguments.volume, environment_name=arguments.environment
    )
    result = migrate_artifacts(
        volume,
        inventory,
        arguments.destination_root,
        arguments.path,
        producer_manifest=arguments.producer_manifest,
        verified_gpu_receipt=arguments.verified_gpu_receipt,
    )
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
