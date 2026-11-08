"""CPU preparation receipts shared across consumers, never a Modal compute RPC.

The root is PREPARED_MODELS_ROOT (a shared administrative weight-receipt store),
not any consumer's private computed-output cache. Immutable-volume bytes may be
streamed through the read-only SDK once on a cold receipt; no models are downloaded
from providers or rehashed per job. Image-bundled weights require an administrator's
exact-image inspection receipt. None of these CPU receipts attests a historical
GPU producer, and importing one never creates a legacy producer-manifest alias.
"""

import argparse
import hashlib
import json
import math
from dataclasses import asdict
from pathlib import Path

import modal

from separator.artifact_cache import atomic_write, cache_key, locked
from separator.inference import InferenceRequest
from separator.producer_manifest import Asset, ProducerManifest, load_manifest


def _marker(root: Path, owner: str, asset: Asset) -> Path:
    return root / "prepared-models" / f"{cache_key(owner, asdict(asset))}.json"


def _record(root: Path, owner: str, asset: Asset) -> None:
    atomic_write(
        _marker(root, owner, asset),
        json.dumps({"owner": owner, "asset": asdict(asset)}, sort_keys=True).encode(),
    )


def _is_digest(value: object) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 64
        and all(character in "0123456789abcdef" for character in value)
    )


def _recognition_metadata(manifest: ProducerManifest, value: object) -> bytes | None:
    if not isinstance(value, dict) or type(value.get("baseline_exists")) is not bool:
        raise ValueError("Invalid recognition metadata baseline")
    if value["baseline_exists"] or "duration_s" in value or "pcm_identity" in value:
        duration = value.get("duration_s")
        pcm = value.get("pcm_identity")
        if (
            not isinstance(duration, (int, float))
            or isinstance(duration, bool)
            or not math.isfinite(duration)
            or duration <= 0
            or not isinstance(pcm, list)
            or len(pcm) != 4
            or type(pcm[0]) is not int
            or pcm[0] != manifest.versions.get("ASR_SAMPLE_RATE")
            or pcm[0] <= 0
            or pcm[1] != "f"
            or not isinstance(pcm[2], list)
            or len(pcm[2]) != 1
            or type(pcm[2][0]) is not int
            or pcm[2][0] <= 0
            or not _is_digest(pcm[3])
        ):
            raise ValueError("Invalid recognition decoded-source metadata")
        if not math.isclose(
            duration, pcm[2][0] / pcm[0], rel_tol=1e-9, abs_tol=1 / pcm[0]
        ):
            raise ValueError("Recognition duration does not match decoded PCM")
    try:
        encoded = json.dumps(value, allow_nan=False).encode()
    except (TypeError, ValueError) as error:
        raise ValueError("Invalid recognition metadata JSON") from error
    return encoded if value["baseline_exists"] else None


def import_inspection(
    manifest: ProducerManifest, receipt: dict, root: Path, volume_id: str
) -> None:
    """Validate a trusted admin inspection fully before publishing any receipts.

    Image/volume ownership and actual asset digests are checked, but this CPU
    inspection is not evidence that a historical GPU inference producer matches.
    The shared root contains weight receipts and optional decoded-source metadata,
    never a fabricated legacy producer manifest or private inference outputs.
    """
    if (
        not isinstance(receipt, dict)
        or receipt.get("complete") is not True
        or receipt.get("image_id") != manifest.image_id
        or receipt.get("volume_id") != volume_id
        or not _is_digest(receipt.get("fingerprint_source_sha256"))
    ):
        raise ValueError("Inspection does not attest the selected image and volume")
    observed = {}
    for storage, field in (("volume", "assets"), ("image", "image_assets")):
        items = receipt.get(field, [])
        if not isinstance(items, list):
            raise ValueError("Inspection assets must be arrays")
        for item in items:
            if not isinstance(item, dict):
                raise ValueError("Invalid inspection asset")
            try:
                asset = Asset(item["path"], item["sha256"], item["size_bytes"], storage)
            except (KeyError, TypeError) as error:
                raise ValueError("Invalid inspection asset") from error
            key = (storage, asset.path)
            if key in observed:
                raise ValueError("Duplicate inspection asset")
            observed[key] = asset
    for asset in manifest.assets:
        if observed.get((asset.storage, asset.path)) != asset:
            raise ValueError(f"Inspection does not verify model asset: {asset.path}")
    metadata = receipt.get("recognition_info", {})
    if not isinstance(metadata, dict):
        raise ValueError("Invalid recognition metadata")
    recognition_records = []
    for key, value in metadata.items():
        if not _is_digest(key):
            raise ValueError("Invalid recognition metadata key")
        encoded = _recognition_metadata(manifest, value)
        if encoded is not None:
            recognition_records.append((key, encoded))
    # No publication occurs until every asset and metadata entry passes validation.
    for asset in manifest.assets:
        owner = manifest.image_id if asset.storage == "image" else volume_id
        with locked(_marker(root, owner, asset).with_suffix(".lock")):
            _record(root, owner, asset)
    for key, encoded in recognition_records:
        atomic_write(root / "recognition-info" / f"{key}.json", encoded)


def ensure_prepared(
    manifest: ProducerManifest,
    request: InferenceRequest,
    root: Path,
    volume_name: str,
    environment: str,
) -> None:
    """Verify missing selected-asset receipts on CPU before inference admission.

    ``root`` is the shared prepared-model receipt root, independent of private
    computed-output roots. Immutable weights are mounted read-only by every
    consumer. Receipts persist across jobs/restarts; no TTL/per-stage rehash exists.
    """
    model = (
        request.parameters.get("model") if request.operation == "separation" else None
    )
    if model is not None and not isinstance(model, str):
        raise ValueError("Invalid separation model")
    if request.producer_digest != manifest.digest_for(request.operation, model):
        raise ValueError("Inference producer does not match prepared assets")
    paths = set(manifest.operation_assets.get(request.operation, ()))
    if model is not None:
        paths.update(manifest.model_assets[model])
    if request.operation == "separation":
        # audio-separator needs its offline registry even on a checkpoint hit.
        # Prepare its declared bytes without adding this mutable whole catalog
        # to any individual model's algorithm identity.
        paths.update(
            asset.path
            for asset in manifest.assets
            if Path(asset.path).name == "download_checks.json"
        )
    assets = {asset.path: asset for asset in manifest.assets}
    volume = modal.Volume.from_name(volume_name, environment_name=environment)
    volume.hydrate()
    for name in sorted(paths):
        asset = assets[name]
        owner = manifest.image_id if asset.storage == "image" else volume.object_id
        marker = _marker(root, owner, asset)
        with locked(marker.with_suffix(".lock")):
            if marker.is_file():
                value = json.loads(marker.read_text())
                if value == {"owner": owner, "asset": asdict(asset)}:
                    continue
                raise ValueError("Invalid prepared model receipt")
            if asset.storage == "image":
                raise RuntimeError(
                    "Bundled model requires a verified exact-image inspection "
                    "before inference"
                )
            hasher = hashlib.sha256()
            size = 0
            for chunk in volume.read_file(asset.path):
                size += len(chunk)
                hasher.update(chunk)
            if size != asset.size_bytes or hasher.hexdigest() != asset.sha256:
                raise ValueError(
                    f"Prepared model asset failed integrity verification: {asset.path}"
                )
            _record(root, owner, asset)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--volume", required=True)
    parser.add_argument("--environment", required=True)
    parser.add_argument(
        "--prepared-models-root",
        type=Path,
        required=True,
        help="Shared weight receipts, NOT a private computed-output cache",
    )
    parser.add_argument("--receipt", type=Path, required=True)
    arguments = parser.parse_args()
    manifest = load_manifest(arguments.manifest)
    volume = modal.Volume.from_name(
        arguments.volume, environment_name=arguments.environment
    )
    volume.hydrate()
    import_inspection(
        manifest,
        json.loads(arguments.receipt.read_text()),
        arguments.prepared_models_root,
        volume.object_id,
    )


if __name__ == "__main__":
    main()
