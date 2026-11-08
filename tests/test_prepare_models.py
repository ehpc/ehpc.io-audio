"""Local-byte preparation receipts; no network, Modal compute, or model inference."""

import hashlib
import json
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, replace

import pytest

from separator import cache_versions, prepare_models
from separator.artifact_cache import cache_key, cached_bytes
from separator.inference import InferenceRequest
from separator.producer_manifest import (
    SEPARATOR_PACKAGES,
    Asset,
    ProducerManifest,
    RuntimeManifest,
)


def sha(data):
    return hashlib.sha256(data).hexdigest()


@pytest.fixture
def prepared(tmp_path, monkeypatch):
    files = tmp_path / "immutable-volume"
    files.mkdir()
    contents = {
        "voice.ckpt": b"actual local selected weight fixture" * 23,
        "drums.ckpt": b"actual local unselected weight fixture" * 19,
        "common/config.json": b'{"layout":"shared separator configuration"}',
        "download_checks.json": b'{"voice.ckpt":"offline registry entry"}',
    }
    assets = []
    for name, data in contents.items():
        path = files / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        assets.append(Asset(name, sha(data), len(data)))
    image_path = tmp_path / "immutable-image/lib/torchcrepe/assets/full.pth"
    image_path.parent.mkdir(parents=True)
    image_path.write_bytes(b"actual local bundled pitch fixture")
    assets.append(
        Asset(
            "lib/torchcrepe/assets/full.pth",
            sha(image_path.read_bytes()),
            image_path.stat().st_size,
            "image",
        )
    )
    decoder = sha(b"captured decoder fixture")
    manifest = ProducerManifest(
        image_id="im-exact-fixture",
        separator=RuntimeManifest(
            {name: "1.2.3" for name in SEPARATOR_PACKAGES}, decoder
        ),
        asr=RuntimeManifest({}, None),
        structure=RuntimeManifest(
            {},
            decoder,
            pitch_packages={name: "1.2.3" for name in cache_versions.PITCH_PACKAGES},
        ),
        versions={
            "STEM": cache_versions.STEM,
            "PITCH": cache_versions.PITCH,
            "ASR_SAMPLE_RATE": cache_versions.ASR_SAMPLE_RATE,
        },
        models={name: sha(contents[name]) for name in ("voice.ckpt", "drums.ckpt")},
        assets=tuple(assets),
        operation_assets={
            "separation": ("common/config.json",),
            "pitch": ("lib/torchcrepe/assets/full.pth",),
        },
        model_assets={"voice.ckpt": ("voice.ckpt",), "drums.ckpt": ("drums.ckpt",)},
    )

    class LocalVolume:
        object_id = "vo-immutable-fixture"

        def __init__(self):
            self.reads = []
            self.guard = threading.Lock()

        def hydrate(self):
            pass

        def read_file(self, path):
            with self.guard:
                self.reads.append(path)
            with (files / path).open("rb") as handle:
                while chunk := handle.read(7):
                    yield chunk

    volume = LocalVolume()

    def from_name(name, *, environment_name):
        assert name == "prepared-weights"
        assert environment_name == "fixture-environment"
        return volume

    monkeypatch.setattr(prepare_models.modal.Volume, "from_name", from_name)
    return tmp_path, files, manifest, volume


def request(manifest, operation="separation", model="voice.ckpt"):
    if operation != "separation":
        model = None
    return InferenceRequest(
        operation,
        b"local input bytes",
        "input.wav",
        manifest.digest_for(operation, model),
        {"model": model} if model is not None else {},
    )


def ensure(manifest, root, operation="separation", model="voice.ckpt"):
    prepare_models.ensure_prepared(
        manifest,
        request(manifest, operation, model),
        root,
        "prepared-weights",
        "fixture-environment",
    )


def receipt(manifest, volume):
    return {
        "complete": True,
        "image_id": manifest.image_id,
        "volume_id": volume.object_id,
        "fingerprint_source_sha256": sha(b"actual fixture inspection implementation"),
        "assets": [
            asdict(asset) for asset in manifest.assets if asset.storage == "volume"
        ],
        "image_assets": [
            asdict(asset) for asset in manifest.assets if asset.storage == "image"
        ],
        "recognition_info": {},
    }


def marker(root, owner, asset):
    return root / "prepared-models" / f"{cache_key(owner, asdict(asset))}.json"


def forbidden(*args, **kwargs):
    raise AssertionError("A prepared immutable weight was streamed again")


def test_concurrent_cold_private_namespaces_share_one_real_weight_stream(
    prepared, monkeypatch
):
    tmp_path, files, manifest, volume = prepared
    shared = tmp_path / "shared-receipts"
    barrier = threading.Barrier(4)

    def consume(index):
        private = tmp_path / f"private-computed-{index}"
        barrier.wait()
        ensure(manifest, shared)
        return cached_bytes(
            private,
            "local-checksum",
            lambda: sha((files / "voice.ckpt").read_bytes()).encode(),
        )

    with ThreadPoolExecutor(max_workers=4) as workers:
        outputs = list(workers.map(consume, range(4)))
    assert len(set(outputs)) == 1
    assert sorted(volume.reads) == [
        "common/config.json",
        "download_checks.json",
        "voice.ckpt",
    ]
    assert len(list((shared / "prepared-models").glob("*.json"))) == 3
    monkeypatch.setattr(volume, "read_file", forbidden)
    for index in range(4, 8):
        private = tmp_path / f"private-computed-{index}"
        ensure(manifest, shared)
        assert (
            cached_bytes(
                private,
                "local-checksum",
                lambda: sha((files / "voice.ckpt").read_bytes()).encode(),
            )
            == outputs[0]
        )
    assert not list(tmp_path.glob("private-computed-*/prepared-models"))


def test_selected_model_common_assets_and_offline_registry_only(prepared):
    tmp_path, _, manifest, volume = prepared
    shared = tmp_path / "shared-receipts"
    ensure(manifest, shared)
    assert set(volume.reads) == {
        "voice.ckpt",
        "common/config.json",
        "download_checks.json",
    }
    ensure(manifest, shared, model="drums.ckpt")
    assert volume.reads.count("common/config.json") == 1
    assert volume.reads.count("download_checks.json") == 1
    assert volume.reads.count("drums.ckpt") == 1
    assert "lib/torchcrepe/assets/full.pth" not in volume.reads


def test_catalog_update_requires_new_receipt_without_model_identity_churn(prepared):
    tmp_path, files, manifest, volume = prepared
    shared = tmp_path / "shared-receipts"
    ensure(manifest, shared)
    catalog = files / "download_checks.json"
    catalog.write_bytes(b'{"voice.ckpt":"same", "new-model.ckpt":"unrelated"}')
    updated = replace(
        manifest,
        assets=tuple(
            replace(
                asset,
                sha256=sha(catalog.read_bytes()),
                size_bytes=catalog.stat().st_size,
            )
            if asset.path == "download_checks.json"
            else asset
            for asset in manifest.assets
        ),
    )
    assert updated.digest_for("separation", "voice.ckpt") == manifest.digest_for(
        "separation", "voice.ckpt"
    )
    ensure(updated, shared)
    assert volume.reads.count("download_checks.json") == 2
    assert volume.reads.count("voice.ckpt") == 1
    assert volume.reads.count("common/config.json") == 1


@pytest.mark.parametrize("mutation", ["corrupt", "truncated", "missing"])
def test_bad_stream_never_publishes_its_preparation_receipt(prepared, mutation):
    tmp_path, files, manifest, volume = prepared
    shared = tmp_path / "shared-receipts"
    path = files / "voice.ckpt"
    if mutation == "missing":
        path.unlink()
    elif mutation == "truncated":
        path.write_bytes(b"partial")
    else:
        path.write_bytes(b"x" * path.stat().st_size)
    with pytest.raises((ValueError, FileNotFoundError)):
        ensure(manifest, shared)
    selected = next(asset for asset in manifest.assets if asset.path == "voice.ckpt")
    assert not marker(shared, volume.object_id, selected).exists()


@pytest.mark.parametrize(
    "contents", [b'{"owner":', b"{}", b'{"owner":"different","asset":{}}']
)
def test_corrupt_existing_marker_fails_closed_without_restream(
    prepared, monkeypatch, contents
):
    tmp_path, _, manifest, volume = prepared
    shared = tmp_path / "shared-receipts"
    ensure(manifest, shared)
    selected = next(asset for asset in manifest.assets if asset.path == "voice.ckpt")
    marker(shared, volume.object_id, selected).write_bytes(contents)
    monkeypatch.setattr(volume, "read_file", forbidden)
    with pytest.raises(ValueError):
        ensure(manifest, shared)


def test_bundled_asset_requires_matching_exact_image_receipt(prepared, monkeypatch):
    tmp_path, _, manifest, volume = prepared
    shared = tmp_path / "shared-receipts"
    monkeypatch.setattr(volume, "read_file", forbidden)
    with pytest.raises(RuntimeError, match="exact-image inspection"):
        ensure(manifest, shared, operation="pitch")
    prepare_models.import_inspection(
        manifest, receipt(manifest, volume), shared, volume.object_id
    )
    ensure(manifest, shared, operation="pitch")
    different_image = replace(manifest, image_id="im-different-fixture")
    assert different_image.digest_for("pitch") == manifest.digest_for("pitch")
    with pytest.raises(RuntimeError, match="exact-image inspection"):
        ensure(different_image, shared, operation="pitch")
    assert not (shared / "legacy-producer-manifest.json").exists()


def recognition_metadata():
    return {
        "baseline_exists": True,
        "duration_s": 1.0,
        "pcm_identity": [
            cache_versions.ASR_SAMPLE_RATE,
            "f",
            [cache_versions.ASR_SAMPLE_RATE],
            sha(b"decoded float32 fixture"),
        ],
    }


def test_full_inspection_publishes_only_validated_shared_receipts_and_metadata(
    prepared, monkeypatch
):
    tmp_path, _, manifest, volume = prepared
    shared = tmp_path / "shared-receipts"
    inspected = receipt(manifest, volume)
    key = sha(b"legacy recognition key fixture")
    skipped = sha(b"no available baseline")
    inspected["recognition_info"] = {
        key: recognition_metadata(),
        skipped: {"baseline_exists": False},
    }
    prepare_models.import_inspection(manifest, inspected, shared, volume.object_id)
    assert len(list((shared / "prepared-models").glob("*.json"))) == len(
        manifest.assets
    )
    assert (
        json.loads((shared / "recognition-info" / f"{key}.json").read_text())
        == recognition_metadata()
    )
    assert not (shared / "recognition-info" / f"{skipped}.json").exists()
    assert not (shared / "legacy-producer-manifest.json").exists()
    monkeypatch.setattr(volume, "read_file", forbidden)
    ensure(manifest, shared)
    ensure(manifest, shared, operation="pitch")


@pytest.mark.parametrize(
    "failure",
    [
        "partial",
        "wrong-image",
        "wrong-volume",
        "bad-fingerprint",
        "missing-asset",
        "corrupt-asset",
        "duplicate-asset",
        "missing-image-asset",
        "invalid-key",
        "invalid-duration",
        "invalid-pcm",
        "duration-mismatch",
        "invalid-baseline",
        "nonfinite-extra",
    ],
)
def test_invalid_inspection_publishes_nothing_even_with_earlier_valid_entries(
    prepared, failure
):
    tmp_path, _, manifest, volume = prepared
    shared = tmp_path / "shared-receipts"
    inspected = receipt(manifest, volume)
    first_key, bad_key = sha(b"first valid metadata"), sha(b"later invalid metadata")
    inspected["recognition_info"] = {
        first_key: recognition_metadata(),
        bad_key: recognition_metadata(),
    }
    if failure == "partial":
        inspected["complete"] = False
    elif failure == "wrong-image":
        inspected["image_id"] = "im-other"
    elif failure == "wrong-volume":
        inspected["volume_id"] = "vo-other"
    elif failure == "bad-fingerprint":
        inspected["fingerprint_source_sha256"] = "unknown"
    elif failure == "missing-asset":
        inspected["assets"].pop()
    elif failure == "corrupt-asset":
        inspected["assets"][-1]["sha256"] = sha(b"different bytes")
    elif failure == "duplicate-asset":
        inspected["assets"].append(inspected["assets"][0])
    elif failure == "missing-image-asset":
        inspected["image_assets"] = []
    elif failure == "invalid-key":
        inspected["recognition_info"]["../escape"] = recognition_metadata()
    elif failure == "invalid-duration":
        inspected["recognition_info"][bad_key]["duration_s"] = float("nan")
    elif failure == "invalid-pcm":
        inspected["recognition_info"][bad_key]["pcm_identity"][-1] = "not-a-hash"
    elif failure == "duration-mismatch":
        inspected["recognition_info"][bad_key]["duration_s"] = 3.0
    elif failure == "invalid-baseline":
        inspected["recognition_info"][bad_key]["baseline_exists"] = "true"
    else:
        inspected["recognition_info"][bad_key]["untrusted_extra"] = float("inf")
    with pytest.raises(ValueError):
        prepare_models.import_inspection(manifest, inspected, shared, volume.object_id)
    assert not shared.exists()


def test_invalid_request_cannot_start_preparation_stream(prepared, monkeypatch):
    tmp_path, _, manifest, volume = prepared
    monkeypatch.setattr(volume, "read_file", forbidden)
    wrong = replace(request(manifest), producer_digest=sha(b"wrong producer"))
    with pytest.raises(ValueError, match="producer"):
        prepare_models.ensure_prepared(
            manifest,
            wrong,
            tmp_path / "shared-receipts",
            "prepared-weights",
            "fixture-environment",
        )
