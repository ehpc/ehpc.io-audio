"""Pure local provenance and prepared-file integrity; no model/provider calls."""

import hashlib
import json
import os
from dataclasses import replace
from typing import Literal, cast

import pytest

from separator import cache_versions
from separator.artifact_cache import cache_key
from separator.producer_manifest import (
    SEPARATOR_PACKAGES,
    Asset,
    ProducerManifest,
    RuntimeManifest,
    capture_manifest,
    load_manifest,
    save_manifest,
    verify_runtime,
)


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def installed(names):
    return {name: f"1.0.{index}" for index, name in enumerate(names)}


@pytest.fixture
def prepared(tmp_path):
    contents = {
        "separator/voice.ckpt": b"separation checkpoint",
        "separator/voice.yaml": b"separation config",
        "separator/drums.ckpt": b"other separation checkpoint",
        "asr/model.safetensors": b"recognition weights",
        "asr/config.json": b'{"architecture":"recognizer"}',
        "alignment/model.pt": b"actual alignment weights",
        "pitch/full.pth": b"pitch weights",
        "structure/model.safetensors": b"structure checkpoint",
        "structure/config.json": b'{"architecture":"structure"}',
    }
    assets = []
    for relative, data in contents.items():
        path = tmp_path / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        assets.append(Asset(relative, sha(data), len(data)))
    # Synthetic captured values intentionally never pretend to be an actual old
    # runtime export. Only capture_manifest reads real installed provenance.
    versions = {
        name: getattr(cache_versions, name)
        for name in (
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
    }
    versions["STRUCTURE_SHA256"] = sha(contents["structure/model.safetensors"])
    decoder = sha(b"synthetic executable and shared library revision")
    manifest = ProducerManifest(
        image_id="synthetic-test-image",
        separator=RuntimeManifest(installed(SEPARATOR_PACKAGES), decoder),
        asr=RuntimeManifest(
            installed(cache_versions.ASR_PACKAGES),
            decoder,
            alignment_packages=installed(cache_versions.ALIGNMENT_PACKAGES),
        ),
        structure=RuntimeManifest(
            installed(cache_versions.STRUCTURE_PACKAGES),
            decoder,
            pitch_packages=installed(cache_versions.PITCH_PACKAGES),
        ),
        versions=versions,
        models={
            "voice.ckpt": sha(contents["separator/voice.ckpt"]),
            "drums.ckpt": sha(contents["separator/drums.ckpt"]),
        },
        assets=tuple(assets),
        operation_assets={
            "recognition": ("asr/model.safetensors", "asr/config.json"),
            "alignment": ("alignment/model.pt",),
            "pitch": ("pitch/full.pth",),
            "structure": ("structure/model.safetensors", "structure/config.json"),
        },
        model_assets={
            "voice.ckpt": ("separator/voice.ckpt", "separator/voice.yaml"),
            "drums.ckpt": ("separator/drums.ckpt",),
        },
    )
    return tmp_path, manifest


def identities(manifest):
    return {
        **{
            operation: manifest.digest_for(operation)
            for operation in ("recognition", "alignment", "pitch", "structure")
        },
        **{
            model: manifest.digest_for("separation", model) for model in manifest.models
        },
    }


def test_roundtrip_atomic_save_and_legacy_fields(prepared):
    root, manifest = prepared
    path = root / "provenance" / "producer.json"
    save_manifest(path, manifest)
    restored = load_manifest(path)
    assert restored.to_dict() == manifest.to_dict()
    assert identities(restored) == identities(manifest)
    assert not list(path.parent.glob(".pending-*"))
    restored.verify_assets(root)
    assert (
        restored.separator.packages["audio-separator"]
        == manifest.separator.packages["audio-separator"]
    )
    assert restored.asr.alignment_packages == manifest.asr.alignment_packages
    assert restored.structure.pitch_packages == manifest.structure.pitch_packages
    assert restored.versions == manifest.versions
    assert restored.digest_for("alignment") == cache_key(
        restored.operation_identity("alignment")
    )
    assert len(restored.digest_for("alignment")) == 64


@pytest.mark.parametrize("mutation", ["missing", "corrupt", "short"])
def test_actual_asset_missing_or_corrupt_is_rejected(prepared, mutation):
    root, manifest = prepared
    path = root / "alignment/model.pt"
    assert cache_versions.file_revision(path) == sha(path.read_bytes())
    if mutation == "missing":
        path.unlink()
    elif mutation == "short":
        path.write_bytes(b"short")
    else:
        before = path.stat()
        path.write_bytes(b"x" * before.st_size)
        # Verification must not trust file_revision's size/mtime memoization.
        os.utime(path, ns=(before.st_atime_ns, before.st_mtime_ns))
    with pytest.raises(ValueError, match=r"asset|Asset"):
        manifest.verify_assets(root)
    assert not list(root.glob("*.verified*"))


@pytest.mark.parametrize(
    "path",
    [
        "../escape",
        "/absolute",
        "a/../../escape",
        "a//b",
        "a/./b",
        "a\\b",
        "C:/escape",
        "a\x00b",
        ".",
        "",
    ],
)
def test_unsafe_relative_paths_rejected(path):
    with pytest.raises(ValueError):
        Asset(path, sha(b"data"), 4)


@pytest.mark.parametrize("directory", [False, True])
def test_symlink_escape_is_rejected(prepared, tmp_path_factory, directory):
    root, manifest = prepared
    outside = tmp_path_factory.mktemp("outside-assets")
    original = root / "alignment/model.pt"
    (outside / "model.pt").write_bytes(original.read_bytes())
    original.unlink()
    if directory:
        original.parent.rmdir()
        original.parent.symlink_to(outside, target_is_directory=True)
    else:
        original.symlink_to(outside / "model.pt")
    with pytest.raises(ValueError, match="unsafe asset"):
        manifest.verify_assets(root)


@pytest.mark.parametrize(
    "relative,affected",
    [
        ("separator/voice.ckpt", {"voice.ckpt"}),
        ("separator/voice.yaml", {"voice.ckpt"}),
        ("asr/config.json", {"recognition"}),
        ("alignment/model.pt", {"alignment"}),
        ("pitch/full.pth", {"pitch"}),
        ("structure/config.json", {"structure"}),
        ("structure/model.safetensors", {"structure"}),
    ],
)
def test_checkpoint_and_config_invalidation_is_local(prepared, relative, affected):
    _, manifest = prepared
    digest = sha(b"new actual asset bytes")
    assets = tuple(
        replace(asset, sha256=digest) if asset.path == relative else asset
        for asset in manifest.assets
    )
    models = dict(manifest.models)
    versions = dict(manifest.versions)
    if relative == "separator/voice.ckpt":
        models["voice.ckpt"] = digest
    if relative == "structure/model.safetensors":
        versions["STRUCTURE_SHA256"] = digest
    changed = replace(manifest, assets=assets, models=models, versions=versions)
    before, after = identities(manifest), identities(changed)
    assert {key for key in before if before[key] != after[key]} == affected


def test_asr_only_package_change_preserves_other_stages(prepared):
    _, manifest = prepared
    changed = replace(
        manifest,
        asr=replace(
            manifest.asr, packages={**manifest.asr.packages, "qwen-asr": "2.0"}
        ),
    )
    before, after = identities(manifest), identities(changed)
    assert {key for key in before if before[key] != after[key]} == {"recognition"}


def test_captured_algorithm_change_is_local_and_not_current_host_default(
    prepared, monkeypatch
):
    _, manifest = prepared
    before = identities(manifest)
    monkeypatch.setattr(cache_versions, "ASR", "new-code-not-the-captured-runtime")
    assert identities(manifest) == before
    changed = replace(
        manifest, versions={**manifest.versions, "ASR": "captured-new-asr"}
    )
    after = identities(changed)
    assert {key for key in before if before[key] != after[key]} == {"recognition"}


def test_image_gpu_host_and_root_do_not_invalidate(
    prepared, tmp_path_factory, monkeypatch
):
    root, manifest = prepared
    before = identities(manifest)
    monkeypatch.setenv("CUDA_VISIBLE_DEVICES", "different-device")
    monkeypatch.setenv("HOSTNAME", "different-host")
    changed = replace(manifest, image_id="different-deployment-image")
    assert identities(changed) == before
    other_root = tmp_path_factory.mktemp("relocated-assets")
    for asset in manifest.assets:
        path = other_root / asset.path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes((root / asset.path).read_bytes())
    changed.verify_assets(other_root)
    assert identities(changed) == before


@pytest.mark.parametrize(
    "operation,model",
    [
        ("recognition", None),
        ("alignment", None),
        ("pitch", None),
        ("structure", None),
        ("separation", "voice.ckpt"),
    ],
)
def test_missing_bound_assets_fail_closed_for_selected_operation(
    prepared, operation, model
):
    _, manifest = prepared
    if model:
        changed = replace(
            manifest,
            model_assets={
                key: value
                for key, value in manifest.model_assets.items()
                if key != model
            },
        )
    else:
        changed = replace(
            manifest,
            operation_assets={
                key: value
                for key, value in manifest.operation_assets.items()
                if key != operation
            },
        )
    with pytest.raises(ValueError, match="asset"):
        changed.digest_for(operation, model)


def test_missing_package_provenance_fails_only_selected_operation(prepared):
    _, manifest = prepared
    changed = replace(
        manifest,
        asr=replace(
            manifest.asr, packages={**manifest.asr.packages, "qwen-asr": "uninstalled"}
        ),
    )
    with pytest.raises(ValueError, match="package provenance"):
        changed.digest_for("recognition")
    assert changed.digest_for("pitch") == manifest.digest_for("pitch")
    assert changed.digest_for("structure") == manifest.digest_for("structure")
    assert changed.digest_for("alignment") == manifest.digest_for("alignment")


def test_unknown_models_missing_algorithms_decoder_and_checkpoint_fail_closed(prepared):
    _, manifest = prepared
    for model in (None, "unknown.ckpt"):
        with pytest.raises(ValueError, match="actual configured model"):
            manifest.digest_for("separation", model)
    with pytest.raises(ValueError, match="algorithm provenance"):
        replace(manifest, versions={}).digest_for("alignment")
    with pytest.raises(ValueError, match="ffmpeg"):
        replace(manifest, asr=replace(manifest.asr, ffmpeg=None)).digest_for(
            "recognition"
        )
    with pytest.raises(ValueError, match="checkpoint"):
        replace(
            manifest, models={**manifest.models, "voice.ckpt": sha(b"unbound model")}
        ).digest_for("separation", "voice.ckpt")
    with pytest.raises(ValueError, match="checkpoint"):
        replace(
            manifest,
            versions={
                **manifest.versions,
                "STRUCTURE_SHA256": sha(b"unbound structure"),
            },
        ).digest_for("structure")
    with pytest.raises(ValueError, match="Unsupported"):
        manifest.digest_for("orchestration")
    with pytest.raises(ValueError, match="Only separation"):
        manifest.digest_for("alignment", "voice.ckpt")


def test_manifest_rejects_ambiguous_or_invented_data(prepared):
    root, manifest = prepared
    valid = manifest.to_dict()
    invalid = [
        {**valid, "format": True},
        {**valid, "format": 2},
        {**valid, "image_id": ""},
        {**valid, "models": {"voice.ckpt": "uninstalled"}},
        {**valid, "operation_assets": {"alignment": ["not-captured"]}},
        {**valid, "assets": [*valid["assets"], valid["assets"][0]]},
        {**valid, "host_gpu": "not-an-identity-field"},
        {key: value for key, value in valid.items() if key != "versions"},
    ]
    for data in invalid:
        with pytest.raises(ValueError):
            ProducerManifest.from_dict(data)
    path = root / "duplicate.json"
    path.write_text('{"format":1,"format":1}')
    with pytest.raises(ValueError, match="Duplicate"):
        load_manifest(path)
    with pytest.raises(ValueError):
        Asset("file", sha(b"data"), True)
    with pytest.raises(TypeError):
        manifest.models["voice.ckpt"] = sha(b"mutated")


def test_capture_reads_explicit_environments_and_hashes_each_asset_once(
    prepared, monkeypatch
):
    root, expected = prepared
    probes, hashes = [], []
    actual_file_revision = cache_versions.file_revision

    def revisions(python, packages):
        probes.append((python, packages))
        return installed(packages)

    def revision(path):
        hashes.append(path.relative_to(root).as_posix())
        return actual_file_revision(path)

    monkeypatch.setattr(cache_versions, "environment_revisions", revisions)
    monkeypatch.setattr(
        cache_versions, "binary_revision", lambda name: expected.separator.ffmpeg
    )
    monkeypatch.setattr(cache_versions, "file_revision", revision)
    monkeypatch.setattr(
        cache_versions, "STRUCTURE_SHA256", expected.versions["STRUCTURE_SHA256"]
    )
    captured = capture_manifest(
        image_id="explicit-runtime",
        root=root,
        models={
            "voice.ckpt": "separator/voice.ckpt",
            "drums.ckpt": "separator/drums.ckpt",
        },
        operation_assets=expected.operation_assets,
        model_assets=expected.model_assets,
        asr_python="/retained/asr/bin/python",
        structure_python="/retained/structure/bin/python",
    )
    assert set(hashes) == {asset.path for asset in expected.assets}
    assert len(hashes) == len(set(hashes))
    assert probes == [
        (None, SEPARATOR_PACKAGES),
        ("/retained/asr/bin/python", cache_versions.ASR_PACKAGES),
        ("/retained/asr/bin/python", cache_versions.ALIGNMENT_PACKAGES),
        ("/retained/structure/bin/python", cache_versions.STRUCTURE_PACKAGES),
        ("/retained/structure/bin/python", cache_versions.PITCH_PACKAGES),
    ]
    assert captured.models == expected.models
    assert identities(captured) == identities(expected)
    captured.verify_assets(root)


def test_load_never_probes_runtime(prepared, monkeypatch):
    root, manifest = prepared
    path = root / "producer.json"
    path.write_text(json.dumps(manifest.to_dict()))

    def forbidden(*args, **kwargs):
        raise AssertionError("Loading provenance must not inspect the current runtime")

    for name in (
        "environment_revisions",
        "binary_revision",
        "file_revision",
        "package_revision",
    ):
        monkeypatch.setattr(cache_versions, name, forbidden)
    assert identities(load_manifest(path)) == identities(manifest)


@pytest.mark.parametrize(
    "name,operation,value",
    [
        ("ASR", "recognition", "unknown"),
        ("QWEN_REVISION", "recognition", "main"),
        ("STRUCTURE_REVISION", "structure", "latest"),
    ],
)
def test_unknown_or_mutable_algorithm_provenance_rejected(
    prepared, name, operation, value
):
    _, manifest = prepared
    changed = replace(manifest, versions={**manifest.versions, name: value})
    with pytest.raises(ValueError, match=r"provenance|immutable"):
        changed.digest_for(operation)
    assert changed.digest_for("pitch") == manifest.digest_for("pitch")


def test_capture_rejects_missing_prepared_files_before_probing_runtime(
    tmp_path, monkeypatch
):
    def forbidden(*args, **kwargs):
        raise AssertionError("Invalid inventory should fail before runtime capture")

    monkeypatch.setattr(cache_versions, "environment_revisions", forbidden)
    monkeypatch.setattr(cache_versions, "binary_revision", forbidden)
    with pytest.raises(ValueError, match="Missing capture asset"):
        capture_manifest(
            image_id="explicit-runtime",
            root=tmp_path,
            models={"voice.ckpt": "missing.ckpt"},
            operation_assets={},
            model_assets={},
            asr_python=None,
            structure_python=None,
        )


@pytest.mark.parametrize("directory", [False, True])
def test_in_root_hugging_face_symlinks_are_verified(prepared, directory):
    root, manifest = prepared
    original = root / "alignment/model.pt"
    blobs = root / "blobs"
    blobs.mkdir()
    original.rename(blobs / "model.pt")
    if directory:
        original.parent.rmdir()
        original.parent.symlink_to("blobs", target_is_directory=True)
    else:
        original.symlink_to("../blobs/model.pt")
    manifest.verify_assets(root)
    assert original.is_file()
    (blobs / "model.pt").write_bytes(b"corrupted blob")
    with pytest.raises(ValueError, match="Asset"):
        manifest.verify_assets(root)


def test_dangling_in_root_symlink_is_rejected(prepared):
    root, manifest = prepared
    original = root / "alignment/model.pt"
    original.unlink()
    original.symlink_to("../blobs/absent")
    with pytest.raises(ValueError, match="Missing or unsafe"):
        manifest.verify_assets(root)


def test_capture_resolves_prepared_hugging_face_symlink_bytes(prepared, monkeypatch):
    root, manifest = prepared
    checkpoint = root / "separator/voice.ckpt"
    original = checkpoint.read_bytes()
    blobs = root / "blobs"
    blobs.mkdir()
    checkpoint.rename(blobs / "weights")
    checkpoint.symlink_to("../blobs/weights")
    monkeypatch.setattr(
        cache_versions, "environment_revisions", lambda python, names: installed(names)
    )
    monkeypatch.setattr(
        cache_versions, "binary_revision", lambda name: manifest.separator.ffmpeg
    )
    captured = capture_manifest(
        image_id="explicit-runtime",
        root=root,
        models={"voice.ckpt": "separator/voice.ckpt"},
        operation_assets={},
        model_assets={},
        asr_python=None,
        structure_python=None,
    )
    assert captured.models["voice.ckpt"] == sha(original)
    assert captured.assets == (
        Asset("separator/voice.ckpt", sha(original), len(original)),
    )
    captured.verify_assets(root)
    assert checkpoint.is_symlink()


def write_distribution(python, name, version):
    packages = python.parent.parent / "lib/python3.13/site-packages"
    distribution = packages / f"{name.replace('-', '_')}-fixture.dist-info"
    distribution.mkdir(parents=True, exist_ok=True)
    (distribution / "METADATA").write_text(
        f"Metadata-Version: 2.1\nName: {name}\nVersion: {version}\n"
    )
    cache_versions.environment_revisions.cache_clear()


@pytest.fixture
def local_runtime(prepared, monkeypatch):
    root, manifest = prepared
    asr_python = root / "asr-env/bin/python"
    structure_python = root / "structure-env/bin/python"
    for name in set(cache_versions.ASR_PACKAGES + cache_versions.ALIGNMENT_PACKAGES):
        write_distribution(asr_python, name, "1.2.3")
    for name in set(cache_versions.STRUCTURE_PACKAGES + cache_versions.PITCH_PACKAGES):
        write_distribution(structure_python, name, "1.2.3")
    executable, library = root / "ffmpeg", root / "libdecoder.so"
    executable.write_bytes(b"local executable fingerprint fixture")
    library.write_bytes(b"local shared library fingerprint fixture")
    monkeypatch.setattr(cache_versions.shutil, "which", lambda name: str(executable))
    monkeypatch.setattr(
        cache_versions,
        "_binary_dependencies",
        lambda name: (str(executable), str(library)),
    )
    decoder = cache_versions.binary_revision("ffmpeg")
    monkeypatch.setattr(
        cache_versions, "STRUCTURE_SHA256", manifest.versions["STRUCTURE_SHA256"]
    )
    manifest = replace(
        manifest,
        asr=RuntimeManifest(
            {name: "1.2.3" for name in cache_versions.ASR_PACKAGES},
            decoder,
            alignment_packages={
                name: "1.2.3" for name in cache_versions.ALIGNMENT_PACKAGES
            },
        ),
        structure=RuntimeManifest(
            {name: "1.2.3" for name in cache_versions.STRUCTURE_PACKAGES},
            decoder,
            pitch_packages={name: "1.2.3" for name in cache_versions.PITCH_PACKAGES},
        ),
    )
    return (
        root,
        manifest,
        {"asr_python": str(asr_python), "structure_python": str(structure_python)},
    )


def test_runtime_verification_reads_real_selected_distribution_metadata(local_runtime):
    root, manifest, environments = local_runtime
    for operation in ("recognition", "alignment", "pitch", "structure"):
        verify_runtime(manifest, operation, **environments)
    write_distribution(root / "asr-env/bin/python", "qwen-asr", "2.0")
    with pytest.raises(ValueError, match=r"package mismatch.*qwen-asr"):
        verify_runtime(manifest, "recognition", **environments)
    for operation in ("alignment", "pitch", "structure"):
        verify_runtime(manifest, operation, **environments)


def test_runtime_verification_rejects_missing_selected_package(local_runtime):
    root, manifest, environments = local_runtime
    metadata = (
        root
        / "asr-env/lib/python3.13/site-packages/qwen_asr-fixture.dist-info/METADATA"
    )
    metadata.unlink()
    metadata.parent.rmdir()
    cache_versions.environment_revisions.cache_clear()
    with pytest.raises(ValueError, match=r"package mismatch.*qwen-asr"):
        verify_runtime(manifest, "recognition", **environments)
    verify_runtime(manifest, "structure", **environments)


def test_runtime_verification_compares_current_selected_algorithm(
    local_runtime, monkeypatch
):
    _, manifest, environments = local_runtime
    monkeypatch.setattr(cache_versions, "ASR", "different-current-recognizer")
    with pytest.raises(ValueError, match=r"algorithm mismatch.*ASR"):
        verify_runtime(manifest, "recognition", **environments)
    for operation in ("alignment", "pitch", "structure"):
        verify_runtime(manifest, operation, **environments)


@pytest.mark.parametrize("filename", ["ffmpeg", "libdecoder.so"])
def test_runtime_verification_checks_executable_and_shared_library_bytes(
    local_runtime, filename
):
    root, manifest, environments = local_runtime
    verify_runtime(manifest, "recognition", **environments)
    (root / filename).write_bytes(b"replacement executable or shared library bytes")
    with pytest.raises(ValueError, match="ffmpeg mismatch"):
        verify_runtime(manifest, "recognition", **environments)


def test_runtime_verification_never_hashes_model_assets(local_runtime, monkeypatch):
    root, manifest, environments = local_runtime
    observed = []
    actual_revision = cache_versions.file_revision

    def revision(path):
        observed.append(path)
        return actual_revision(path)

    monkeypatch.setattr(cache_versions, "file_revision", revision)
    verify_runtime(manifest, "recognition", **environments)
    assert observed == [root / "ffmpeg", root / "libdecoder.so"]


@pytest.fixture
def bundled_pitch(prepared, tmp_path_factory):
    root, manifest = prepared
    image_root = tmp_path_factory.mktemp("immutable-image-prefix")
    relative = "lib/python3.13/site-packages/torchcrepe/assets/full.pth"
    packaged = image_root / relative
    packaged.parent.mkdir(parents=True)
    (root / "pitch/full.pth").rename(packaged)
    manifest = replace(
        manifest,
        assets=tuple(
            replace(asset, path=relative, storage="image")
            if asset.path == "pitch/full.pth"
            else asset
            for asset in manifest.assets
        ),
        operation_assets={**manifest.operation_assets, "pitch": (relative,)},
    )
    return root, image_root, relative, manifest


def test_bundled_asset_roundtrip_and_explicit_image_root(bundled_pitch):
    root, image_root, relative, manifest = bundled_pitch
    assert not (root / relative).exists()
    path = root / "producer-with-bundled-pitch.json"
    save_manifest(path, manifest)
    restored = load_manifest(path)
    assert restored.to_dict() == manifest.to_dict()
    restored.verify_assets(root, image_root=image_root)
    assert restored.digest_for("pitch") == manifest.digest_for("pitch")
    with pytest.raises(ValueError, match="trusted image_root"):
        restored.verify_assets(root)


def test_bundled_weight_hash_not_storage_or_image_id_controls_identity(bundled_pitch):
    _, _, relative, manifest = bundled_pitch
    before = identities(manifest)
    relocated = replace(
        manifest,
        image_id="another-image",
        assets=tuple(replace(asset, storage="volume") for asset in manifest.assets),
    )
    assert identities(relocated) == before
    changed = replace(
        manifest,
        assets=tuple(
            replace(asset, sha256=sha(b"different full pitch weights"))
            if asset.path == relative
            else asset
            for asset in manifest.assets
        ),
    )
    after = identities(changed)
    assert {key for key in before if before[key] != after[key]} == {"pitch"}


@pytest.mark.parametrize("failure", ["missing", "corrupt", "escape"])
def test_bundled_asset_integrity_and_prefix_escape_fail_closed(bundled_pitch, failure):
    root, image_root, relative, manifest = bundled_pitch
    packaged = image_root / relative
    if failure == "corrupt":
        packaged.write_bytes(b"x" * packaged.stat().st_size)
    else:
        data = packaged.read_bytes()
        packaged.unlink()
        if failure == "escape":
            outside = root / "outside-image-prefix.pth"
            outside.write_bytes(data)
            packaged.symlink_to(outside)
    with pytest.raises(ValueError, match=r"asset|Asset"):
        manifest.verify_assets(root, image_root=image_root)


def test_capture_bundled_pitch_hashes_actual_image_file_without_copy(
    bundled_pitch, monkeypatch
):
    root, image_root, relative, expected = bundled_pitch
    hashes = []
    actual_revision = cache_versions.file_revision

    def revision(path):
        hashes.append(path)
        return actual_revision(path)

    monkeypatch.setattr(cache_versions, "file_revision", revision)
    monkeypatch.setattr(
        cache_versions, "environment_revisions", lambda python, names: installed(names)
    )
    monkeypatch.setattr(
        cache_versions, "binary_revision", lambda name: expected.structure.ffmpeg
    )
    captured = capture_manifest(
        image_id="explicit-retained-image",
        root=root,
        models={},
        operation_assets={"pitch": (relative,)},
        model_assets={},
        asr_python=None,
        structure_python="/opt/lyrics-structure/bin/python",
        image_assets=(relative,),
        image_root=image_root,
    )
    assert hashes == [image_root / relative]
    assert captured.assets == tuple(
        asset for asset in expected.assets if asset.path == relative
    )
    assert captured.digest_for("pitch") == expected.digest_for("pitch")
    captured.verify_assets(root, image_root=image_root)
    assert not (root / relative).exists()


def test_capture_bundled_asset_requires_explicit_root_and_bound_path(bundled_pitch):
    root, image_root, relative, _ = bundled_pitch
    with pytest.raises(ValueError, match="trusted image_root"):
        capture_manifest(
            image_id="explicit-runtime",
            root=root,
            models={},
            operation_assets={"pitch": (relative,)},
            model_assets={},
            asr_python=None,
            structure_python=None,
            image_assets=(relative,),
        )
    with pytest.raises(ValueError, match="bound"):
        capture_manifest(
            image_id="explicit-runtime",
            root=root,
            models={},
            operation_assets={},
            model_assets={},
            asr_python=None,
            structure_python=None,
            image_assets=(relative,),
            image_root=image_root,
        )


def test_asset_storage_schema_rejects_arbitrary_locations():
    for storage in ("host", "/opt/lyrics-structure", "../image"):
        with pytest.raises(ValueError, match="storage"):
            Asset(
                "weights.pth",
                sha(b"weights"),
                7,
                storage=cast(Literal["volume", "image"], storage),
            )
    with pytest.raises(ValueError, match="Unsafe"):
        Asset("/opt/lyrics-structure/weights.pth", sha(b"weights"), 7, storage="image")


def test_alignment_identity_reuses_identical_pcm_after_decoder_change(prepared):
    _, manifest = prepared
    changed = replace(
        manifest, asr=replace(manifest.asr, ffmpeg=sha(b"updated decoder libraries"))
    )
    before, after = identities(manifest), identities(changed)
    assert {key for key in before if before[key] != after[key]} == {"recognition"}
    assert "ffmpeg" not in manifest.operation_identity("alignment")
    pcm = sha(b"\x00\x00\x01\x00\x02\x00")
    context = {"raw_chunks": [{"text": "actual words"}], "reference": "actual words"}
    original_key = cache_key(manifest.operation_identity("alignment"), pcm, context)
    assert (
        cache_key(changed.operation_identity("alignment"), pcm, context) == original_key
    )
    assert (
        cache_key(
            changed.operation_identity("alignment"), sha(b"\x01\x00\x03\x00"), context
        )
        != original_key
    )


def test_alignment_runtime_still_rejects_decoder_mismatch(local_runtime):
    root, manifest, environments = local_runtime
    verify_runtime(manifest, "alignment", **environments)
    (root / "libdecoder.so").write_bytes(b"different alignment admission decoder bytes")
    with pytest.raises(ValueError, match="ffmpeg mismatch"):
        verify_runtime(manifest, "alignment", **environments)
