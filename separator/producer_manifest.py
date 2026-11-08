"""Explicit producer provenance, independent of deployment and GPU identity.

Loading never inspects the local runtime. Capture must be explicitly invoked in
THE exact retained/current producer runtime; invoking it elsewhere is not evidence
that an old runtime still exists and cannot recover provenance from opaque keys.
No helper downloads models, calls Modal, or runs inference. Asset verification is
read-only and never creates a readiness marker. The caller must supply the complete
prepared model/config/code asset inventory, not just convenient checkpoint names.
"""

import hashlib
import json
import os
import re
import stat
from collections.abc import Mapping, Sequence
from contextlib import ExitStack
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from types import MappingProxyType
from typing import BinaryIO, Literal

from separator import cache_versions
from separator.artifact_cache import atomic_write, cache_key
from separator.inference import OPERATIONS, JSONValue

FORMAT = 1
SEPARATOR_PACKAGES = ("audio-separator", "torch", "onnxruntime-gpu", "librosa")
_VERSION_NAMES = (
    "STEM",
    "ASR",
    "QWEN_MODEL",
    "QWEN_REVISION",
    "ALIGNMENT",
    "ALIGNMENT_MODEL",
    "ASR_SAMPLE_RATE",
    "STRUCTURE",
    "STRUCTURE_MODEL",
    "STRUCTURE_REVISION",
    "STRUCTURE_SHA256",
    "PITCH",
)


def _text(value: object, label: str) -> str:
    if not isinstance(value, str) or not value.strip() or value != value.strip():
        raise ValueError(f"{label} must be a nonempty string")
    return value


def _sha256(value: object, label: str) -> str:
    if not isinstance(value, str) or re.fullmatch(r"[0-9a-f]{64}", value) is None:
        raise ValueError(f"{label} must be an actual lowercase SHA-256")
    return value


def _relative(value: object) -> str:
    value = _text(value, "Asset path")
    path = PurePosixPath(value)
    if (
        path.is_absolute()
        or "\\" in value
        or "\x00" in value
        or ":" in value
        or any(part in {"", ".", ".."} for part in value.split("/"))
    ):
        raise ValueError(f"Unsafe asset path: {value!r}")
    return value


def _mapping(value: object, label: str) -> dict:
    if not isinstance(value, Mapping) or any(not isinstance(key, str) for key in value):
        raise ValueError(f"{label} must be an object with string keys")
    return dict(value)


def _packages(value: object) -> Mapping[str, str]:
    values = _mapping(value, "Packages")
    for name, revision in values.items():
        _text(name, "Package name")
        _text(revision, f"Package {name}")
    return MappingProxyType(values)


def _require_packages(
    values: Mapping[str, str], names: tuple[str, ...]
) -> dict[str, JSONValue]:
    for name in names:
        if name not in values or values[name].lower() in {
            "uninstalled",
            "unknown",
            "missing",
        }:
            raise ValueError(f"Missing actual producer package provenance: {name}")
    return {name: values[name] for name in names}


@dataclass(frozen=True)
class RuntimeManifest:
    """Captured versions, preserved verbatim for exact legacy key reconstruction."""

    packages: Mapping[str, str]
    ffmpeg: str | None
    alignment_packages: Mapping[str, str] = field(default_factory=dict)
    pitch_packages: Mapping[str, str] = field(default_factory=dict)

    def __post_init__(self) -> None:
        for name in ("packages", "alignment_packages", "pitch_packages"):
            object.__setattr__(self, name, _packages(getattr(self, name)))
        if self.ffmpeg is not None:
            _sha256(self.ffmpeg, "ffmpeg executable/shared-library revision")

    def to_dict(self) -> dict:
        return {
            "packages": dict(self.packages),
            "ffmpeg": self.ffmpeg,
            "alignment_packages": dict(self.alignment_packages),
            "pitch_packages": dict(self.pitch_packages),
        }


@dataclass(frozen=True)
class Asset:
    path: str
    sha256: str
    size_bytes: int
    storage: Literal["volume", "image"] = "volume"

    def __post_init__(self) -> None:
        _relative(self.path)
        _sha256(self.sha256, "Asset digest")
        if type(self.size_bytes) is not int or self.size_bytes < 0:
            raise ValueError("Asset size_bytes must be a nonnegative integer")
        if self.storage not in {"volume", "image"}:
            raise ValueError("Asset storage must be volume or image")

    def to_dict(self) -> dict:
        return {
            "path": self.path,
            "sha256": self.sha256,
            "size_bytes": self.size_bytes,
            "storage": self.storage,
        }


def _bindings(value: object) -> Mapping[str, tuple[str, ...]]:
    result = {}
    for name, paths in _mapping(value, "Asset bindings").items():
        if not isinstance(paths, (tuple, list)):
            raise ValueError("Asset binding must be an array of relative paths")
        result[name] = tuple(_relative(path) for path in paths)
        if len(set(result[name])) != len(result[name]):
            raise ValueError("Duplicate asset binding")
    return MappingProxyType(result)


@dataclass(frozen=True)
class ProducerManifest:
    image_id: str
    separator: RuntimeManifest
    asr: RuntimeManifest
    structure: RuntimeManifest
    versions: Mapping[str, str | int]
    models: Mapping[str, str]
    assets: tuple[Asset, ...]
    operation_assets: Mapping[str, tuple[str, ...]]
    model_assets: Mapping[str, tuple[str, ...]]
    format: int = FORMAT

    def __post_init__(self) -> None:
        if type(self.format) is not int or self.format != FORMAT:
            raise ValueError("Unsupported producer manifest format")
        _text(self.image_id, "Producer image_id provenance")
        for name in ("separator", "asr", "structure"):
            if not isinstance(getattr(self, name), RuntimeManifest):
                raise ValueError(f"{name} must be a RuntimeManifest")
        versions = _mapping(self.versions, "Captured algorithm versions")
        if set(versions) - set(_VERSION_NAMES):
            raise ValueError("Unknown captured algorithm version")
        for name, value in versions.items():
            if name == "ASR_SAMPLE_RATE":
                if type(value) is not int or value <= 0:
                    raise ValueError("ASR_SAMPLE_RATE must be a positive integer")
            else:
                _text(value, name)
        object.__setattr__(self, "versions", MappingProxyType(versions))
        models = _mapping(self.models, "Model digests")
        for name, digest in models.items():
            if "/" in _relative(name):
                raise ValueError("Configured separation model must be a filename")
            _sha256(digest, f"Model {name}")
        object.__setattr__(self, "models", MappingProxyType(models))
        if not isinstance(self.assets, (tuple, list)) or any(
            not isinstance(asset, Asset) for asset in self.assets
        ):
            raise ValueError("assets must contain Asset records")
        object.__setattr__(self, "assets", tuple(self.assets))
        paths = {asset.path for asset in self.assets}
        if len(paths) != len(self.assets):
            raise ValueError("Duplicate asset path")
        for name in ("operation_assets", "model_assets"):
            bindings = _bindings(getattr(self, name))
            object.__setattr__(self, name, bindings)
            if any(path not in paths for bound in bindings.values() for path in bound):
                raise ValueError("Asset binding references an uncaptured file")
        if set(self.operation_assets) - OPERATIONS:
            raise ValueError("Unsupported asset operation")
        if set(self.model_assets) - set(models):
            raise ValueError("Asset binding references an unknown separation model")

    @classmethod
    def from_dict(cls, data: object) -> "ProducerManifest":
        values = _mapping(data, "Producer manifest")
        required = {
            "format",
            "image_id",
            "separator",
            "asr",
            "structure",
            "versions",
            "models",
            "assets",
            "operation_assets",
            "model_assets",
        }
        if set(values) != required:
            raise ValueError("Producer manifest fields are missing or unknown")
        try:
            for name in ("separator", "asr", "structure"):
                values[name] = RuntimeManifest(**_mapping(values[name], name))
            if not isinstance(values["assets"], list):
                raise ValueError("assets must be an array")
            values["assets"] = tuple(
                Asset(**_mapping(asset, "Asset")) for asset in values["assets"]
            )
            return cls(**values)
        except TypeError as error:
            raise ValueError("Invalid producer manifest fields") from error

    def to_dict(self) -> dict:
        return {
            "format": self.format,
            "image_id": self.image_id,
            "separator": self.separator.to_dict(),
            "asr": self.asr.to_dict(),
            "structure": self.structure.to_dict(),
            "versions": dict(self.versions),
            "models": dict(self.models),
            "assets": [asset.to_dict() for asset in self.assets],
            "operation_assets": {
                key: list(value) for key, value in self.operation_assets.items()
            },
            "model_assets": {
                key: list(value) for key, value in self.model_assets.items()
            },
        }

    def operation_identity(
        self, operation: str, model: str | None = None
    ) -> dict[str, JSONValue]:
        """Validate selected dependencies, excluding deployment and unrelated stages.

        This is producer identity, not a result key: callers still key input bytes
        and operation parameters. Asset paths are relative logical names, never a
        deployment root. No claim about an old opaque cache key is inferred here.
        """
        if operation not in OPERATIONS:
            raise ValueError(f"Unsupported inference operation: {operation}")
        if operation != "separation" and model is not None:
            raise ValueError("Only separation accepts a configured model filename")
        runtime, packages, version_names = {
            "separation": (self.separator, self.separator.packages, ("STEM",)),
            "recognition": (
                self.asr,
                self.asr.packages,
                ("ASR", "QWEN_MODEL", "QWEN_REVISION", "ASR_SAMPLE_RATE"),
            ),
            "alignment": (
                self.asr,
                self.asr.alignment_packages,
                ("ALIGNMENT", "ALIGNMENT_MODEL", "ASR_SAMPLE_RATE"),
            ),
            "structure": (
                self.structure,
                self.structure.packages,
                (
                    "STRUCTURE",
                    "STRUCTURE_MODEL",
                    "STRUCTURE_REVISION",
                    "STRUCTURE_SHA256",
                ),
            ),
            "pitch": (self.structure, self.structure.pitch_packages, ("PITCH",)),
        }[operation]
        required_packages = {
            "separation": SEPARATOR_PACKAGES,
            "recognition": cache_versions.ASR_PACKAGES,
            "alignment": cache_versions.ALIGNMENT_PACKAGES,
            "structure": cache_versions.STRUCTURE_PACKAGES,
            "pitch": cache_versions.PITCH_PACKAGES,
        }[operation]
        if any(
            name not in self.versions
            or str(self.versions[name]).lower() in {"uninstalled", "unknown", "missing"}
            for name in version_names
        ):
            raise ValueError(f"Missing captured algorithm provenance for {operation}")
        for name in ("QWEN_REVISION", "STRUCTURE_REVISION"):
            if (
                name in version_names
                and re.fullmatch(r"[0-9a-f]{40}", str(self.versions[name])) is None
            ):
                raise ValueError(f"Missing immutable model revision: {name}")
        identity: dict[str, JSONValue] = {
            "operation": operation,
            "versions": {name: self.versions[name] for name in version_names},
            "packages": _require_packages(packages, required_packages),
        }
        decoder = _sha256(runtime.ffmpeg, f"{operation} ffmpeg revision")
        # Alignment callers key the actual decoded PCM and raw/reference context;
        # decoder changes that produce identical PCM must not redo alignment.
        if operation != "alignment":
            identity["ffmpeg"] = decoder
        paths = set(self.operation_assets.get(operation, ()))
        by_path = {asset.path: asset for asset in self.assets}
        if operation == "separation":
            if model is None or model not in self.models:
                raise ValueError(
                    "Separation requires an actual configured model digest"
                )
            bound = self.model_assets.get(model, ())
            if not any(by_path[path].sha256 == self.models[model] for path in bound):
                raise ValueError(
                    "Separation checkpoint digest lacks a bound prepared asset"
                )
            paths.update(bound)
            identity["model"] = model
            identity["model_sha256"] = self.models[model]
        if not paths:
            raise ValueError(
                f"Missing actual prepared asset provenance for {operation}"
            )
        if operation == "structure":
            expected = _sha256(
                self.versions["STRUCTURE_SHA256"], "SongFormer checkpoint"
            )
            if not any(by_path[path].sha256 == expected for path in paths):
                raise ValueError(
                    "SongFormer pinned checkpoint lacks a bound prepared asset"
                )
        identity["assets"] = {path: by_path[path].sha256 for path in sorted(paths)}
        return identity

    def digest_for(self, operation: str, model: str | None = None) -> str:
        return cache_key(self.operation_identity(operation, model))

    def verify_assets(
        self, root: str | Path, image_root: str | Path | None = None
    ) -> None:
        """Admin/preprovision-only full hashing; never call on GPU job admission.

        Canonical Hugging Face file/directory symlinks are allowed only when their
        strict resolved target stays inside the immutable prepared root. Opening
        the resolved path with no-follow directory-relative descriptors rejects
        subsequent symlink replacement. No files or trust markers are written.
        Image-bundled assets use the caller's explicit trusted image prefix (for
        example /opt/lyrics-structure), never an absolute path from the manifest.
        An image asset without image_root fails closed. Storage location is not a
        producer identity; the actual bundled weight hash is.
        """
        root = Path(root).resolve(strict=True)
        image_root = (
            Path(image_root).resolve(strict=True) if image_root is not None else None
        )
        for asset in self.assets:
            try:
                selected_root = _asset_root(asset.storage, root, image_root)
                resolved = _resolved_asset(selected_root, asset.path)
                with ExitStack() as stack:
                    directory = os.open(selected_root, os.O_RDONLY | os.O_DIRECTORY)
                    stack.callback(os.close, directory)
                    parts = resolved.relative_to(selected_root).parts
                    for part in parts[:-1]:
                        directory = os.open(
                            part,
                            os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                            dir_fd=directory,
                        )
                        stack.callback(os.close, directory)
                    descriptor = os.open(
                        parts[-1],
                        os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                        dir_fd=directory,
                    )
                    handle: BinaryIO = stack.enter_context(os.fdopen(descriptor, "rb"))
                    before = os.fstat(handle.fileno())
                    if (
                        not stat.S_ISREG(before.st_mode)
                        or before.st_size != asset.size_bytes
                    ):
                        raise ValueError(f"Asset size/type mismatch: {asset.path}")
                    digest = hashlib.file_digest(handle, "sha256").hexdigest()
                    after = os.fstat(handle.fileno())
                    if digest != asset.sha256 or _file_state(before) != _file_state(
                        after
                    ):
                        raise ValueError(f"Asset digest/content mismatch: {asset.path}")
            except OSError as error:
                raise ValueError(f"Missing or unsafe asset: {asset.path}") from error


def _asset_root(storage: str, root: Path, image_root: Path | None) -> Path:
    if storage == "volume":
        return root
    if image_root is None:
        raise ValueError("Image asset requires an explicit trusted image_root")
    return image_root


def _resolved_asset(root: Path, relative: str) -> Path:
    path = (root / relative).resolve(strict=True)
    if path == root or not path.is_relative_to(root):
        raise ValueError(f"Missing or unsafe asset: {relative}")
    return path


def _file_state(value: os.stat_result) -> tuple[int, int, int, int]:
    return value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns


def _unique_object(pairs: list[tuple[str, object]]) -> dict:
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"Duplicate manifest key: {key}")
        result[key] = value
    return result


def load_manifest(path: str | Path) -> ProducerManifest:
    """Read supplied provenance without probing this host or trusting local defaults."""
    return ProducerManifest.from_dict(
        json.loads(Path(path).read_bytes(), object_pairs_hook=_unique_object)
    )


def save_manifest(path: str | Path, manifest: ProducerManifest) -> None:
    """Atomically publish a manifest; saving does not attest asset verification."""
    atomic_write(
        Path(path),
        (json.dumps(manifest.to_dict(), sort_keys=True, indent=2) + "\n").encode(),
    )


def verify_runtime(
    manifest: ProducerManifest,
    operation: str,
    model: str | None = None,
    *,
    asr_python: str | None,
    structure_python: str | None,
) -> None:
    """Fail closed unless this runtime matches the selected captured producer.

    Call explicitly inside the inference runtime, not during VPS cache lookup.
    This checks installed distributions, current algorithm/pinned-model constants,
    and the ffmpeg executable/shared-library fingerprint without model imports or
    model-asset hashing. Prepared assets require separate ``verify_assets`` before
    provisioning. A successful check neither proves an old runtime was retained
    nor reconstructs provenance for an opaque historical cache key.
    """
    identity = manifest.operation_identity(operation, model)
    versions = identity["versions"]
    packages = identity["packages"]
    # operation_identity constructs these dictionaries after selected validation.
    assert isinstance(versions, dict) and isinstance(packages, dict)
    for name, expected in versions.items():
        if getattr(cache_versions, name) != expected:
            raise ValueError(
                f"Producer runtime algorithm mismatch for {operation}: {name}"
            )
    python = (
        asr_python
        if operation in {"recognition", "alignment"}
        else structure_python
        if operation in {"structure", "pitch"}
        else None
    )
    actual_packages = cache_versions.environment_revisions(python, tuple(packages))
    for name, expected in packages.items():
        actual = actual_packages.get(name)
        if actual != expected:
            raise ValueError(
                f"Producer runtime package mismatch for {operation}: "
                f"{name} (captured {expected!r}, installed {actual!r})"
            )
    # Alignment result identity is PCM-based, but admission must still attest
    # the actual decoder used to produce those bytes.
    decoder = manifest.asr.ffmpeg if operation == "alignment" else identity["ffmpeg"]
    actual_decoder = cache_versions.binary_revision("ffmpeg")
    if actual_decoder != decoder:
        raise ValueError(
            f"Producer runtime ffmpeg mismatch for {operation}: "
            f"captured {decoder}, installed {actual_decoder}"
        )


def capture_manifest(
    *,
    image_id: str,
    root: str | Path,
    models: Mapping[str, str],
    operation_assets: Mapping[str, Sequence[str]],
    model_assets: Mapping[str, Sequence[str]],
    asr_python: str | None,
    structure_python: str | None,
    image_assets: Sequence[str] = (),
    image_root: str | Path | None = None,
) -> ProducerManifest:
    """Explicitly capture ONLY inside the exact retained/current producer runtime.

    `models` maps configured separation filenames to prepared relative checkpoint
    paths. Bind every consumed weight/config/remote-code file to its operation or
    configured separation model. In-root canonical Hugging Face symlinks are
    resolved without copying weights. This admin/preprovision helper is not GPU
    job admission. Secondary environment revisions are read from installed
    distributions without executing those interpreters. `None` explicitly selects
    this interpreter. This is NOT evidence that an old runtime is available: the
    operator must establish that prerequisite separately.
    `image_assets` selects bound relative paths stored under the caller's trusted
    `image_root` prefix instead of the prepared volume. No weights are copied;
    every captured asset still has an actual SHA-256. Paths are unique across
    storage classes so operation bindings remain unambiguous.
    """
    root = Path(root).resolve(strict=True)
    image_root = (
        Path(image_root).resolve(strict=True) if image_root is not None else None
    )
    if isinstance(image_assets, (str, bytes)):
        raise ValueError("image_assets must be a sequence of relative paths")
    image_paths = {_relative(path) for path in image_assets}
    operation_bindings = _bindings(operation_assets)
    model_bindings = dict(_bindings(model_assets))
    model_paths = {
        name: _relative(path) for name, path in _mapping(models, "Models").items()
    }
    for name, path in model_paths.items():
        model_bindings[name] = tuple(
            dict.fromkeys((*model_bindings.get(name, ()), path))
        )
    paths = {
        path
        for binding in (*operation_bindings.values(), *model_bindings.values())
        for path in binding
    }
    if image_paths - paths:
        raise ValueError("Image asset must be bound to an operation or model")
    assets = []
    for relative in sorted(paths):
        try:
            storage = "image" if relative in image_paths else "volume"
            path = _resolved_asset(_asset_root(storage, root, image_root), relative)
            before = path.stat()
            if not stat.S_ISREG(before.st_mode):
                raise ValueError(f"Capture asset is not a regular file: {relative}")
            revision = cache_versions.file_revision(path)
            if _file_state(before) != _file_state(path.stat()):
                raise ValueError(f"Capture asset changed during hashing: {relative}")
            assets.append(Asset(relative, revision, before.st_size, storage=storage))
        except OSError as error:
            raise ValueError(f"Missing capture asset: {relative}") from error
    by_path = {asset.path: asset for asset in assets}
    ffmpeg = cache_versions.binary_revision("ffmpeg")
    manifest = ProducerManifest(
        image_id=image_id,
        separator=RuntimeManifest(
            cache_versions.environment_revisions(None, SEPARATOR_PACKAGES), ffmpeg
        ),
        asr=RuntimeManifest(
            cache_versions.environment_revisions(
                asr_python, cache_versions.ASR_PACKAGES
            ),
            ffmpeg,
            alignment_packages=cache_versions.environment_revisions(
                asr_python, cache_versions.ALIGNMENT_PACKAGES
            ),
        ),
        structure=RuntimeManifest(
            cache_versions.environment_revisions(
                structure_python, cache_versions.STRUCTURE_PACKAGES
            ),
            ffmpeg,
            pitch_packages=cache_versions.environment_revisions(
                structure_python, cache_versions.PITCH_PACKAGES
            ),
        ),
        versions={name: getattr(cache_versions, name) for name in _VERSION_NAMES},
        models={name: by_path[path].sha256 for name, path in model_paths.items()},
        assets=tuple(assets),
        operation_assets=operation_bindings,
        model_assets=model_bindings,
    )
    for operation in operation_bindings:
        if operation != "separation":
            manifest.operation_identity(operation)
    for model in model_paths:
        manifest.operation_identity("separation", model)
    return manifest
