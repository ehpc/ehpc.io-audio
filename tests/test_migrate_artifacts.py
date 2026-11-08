"""Real local-byte administrative migration; no network or GPU execution."""

import hashlib
import json
import os
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest

from separator import cache_versions
from separator.migrate_artifacts import migrate_artifacts
from separator.producer_manifest import (
    SEPARATOR_PACKAGES,
    Asset,
    ProducerManifest,
    RuntimeManifest,
    save_manifest,
)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def artifact_path(directory, seed):
    extension = "json" if directory == "lyrics-references" else "bin"
    return f"{directory}/{sha(seed.encode())}.{extension}"


@pytest.fixture
def source(tmp_path):
    remote = tmp_path / "read-only-volume"
    directories = (
        "stems/versioned/outputs",
        "analysis-results/lyrics",
        "analysis-results/pitch",
        "analysis-results/structure",
        "qwen-asr/results/recognition",
        "qwen-asr/results/recognition-alignment",
        "lyrics-references",
    )
    inventory = {}
    paths = []
    for index, directory in enumerate(directories):
        relative = artifact_path(directory, directory)
        path = remote / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        data = (
            b'{ "record": {"plain_lyrics": "original reference bytes"}, '
            b'"fetched_at": "2026-01-01" }\n'
            if directory == "lyrics-references"
            else bytes(range(256)) * (index + 1)
        )
        path.write_bytes(data)
        inventory[relative] = {"type": "file", "size": len(data), "sha256": sha(data)}
        paths.append(relative)
    (remote / "model.ckpt").write_bytes(b"weights must never be imported")
    inventory["model.ckpt"] = {
        "type": "file",
        "size": 29,
        "sha256": sha(b"weights must never be imported"),
    }

    class LocalVolume:
        def __init__(self):
            self.reads = []
            self.guard = threading.Lock()

        def read_file(self, relative):
            with self.guard:
                self.reads.append(relative)
            with (remote / relative).open("rb") as handle:
                while chunk := handle.read(19):
                    yield chunk

    return remote, inventory, paths, LocalVolume(), tmp_path / "vps-artifacts"


def forbidden(*args, **kwargs):
    raise AssertionError("An already exact artifact was streamed again")


def test_all_supported_completed_paths_preserve_bytes_and_skip_exact_repeat(
    source, monkeypatch
):
    remote, inventory, paths, volume, destination = source
    result = migrate_artifacts(volume, inventory, destination, paths)
    assert result == {
        "imported": paths,
        "already_present": [],
        "legacy_producer_attested": False,
    }
    assert volume.reads == paths
    for relative in paths:
        assert (destination / relative).read_bytes() == (remote / relative).read_bytes()
    assert not (destination / "model.ckpt").exists()
    assert not (destination / "legacy-producer-manifest.json").exists()
    assert not (destination / "recognition-info").exists()
    assert not list(destination.rglob(".pending-migration-*"))
    monkeypatch.setattr(volume, "read_file", forbidden)
    repeated = migrate_artifacts(volume, inventory, destination, paths)
    assert repeated == {
        "imported": [],
        "already_present": paths,
        "legacy_producer_attested": False,
    }


def test_concurrent_migration_reads_each_selected_file_once(source):
    remote, inventory, paths, volume, destination = source
    selected = paths[:2]
    barrier = threading.Barrier(4)

    def migrate(_):
        barrier.wait()
        return migrate_artifacts(volume, inventory, destination, selected)

    with ThreadPoolExecutor(max_workers=4) as workers:
        results = list(workers.map(migrate, range(4)))
    assert sorted(volume.reads) == sorted(selected)
    assert sum(len(result["imported"]) for result in results) == len(selected)
    for relative in selected:
        assert (destination / relative).read_bytes() == (remote / relative).read_bytes()


@pytest.mark.parametrize(
    "failure", ["truncated", "corrupt", "oversized", "interrupted"]
)
def test_failed_stream_leaves_no_artifact_or_partial_file(source, monkeypatch, failure):
    remote, inventory, paths, volume, destination = source
    relative = paths[0]
    original = (remote / relative).read_bytes()

    def failed_stream(path):
        assert path == relative
        if failure == "truncated":
            yield original[:-1]
        elif failure == "corrupt":
            yield b"x" * len(original)
        elif failure == "oversized":
            yield original
            yield b"extra"
        else:
            yield original[:19]
            raise OSError("interrupted local transport fixture")

    monkeypatch.setattr(volume, "read_file", failed_stream)
    with pytest.raises((ValueError, OSError)):
        migrate_artifacts(volume, inventory, destination, [relative])
    assert not (destination / relative).exists()
    assert not list(destination.rglob(".pending-migration-*"))
    assert not (destination / "legacy-producer-manifest.json").exists()


@pytest.mark.parametrize(
    "relative",
    [
        "../escape.bin",
        "/absolute.bin",
        "stems/../escape.bin",
        "stems//file.bin",
        "stems/versioned/outputs/../escape.bin",
        "stems\\versioned\\file.bin",
        "model.ckpt",
        "stems/old-unversioned.bin",
        "analysis-results/key/file.bin",
        "lyrics-references/not-a-digest.json",
        "legacy-producer-manifest.json",
        "recognition-info/" + "a" * 64 + ".json",
        "stems/versioned/outputs/" + "a" * 64 + ".lock",
        "stems/versioned/outputs/.pending-incomplete.bin",
    ],
)
def test_traversal_and_out_of_scope_selections_rejected_before_io(
    source, monkeypatch, relative
):
    _, inventory, _, volume, destination = source
    inventory[relative] = {"type": "file", "size": 1, "sha256": sha(b"x")}
    monkeypatch.setattr(volume, "read_file", forbidden)
    with pytest.raises(ValueError):
        migrate_artifacts(volume, inventory, destination, [relative])
    assert not destination.exists()


@pytest.mark.parametrize(
    "record",
    [
        {"type": "symlink", "size": 1, "sha256": sha(b"x")},
        {"type": "directory", "size": 1, "sha256": sha(b"x")},
        {"type": "file", "size": True, "sha256": sha(b"x")},
        {"type": "file", "size": -1, "sha256": sha(b"x")},
        {"type": "file", "size": 1, "sha256": "unknown"},
        {"type": "file", "size": 1},
    ],
)
def test_invalid_selected_inventory_prevents_any_publication(
    source, monkeypatch, record
):
    _, inventory, paths, volume, destination = source
    inventory[paths[1]] = record
    monkeypatch.setattr(volume, "read_file", forbidden)
    with pytest.raises(ValueError):
        migrate_artifacts(volume, inventory, destination, paths[:2])
    assert not destination.exists()


def test_local_conflict_is_preserved_and_detected_before_other_imports(
    source, monkeypatch
):
    _, inventory, paths, volume, destination = source
    conflict = destination / paths[1]
    conflict.parent.mkdir(parents=True)
    conflict.write_bytes(b"user-owned conflicting output")
    monkeypatch.setattr(volume, "read_file", forbidden)
    with pytest.raises(ValueError, match="Conflicting"):
        migrate_artifacts(volume, inventory, destination, paths[:2])
    assert conflict.read_bytes() == b"user-owned conflicting output"
    assert not (destination / paths[0]).exists()


def test_same_size_and_mtime_do_not_hide_local_corruption(source, monkeypatch):
    _, inventory, paths, volume, destination = source
    migrate_artifacts(volume, inventory, destination, paths[:1])
    local = destination / paths[0]
    before = local.stat()
    local.write_bytes(b"x" * before.st_size)
    os.utime(local, ns=(before.st_atime_ns, before.st_mtime_ns))
    monkeypatch.setattr(volume, "read_file", forbidden)
    with pytest.raises(ValueError, match="Conflicting"):
        migrate_artifacts(volume, inventory, destination, paths[:1])
    assert local.read_bytes() == b"x" * before.st_size


@pytest.mark.parametrize("directory", [False, True])
def test_destination_symlinks_never_escape_or_overwrite_user_files(
    source, monkeypatch, directory
):
    _, inventory, paths, volume, destination = source
    outside = destination.parent / "outside"
    outside.mkdir()
    destination.mkdir()
    if directory:
        (destination / "stems").symlink_to(outside, target_is_directory=True)
    else:
        local = destination / paths[0]
        local.parent.mkdir(parents=True)
        target = outside / "user-file"
        target.write_bytes(b"preserve me")
        local.symlink_to(target)
    monkeypatch.setattr(volume, "read_file", forbidden)
    with pytest.raises(ValueError, match="symlink"):
        migrate_artifacts(volume, inventory, destination, paths[:1])
    if not directory:
        assert target.read_bytes() == b"preserve me"


def test_file_created_during_stream_is_not_overwritten(source, monkeypatch):
    remote, inventory, paths, volume, destination = source
    relative = paths[0]
    local = destination / relative

    def race(path):
        data = (remote / path).read_bytes()
        yield data[:19]
        local.write_bytes(b"new user file created during import")
        yield data[19:]

    monkeypatch.setattr(volume, "read_file", race)
    with pytest.raises(ValueError, match="Conflicting"):
        migrate_artifacts(volume, inventory, destination, [relative])
    assert local.read_bytes() == b"new user file created during import"
    assert not list(destination.rglob(".pending-migration-*"))


@pytest.fixture
def gpu_evidence(tmp_path):
    definitions = {
        "voice.ckpt": b"actual local separator fixture",
        "recognition/weights": b"actual local ASR fixture",
        "alignment/weights": b"actual local alignment fixture",
        "pitch/weights": b"actual local pitch fixture",
        "structure/weights": b"actual local structure fixture",
    }
    assets = tuple(
        Asset(path, sha(data), len(data)) for path, data in definitions.items()
    )
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
    versions["STRUCTURE_SHA256"] = sha(definitions["structure/weights"])
    decoder = sha(b"captured fixture decoder")
    manifest = ProducerManifest(
        image_id="im-synthetic-test-producer",
        separator=RuntimeManifest(
            {name: "1.2.3" for name in SEPARATOR_PACKAGES}, decoder
        ),
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
        versions=versions,
        models={"voice.ckpt": sha(definitions["voice.ckpt"])},
        assets=assets,
        operation_assets={
            operation: (f"{operation}/weights",)
            for operation in ("recognition", "alignment", "pitch", "structure")
        },
        model_assets={"voice.ckpt": ("voice.ckpt",)},
    )
    manifest_path = tmp_path / "producer.json"
    save_manifest(manifest_path, manifest)
    receipt_path = tmp_path / "verified-gpu-receipt.json"
    # Synthetic test evidence is never used as operator/runtime provenance.
    evidence = {
        "producer_manifest_sha256": sha(manifest_path.read_bytes()),
        "operations": [
            {
                "operation": operation,
                "status": "succeeded",
                "call_id": f"fc-Fixture{index}",
                "producer_digest": manifest.digest_for(
                    operation, "voice.ckpt" if operation == "separation" else None
                ),
                **({"model": "voice.ckpt"} if operation == "separation" else {}),
            }
            for index, operation in enumerate(
                ("separation", "recognition", "alignment", "pitch", "structure")
            )
        ],
    }
    receipt_path.write_text(json.dumps(evidence))
    return manifest_path, receipt_path, evidence


def test_exact_all_family_gpu_receipt_can_attest_previously_opaque_import(
    source, gpu_evidence, monkeypatch
):
    _, inventory, paths, volume, destination = source
    manifest_path, receipt_path, _ = gpu_evidence
    migrate_artifacts(volume, inventory, destination, paths)
    assert not (destination / "legacy-producer-manifest.json").exists()
    monkeypatch.setattr(volume, "read_file", forbidden)
    result = migrate_artifacts(
        volume,
        inventory,
        destination,
        paths,
        producer_manifest=manifest_path,
        verified_gpu_receipt=receipt_path,
    )
    assert result["legacy_producer_attested"] is True
    assert result["already_present"] == paths
    assert (
        destination / "legacy-producer-manifest.json"
    ).read_bytes() == manifest_path.read_bytes()
    assert not (destination / "recognition-info").exists()


@pytest.mark.parametrize("missing", ["manifest", "receipt"])
def test_gpu_evidence_pair_is_required_without_publishing_alias(
    source, gpu_evidence, monkeypatch, missing
):
    _, inventory, paths, volume, destination = source
    manifest_path, receipt_path, _ = gpu_evidence
    arguments = (
        {"producer_manifest": manifest_path}
        if missing == "receipt"
        else {"verified_gpu_receipt": receipt_path}
    )
    monkeypatch.setattr(volume, "read_file", forbidden)
    with pytest.raises(ValueError, match="together"):
        migrate_artifacts(volume, inventory, destination, paths, **arguments)
    assert not destination.exists()


@pytest.mark.parametrize(
    "failure",
    [
        "manifest-sha",
        "operation-digest",
        "missing-family",
        "failed-call",
        "missing-call-id",
        "reused-call-id",
        "wrong-model",
        "cpu-only",
    ],
)
def test_incomplete_or_mismatched_gpu_evidence_never_publishes_alias(
    source, gpu_evidence, monkeypatch, failure
):
    _, inventory, paths, volume, destination = source
    manifest_path, receipt_path, evidence = gpu_evidence
    if failure == "manifest-sha":
        evidence["producer_manifest_sha256"] = sha(b"different producer file")
    elif failure == "operation-digest":
        evidence["operations"][-1]["producer_digest"] = sha(
            b"different structure producer"
        )
    elif failure == "missing-family":
        evidence["operations"].pop()
    elif failure == "failed-call":
        evidence["operations"][-1]["status"] = "failed"
    elif failure == "missing-call-id":
        evidence["operations"][-1].pop("call_id")
    elif failure == "reused-call-id":
        evidence["operations"][-1]["call_id"] = evidence["operations"][0]["call_id"]
    elif failure == "wrong-model":
        evidence["operations"][0]["model"] = "unverified.ckpt"
    else:
        evidence = {
            "complete": True,
            "image_id": "im-synthetic-test-producer",
            "fingerprint_source_sha256": sha(b"CPU-only asset inspection"),
            "native_gpu_identity": "UNVERIFIED",
            "assets": [],
        }
    receipt_path.write_text(json.dumps(evidence))
    monkeypatch.setattr(volume, "read_file", forbidden)
    with pytest.raises(ValueError):
        migrate_artifacts(
            volume,
            inventory,
            destination,
            paths,
            producer_manifest=manifest_path,
            verified_gpu_receipt=receipt_path,
        )
    assert not destination.exists()


def test_existing_conflicting_producer_alias_is_never_replaced(
    source, gpu_evidence, monkeypatch
):
    _, inventory, paths, volume, destination = source
    manifest_path, receipt_path, _ = gpu_evidence
    destination.mkdir()
    alias = destination / "legacy-producer-manifest.json"
    alias.write_bytes(b"existing user provenance")
    monkeypatch.setattr(volume, "read_file", forbidden)
    with pytest.raises(ValueError, match="Conflicting"):
        migrate_artifacts(
            volume,
            inventory,
            destination,
            paths,
            producer_manifest=manifest_path,
            verified_gpu_receipt=receipt_path,
        )
    assert alias.read_bytes() == b"existing user provenance"


def test_valid_gpu_evidence_cannot_publish_alias_after_failed_import(
    source, gpu_evidence, monkeypatch
):
    remote, inventory, paths, volume, destination = source
    manifest_path, receipt_path, _ = gpu_evidence

    def truncated(relative):
        yield (remote / relative).read_bytes()[:-1]

    monkeypatch.setattr(volume, "read_file", truncated)
    with pytest.raises(ValueError, match="integrity"):
        migrate_artifacts(
            volume,
            inventory,
            destination,
            paths[:1],
            producer_manifest=manifest_path,
            verified_gpu_receipt=receipt_path,
        )
    assert not (destination / paths[0]).exists()
    assert not (destination / "legacy-producer-manifest.json").exists()
    assert not list(destination.rglob(".pending-migration-*"))
