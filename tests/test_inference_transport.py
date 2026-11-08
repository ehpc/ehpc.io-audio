"""Exercise private transport with real files, streamed bytes, and CPU audio."""

import hashlib
import importlib
import io
import json
import pickle
import shutil
import struct
import subprocess
import wave
from dataclasses import replace
from pathlib import Path

import pytest
from audio_samples import mp3_measurements, tone_wav
from transport_fixture import LocalVolume, produce_result

from backend import modal_client
from separator import inference_transport as transport
from separator.inference import InferenceRequest

OUTPUT_ID = "0123456789abcdef" * 2
OTHER_ID = "fedcba9876543210" * 2


@pytest.fixture
def request_audio() -> InferenceRequest:
    return InferenceRequest(
        operation="separation",
        audio_bytes=tone_wav((440.0,), duration_s=0.2),
        filename="source.wav",
        producer_digest="a" * 64,
        parameters={"gain": 0.5},
    )


@pytest.fixture
def volume(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> LocalVolume:
    local = LocalVolume(tmp_path / "private-volume", chunk_size=65521)
    monkeypatch.setattr(modal_client, "_get_transport_volume", lambda: local)
    return local


def publish_bytes(
    root: Path,
    output_id: str,
    request: InferenceRequest,
    data: bytes,
    *,
    failed: bool = False,
) -> None:
    source = root.parent / f"{output_id}-producer.bin"
    source.write_bytes(data)
    transport.publish_file(root, output_id, request, source, failed=failed)


@pytest.mark.parametrize(
    "damage", ["changed", "truncated", "metadata", "size", "boolean-size"]
)
def test_staged_input_integrity_is_checked(
    tmp_path: Path, request_audio: InferenceRequest, damage: str
) -> None:
    transport.write_request(tmp_path, OUTPUT_ID, request_audio)
    directory = tmp_path / OUTPUT_ID
    if damage in {"changed", "truncated"}:
        data = request_audio.audio_bytes
        corrupted = (
            bytes([data[0] ^ 1]) + data[1:] if damage == "changed" else data[:-1]
        )
        (directory / "input.bin").write_bytes(corrupted)
    else:
        path = directory / "request.json"
        metadata = json.loads(path.read_bytes())
        if damage == "metadata":
            metadata["request"]["parameters"]["gain"] = 0.25
        else:
            metadata["audio_size"] = (
                True if damage == "boolean-size" else len(request_audio.audio_bytes) + 1
            )
        path.write_text(json.dumps(metadata))
    with pytest.raises(ValueError):
        transport.load_request(tmp_path, OUTPUT_ID)


@pytest.mark.parametrize(
    "output_id",
    [
        "../escape",
        "/tmp/escape",
        "a" * 31,
        "a" * 33,
        "A" * 32,
        "g" * 32,
        "a" * 31 + "\x00",
        "",
    ],
)
def test_invalid_transfer_tokens_cannot_read_or_write(
    tmp_path: Path, request_audio: InferenceRequest, output_id: str
) -> None:
    root = tmp_path / "volume"
    root.mkdir()
    source = tmp_path / "producer.bin"
    source.write_bytes(b"producer data")
    with pytest.raises(ValueError):
        transport.write_request(root, output_id, request_audio)
    with pytest.raises(ValueError):
        transport.load_request(root, output_id)
    with pytest.raises(ValueError):
        transport.publish_file(root, output_id, request_audio, source)
    assert not list(root.iterdir())
    assert source.read_bytes() == b"producer data"


def test_transfer_directory_symlink_cannot_cross_request_boundary(
    tmp_path: Path, request_audio: InferenceRequest
) -> None:
    root = tmp_path / "volume"
    root.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    sentinel = outside / "input.bin"
    sentinel.write_bytes(b"private unrelated contents")
    (root / OUTPUT_ID).symlink_to(outside, target_is_directory=True)
    with pytest.raises(ValueError):
        transport.write_request(root, OUTPUT_ID, request_audio)
    with pytest.raises(ValueError):
        transport.load_request(root, OUTPUT_ID)
    with pytest.raises(ValueError):
        transport.publish_file(root, OUTPUT_ID, request_audio, sentinel)
    assert sentinel.read_bytes() == b"private unrelated contents"
    assert sorted(path.name for path in outside.iterdir()) == ["input.bin"]


@pytest.mark.parametrize("filename", ["input.bin", "request.json"])
def test_staged_request_file_symlinks_are_rejected(
    tmp_path: Path, request_audio: InferenceRequest, filename: str
) -> None:
    root = tmp_path / "volume"
    transport.write_request(root, OUTPUT_ID, request_audio)
    target = root / OUTPUT_ID / filename
    outside = tmp_path / "outside.bin"
    outside.write_bytes(target.read_bytes())
    before = outside.read_bytes()
    target.unlink()
    target.symlink_to(outside)
    with pytest.raises(ValueError):
        transport.load_request(root, OUTPUT_ID)
    with pytest.raises(ValueError):
        transport.write_request(root, OUTPUT_ID, request_audio)
    assert outside.read_bytes() == before


@pytest.mark.parametrize(
    "filename", ["result.bin", "completion.json", "diagnostics.log"]
)
def test_completion_file_symlinks_are_rejected(
    tmp_path: Path, request_audio: InferenceRequest, filename: str
) -> None:
    root = tmp_path / "volume"
    directory = root / OUTPUT_ID
    directory.mkdir(parents=True)
    outside = tmp_path / "outside.bin"
    outside.write_bytes(b"unrelated private data")
    (directory / filename).symlink_to(outside)
    with pytest.raises(ValueError):
        transport.publish_file(
            root,
            OUTPUT_ID,
            request_audio,
            outside,
            failed=filename == "diagnostics.log",
        )
    assert outside.read_bytes() == b"unrelated private data"


@pytest.mark.parametrize(
    "filename",
    ["../outside.wav", "/outside.wav", "nested/source.wav", "nested\\source.wav"],
)
def test_staged_filename_cannot_escape_request_directory(
    tmp_path: Path, request_audio: InferenceRequest, filename: str
) -> None:
    transport.write_request(tmp_path, OUTPUT_ID, request_audio)
    path = tmp_path / OUTPUT_ID / "request.json"
    metadata = json.loads(path.read_bytes())
    metadata["request"]["filename"] = filename
    path.write_text(json.dumps(metadata))
    with pytest.raises(ValueError):
        transport.load_request(tmp_path, OUTPUT_ID)


def test_completion_is_published_only_after_complete_payload(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, request_audio: InferenceRequest
) -> None:
    payload = request_audio.audio_bytes
    atomic_write = transport.atomic_write
    observed = []

    def observe_receipt(path: Path, data: bytes) -> None:
        assert path.name == "completion.json"
        assert not path.exists()
        assert (path.parent / "result.bin").read_bytes() == payload
        observed.append(json.loads(data))
        atomic_write(path, data)

    monkeypatch.setattr(transport, "atomic_write", observe_receipt)
    publish_bytes(tmp_path, OUTPUT_ID, request_audio, payload)
    assert len(observed) == 1
    receipt = transport.decode_completion(
        (tmp_path / OUTPUT_ID / "completion.json").read_bytes(),
        OUTPUT_ID,
        request_audio.fingerprint(),
    )
    assert receipt["size"] == len(payload)
    assert receipt["sha256"] == hashlib.sha256(payload).hexdigest()
    assert not list((tmp_path / OUTPUT_ID).glob(".pending-*"))


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("output_id", OTHER_ID),
        ("request_fingerprint", "b" * 64),
        ("operation", "unknown"),
        ("operation", []),
        ("status", "pending"),
        ("status", []),
        ("size", 0),
        ("size", -1),
        ("size", True),
        ("size", "4"),
        ("sha256", "g" * 64),
        ("sha256", "a" * 63),
    ],
)
def test_completion_rejects_invalid_identity_and_integrity_fields(
    tmp_path: Path, request_audio: InferenceRequest, field: str, value: object
) -> None:
    publish_bytes(tmp_path, OUTPUT_ID, request_audio, request_audio.audio_bytes)
    receipt = json.loads((tmp_path / OUTPUT_ID / "completion.json").read_bytes())
    receipt[field] = value
    with pytest.raises(ValueError):
        transport.decode_completion(
            json.dumps(receipt).encode(), OUTPUT_ID, request_audio.fingerprint()
        )


@pytest.mark.parametrize(
    "data", [b"{", b"[]", b"null", b" " * (transport.COMPLETION_LIMIT + 1)]
)
def test_completion_rejects_malformed_and_oversized_receipts(
    request_audio: InferenceRequest, data: bytes
) -> None:
    with pytest.raises(ValueError):
        transport.decode_completion(data, OUTPUT_ID, request_audio.fingerprint())


def test_empty_output_never_publishes_completion(
    tmp_path: Path, request_audio: InferenceRequest
) -> None:
    with pytest.raises(ValueError, match="empty"):
        publish_bytes(tmp_path, OUTPUT_ID, request_audio, b"")
    assert not (tmp_path / OUTPUT_ID / "completion.json").exists()
    assert not list((tmp_path / OUTPUT_ID).glob(".pending-*"))


def test_transport_volume_identity_is_private_to_app_and_environment(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    request_audio: InferenceRequest,
) -> None:
    namespaces = [
        ("app-a", "prod"),
        ("app-a", "dev"),
        ("app-b", "prod"),
        ("app-a-prod", "dev"),
    ]
    volumes: dict[tuple[str, str], LocalVolume] = {}

    def from_name(name: str, *, environment_name: str) -> LocalVolume:
        key = (name, environment_name)
        if key not in volumes:
            volumes[key] = LocalVolume(tmp_path / f"private-volume-{len(volumes)}")
        return volumes[key]

    monkeypatch.setattr(modal_client.modal.Volume, "from_name", from_name)

    def activate(namespace: tuple[str, str]) -> None:
        app, environment = namespace
        monkeypatch.setattr(modal_client.config, "MODAL_APP_NAME", app)
        monkeypatch.setattr(modal_client.config, "MODAL_ENVIRONMENT", environment)
        modal_client._get_transport_volume.cache_clear()

    requests = [
        replace(
            request_audio,
            audio_bytes=tone_wav((220.0 + index * 110.0,), duration_s=0.2),
        )
        for index in range(len(namespaces))
    ]
    selected = []
    try:
        for namespace, request in zip(namespaces, requests, strict=True):
            activate(namespace)
            # The same opaque token must identify different private files here.
            modal_client.stage_input(request, OUTPUT_ID)
            local = modal_client._get_transport_volume()
            assert isinstance(local, LocalVolume)
            staged_request = transport.load_request(local.root, OUTPUT_ID)
            publish_bytes(
                local.root,
                OUTPUT_ID,
                staged_request,
                staged_request.audio_bytes,
            )
            selected.append(local)

        snapshots = [local.snapshot() for local in selected]
        for index, (namespace, request) in enumerate(
            zip(namespaces, requests, strict=True)
        ):
            activate(namespace)
            result = modal_client.read_result(OUTPUT_ID, request.fingerprint())
            assert result == request.audio_bytes
            with wave.open(io.BytesIO(result), "rb") as audio:
                assert audio.getnframes() / audio.getframerate() == 0.2
            other_request = requests[(index + 1) % len(requests)]
            with pytest.raises(ValueError):
                modal_client.read_result(OUTPUT_ID, other_request.fingerprint())

        activate(namespaces[0])
        modal_client.cleanup(OUTPUT_ID)
        assert selected[0].snapshot() == {}
        with pytest.raises(FileNotFoundError):
            modal_client.read_result(OUTPUT_ID, requests[0].fingerprint())
        for index in range(1, len(namespaces)):
            activate(namespaces[index])
            assert selected[index].snapshot() == snapshots[index]
            assert (
                modal_client.read_result(OUTPUT_ID, requests[index].fingerprint())
                == requests[index].audio_bytes
            )
    finally:
        modal_client._get_transport_volume.cache_clear()

    with pytest.raises(ValueError):
        transport.transport_volume_name("app-a", " ")
    with pytest.raises(ValueError):
        transport.transport_volume_name("", "prod")


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="requires real CPU FFmpeg")
def test_large_audio_and_metadata_use_token_only_rpc_and_verified_streaming(
    volume: LocalVolume,
    monkeypatch: pytest.MonkeyPatch,
    request_audio: InferenceRequest,
) -> None:
    request = replace(
        request_audio,
        audio_bytes=tone_wav((440.0,), duration_s=25.0, channels=2),
        parameters={
            "gain": 0.5,
            "lyrics": "large metadata is not an RPC argument\n" * 1024,
        },
    )
    assert len(request.audio_bytes) > 2 * 1024 * 1024
    modal_client.stage_input(request, OUTPUT_ID)
    assert volume.batches == [True]
    assert volume.uploads == [f"/{OUTPUT_ID}/input.bin", f"/{OUTPUT_ID}/request.json"]
    staged = volume.snapshot()
    assert staged[f"{OUTPUT_ID}/input.bin"] == request.audio_bytes
    assert len(staged[f"{OUTPUT_ID}/request.json"]) > 8192
    calls = []
    produced = []

    def transform(staged_request: InferenceRequest) -> bytes:
        assert staged_request == request
        result = subprocess.run(
            [
                "ffmpeg",
                "-nostdin",
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                "pipe:0",
                "-af",
                f"volume={staged_request.parameters['gain']}",
                "-c:a",
                "pcm_s16le",
                "-f",
                "wav",
                "pipe:1",
            ],
            input=staged_request.audio_bytes,
            capture_output=True,
            check=True,
        ).stdout
        produced.append(result)
        return result

    class LocalCall:
        object_id = "fc-local-private-transport"

        def get(self, *, timeout: float) -> str:
            return OUTPUT_ID

    class LocalFunction:
        def spawn(self, *args: object, **kwargs: object) -> LocalCall:
            assert args == (OUTPUT_ID,)
            assert kwargs == {}
            calls.append(args)
            assert produce_result(volume, OUTPUT_ID, transform) == OUTPUT_ID
            return LocalCall()

    monkeypatch.setattr(modal_client, "_get_function", lambda: LocalFunction())
    call = modal_client.spawn(
        OUTPUT_ID, operation=request.operation, producer_digest=request.producer_digest
    )
    assert call.object_id == "fc-local-private-transport"
    assert modal_client.poll(call, timeout=0.01) == OUTPUT_ID
    result = modal_client.read_result(OUTPUT_ID, request.fingerprint())
    assert calls == [(OUTPUT_ID,)]
    assert len(produced) == 1
    assert len(result) > 2 * 1024 * 1024
    assert result == produced[0]
    assert result != request.audio_bytes
    duration, frequency = mp3_measurements(result)
    assert duration == pytest.approx(25.0, abs=0.001)
    assert frequency == pytest.approx(440.0, abs=0.1)
    with wave.open(io.BytesIO(result), "rb") as transformed:
        output_samples = transformed.readframes(22050)
    with wave.open(io.BytesIO(request.audio_bytes), "rb") as original:
        input_samples = original.readframes(22050)
    input_peak = max(
        abs(sample[0]) for sample in struct.iter_unpack("<h", input_samples)
    )
    output_peak = max(
        abs(sample[0]) for sample in struct.iter_unpack("<h", output_samples)
    )
    assert output_peak / input_peak == pytest.approx(0.5, abs=0.001)
    result_chunks = [
        size for name, size in volume.read_chunks if name.endswith("/result.bin")
    ]
    assert len(result_chunks) > 2
    assert max(result_chunks) <= volume.chunk_size
    assert sum(result_chunks) == len(result)
    assert volume.removals == []
    modal_client.cleanup(OUTPUT_ID)
    assert volume.snapshot() == {}


@pytest.mark.parametrize(
    "damage", ["changed", "truncated", "extended", "wrong-fingerprint"]
)
def test_client_rejects_corrupt_stream_without_deleting_evidence(
    volume: LocalVolume, request_audio: InferenceRequest, damage: str
) -> None:
    modal_client.stage_input(request_audio, OUTPUT_ID)
    publish_bytes(volume.root, OUTPUT_ID, request_audio, request_audio.audio_bytes)
    path = volume.root / OUTPUT_ID / "result.bin"
    fingerprint = request_audio.fingerprint()
    data = path.read_bytes()
    if damage == "changed":
        path.write_bytes(bytes([data[0] ^ 1]) + data[1:])
    elif damage == "truncated":
        path.write_bytes(data[:-1])
    elif damage == "extended":
        path.write_bytes(data + b"unexpected trailing bytes")
    else:
        fingerprint = "b" * 64
    before = volume.snapshot()
    with pytest.raises(ValueError):
        modal_client.read_result(OUTPUT_ID, fingerprint)
    assert volume.snapshot() == before
    assert volume.removals == []


def test_client_missing_completion_retains_input_for_resume(
    volume: LocalVolume, request_audio: InferenceRequest
) -> None:
    modal_client.stage_input(request_audio, OUTPUT_ID)
    before = volume.snapshot()
    with pytest.raises(FileNotFoundError):
        modal_client.read_result(OUTPUT_ID, request_audio.fingerprint())
    assert volume.snapshot() == before
    assert volume.removals == []


def test_cleanup_removes_only_selected_private_transfer(
    volume: LocalVolume, request_audio: InferenceRequest
) -> None:
    for output_id in (OUTPUT_ID, OTHER_ID):
        modal_client.stage_input(request_audio, output_id)
        publish_bytes(volume.root, output_id, request_audio, request_audio.audio_bytes)
    retained = {
        name: data
        for name, data in volume.snapshot().items()
        if name.startswith(OTHER_ID + "/")
    }
    modal_client.cleanup(OUTPUT_ID)
    modal_client.cleanup(OUTPUT_ID)  # A resumed acknowledgement is idempotent.
    assert volume.snapshot() == retained
    assert (
        modal_client.read_result(OTHER_ID, request_audio.fingerprint())
        == request_audio.audio_bytes
    )


def test_large_native_failure_retains_complete_local_diagnostics_and_bounds_exception(
    volume: LocalVolume, tmp_path: Path, request_audio: InferenceRequest
) -> None:
    modal_client.stage_input(request_audio, OUTPUT_ID)
    diagnostics = (
        b"native decoder failed: detailed diagnostics\n" * 60000
        + b"END-OF-NATIVE-DIAGNOSTICS\n"
    )
    assert len(diagnostics) > 2 * 1024 * 1024
    publish_bytes(volume.root, OUTPUT_ID, request_audio, diagnostics, failed=True)
    diagnostics_root = tmp_path / "retained-diagnostics"
    before = volume.snapshot()
    with pytest.raises(RuntimeError) as raised:
        modal_client.read_result(
            OUTPUT_ID, request_audio.fingerprint(), diagnostics_root=diagnostics_root
        )
    assert len(str(raised.value).encode()) < 8192
    files = [path for path in diagnostics_root.rglob("*") if path.is_file()]
    assert any(path.read_bytes() == diagnostics for path in files)
    assert volume.snapshot() == before
    assert volume.removals == []
    chunks = [
        size for name, size in volume.read_chunks if name.endswith("/diagnostics.log")
    ]
    assert len(chunks) > 2
    assert sum(chunks) == len(diagnostics)
    modal_client.cleanup(OUTPUT_ID)
    assert any(path.read_bytes() == diagnostics for path in files)


def test_client_rejects_oversized_streamed_receipt_without_reading_payload(
    volume: LocalVolume, request_audio: InferenceRequest
) -> None:
    volume.chunk_size = 257
    modal_client.stage_input(request_audio, OUTPUT_ID)
    publish_bytes(volume.root, OUTPUT_ID, request_audio, request_audio.audio_bytes)
    receipt = volume.root / OUTPUT_ID / "completion.json"
    receipt.write_bytes(receipt.read_bytes() + b" " * transport.COMPLETION_LIMIT)
    before = volume.snapshot()
    with pytest.raises(ValueError, match="too large"):
        modal_client.read_result(OUTPUT_ID, request_audio.fingerprint())
    assert volume.reads == [f"/{OUTPUT_ID}/completion.json"]
    assert len(volume.read_chunks) > 1
    assert volume.snapshot() == before
    assert volume.removals == []


def test_corrupt_failure_diagnostics_are_not_published_as_verified_local_logs(
    volume: LocalVolume, tmp_path: Path, request_audio: InferenceRequest
) -> None:
    modal_client.stage_input(request_audio, OUTPUT_ID)
    diagnostics = b"native failure\n" * 100
    publish_bytes(volume.root, OUTPUT_ID, request_audio, diagnostics, failed=True)
    (volume.root / OUTPUT_ID / "diagnostics.log").write_bytes(diagnostics[:-1])
    diagnostics_root = tmp_path / "diagnostics"
    before = volume.snapshot()
    with pytest.raises(ValueError):
        modal_client.read_result(
            OUTPUT_ID,
            request_audio.fingerprint(),
            diagnostics_root=diagnostics_root,
        )
    assert not list(diagnostics_root.iterdir())
    assert volume.snapshot() == before
    assert volume.removals == []


def test_client_rejects_traversal_before_any_private_volume_or_rpc_access(
    volume: LocalVolume,
    request_audio: InferenceRequest,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def unexpected_rpc() -> None:
        pytest.fail("Invalid output identity reached the RPC lookup")

    monkeypatch.setattr(modal_client, "_get_function", unexpected_rpc)
    with pytest.raises(ValueError):
        modal_client.stage_input(request_audio, "../outside")
    with pytest.raises(ValueError):
        modal_client.spawn("../outside")
    with pytest.raises(ValueError):
        modal_client.read_result("../outside", request_audio.fingerprint())
    with pytest.raises(ValueError):
        modal_client.cleanup("../outside")
    assert volume.batches == []
    assert volume.reads == []
    assert volume.removals == []
    assert volume.snapshot() == {}


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="requires real CPU FFmpeg")
def test_actual_producer_failure_crosses_pickle_with_private_native_diagnostics(
    volume: LocalVolume,
    tmp_path: Path,
    request_audio: InferenceRequest,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    modal_app = importlib.import_module("separator.modal_app")

    request = replace(
        request_audio,
        audio_bytes=tone_wav((440.0,), duration_s=1.0),
    )
    modal_client.stage_input(request, OUTPUT_ID)
    monkeypatch.setattr(modal_app, "TRANSFER_MOUNT", str(volume.root))
    monkeypatch.setattr(modal_app, "transport_volume", volume)
    native_failures = []

    def native_failure(
        staged_request: InferenceRequest, source: Path, temporary: Path
    ) -> Path:
        assert staged_request == request
        assert source.read_bytes() == request.audio_bytes
        with (temporary / "diagnostics.log").open("wb") as diagnostics:
            # Real per-frame native diagnostics exceed the RPC payload limit.
            subprocess.run(
                [
                    "ffmpeg",
                    "-nostdin",
                    "-hide_banner",
                    "-loglevel",
                    "info",
                    "-i",
                    str(source),
                    "-af",
                    "asetnsamples=n=1,ashowinfo",
                    "-f",
                    "null",
                    "-",
                ],
                check=True,
                stdout=diagnostics,
                stderr=subprocess.STDOUT,
            )
            try:
                subprocess.run(
                    [
                        "ffmpeg",
                        "-nostdin",
                        "-hide_banner",
                        "-loglevel",
                        "error",
                        "-i",
                        str(source),
                        "-af",
                        "transport_fixture_missing_filter",
                        "-f",
                        "null",
                        "-",
                    ],
                    check=True,
                    stdout=diagnostics,
                    stderr=subprocess.STDOUT,
                )
            except subprocess.CalledProcessError as error:
                native_failures.append(error.returncode)
                raise
        pytest.fail("The intentionally invalid native filter unexpectedly succeeded")

    monkeypatch.setattr(modal_app, "_run_model", native_failure)
    with pytest.raises(transport.InferenceTransferError) as raised:
        modal_app.infer.local(OUTPUT_ID)
    assert native_failures and native_failures[0] != 0
    assert volume.reloads == 1
    assert len(volume.commits) == 1
    committed = volume.commits[0]
    diagnostics = committed[f"{OUTPUT_ID}/diagnostics.log"]
    assert len(diagnostics) > 2 * 1024 * 1024
    assert b"ashowinfo" in diagnostics
    assert b"transport_fixture_missing_filter" in diagnostics
    assert b"CalledProcessError" in diagnostics
    receipt = transport.decode_completion(
        committed[f"{OUTPUT_ID}/completion.json"], OUTPUT_ID, request.fingerprint()
    )
    assert receipt["status"] == "failed"
    assert receipt["size"] == len(diagnostics)
    assert receipt["sha256"] == hashlib.sha256(diagnostics).hexdigest()
    assert f"{OUTPUT_ID}/result.bin" not in committed

    wire_error = pickle.dumps(raised.value)
    assert len(wire_error) < 1024
    restored = pickle.loads(wire_error)
    assert type(restored) is transport.InferenceTransferError
    assert restored.output_id == OUTPUT_ID
    assert restored.phase == "execution"
    assert restored.args == (OUTPUT_ID, "execution")
    assert restored.__cause__ is None
    assert restored.__context__ is None
    assert len(str(restored).encode()) < 256
    diagnostics_root = tmp_path / "retained-native-diagnostics"
    with pytest.raises(RuntimeError) as consumer_error:
        modal_client.read_result(
            restored.output_id,
            request.fingerprint(),
            diagnostics_root=diagnostics_root,
        )
    assert len(str(consumer_error.value).encode()) < 1024
    assert (diagnostics_root / f"{OUTPUT_ID}.log").read_bytes() == diagnostics
    assert volume.snapshot() == committed
    assert volume.removals == []
