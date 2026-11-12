"""Exercise isolated smoke-call aborts without Modal or neural inference."""

import hashlib
import threading
from concurrent.futures import Future
from pathlib import Path

import gpu_smoke
import pytest
from audio_samples import tone_wav
from gpu_smoke import gpu_context
from transport_fixture import LocalVolume, produce_result

from backend import config, modal_client
from separator.inference_transport import (
    InferenceTransferError,
    load_request,
    publish_file,
)


class QueuedCall:
    def __init__(
        self, *, cancel_fails: bool = False, interrupted: bool = False
    ) -> None:
        self.future: Future[str] = Future()
        self.cancel_fails = cancel_fails
        self.interrupted = interrupted

    def get(self, *, timeout: float) -> str:
        if self.interrupted:
            raise KeyboardInterrupt("external test interruption")
        return self.future.result(timeout=timeout)

    def cancel(self) -> None:
        if self.cancel_fails:
            raise OSError("simulated cancellation failure")
        self.future.cancel()


@pytest.fixture
def isolated_context(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("MODAL_APP_NAME", "audio-separator-ci-local-l4")
    monkeypatch.setenv("MODAL_TEST_GPU", "L4")
    monkeypatch.setattr(config, "MODAL_APP_NAME", "audio-separator-ci-local-l4")
    monkeypatch.setattr(gpu_smoke, "SMOKE_RESULT_TIMEOUT_S", 0.05)
    monkeypatch.setattr(gpu_smoke, "L4_FIRST_RESULT_TIMEOUT_S", 0.05)
    monkeypatch.setattr(gpu_smoke, "ensure_prepared", lambda *_args: None)
    volume = LocalVolume(tmp_path / "private-volume")
    monkeypatch.setattr(modal_client, "_get_transport_volume", lambda: volume)
    return gpu_context(tmp_path / "computed"), volume


def run_stage(context, audio: bytes) -> bytes:
    return context.stage(
        "recognition", audio, "source.wav", {}, ["owned-source"], bytes
    )


def assert_input_retained(volume: LocalVolume, audio: bytes) -> None:
    directories = list(volume.root.iterdir())
    assert len(directories) == 1
    request = load_request(volume.root, directories[0].name)
    assert request.audio_bytes == audio
    assert request.operation == "recognition"
    assert not volume.removals


@pytest.mark.parametrize("gpu", ["L4", "L40S"])
def test_later_l4_and_first_l40s_result_allow_longer_wait(
    isolated_context, monkeypatch: pytest.MonkeyPatch, gpu: str
) -> None:
    context, volume = isolated_context
    if gpu == "L40S":
        monkeypatch.setenv("MODAL_TEST_GPU", gpu)
        context = gpu_context(context.root)
    monkeypatch.setattr(gpu_smoke, "SMOKE_RESULT_TIMEOUT_S", 1.0)
    calls = []
    workers = []

    def spawn(output_id: str, **_kwargs):
        call = QueuedCall()
        calls.append(call)

        def finish():
            produce_result(
                volume,
                output_id,
                lambda request: hashlib.sha256(request.audio_bytes).digest(),
            )
            call.future.set_result(output_id)

        if len(calls) == 1 and gpu == "L4":
            finish()
        else:
            worker = threading.Timer(0.15, finish)
            workers.append(worker)
            worker.start()
        return call

    monkeypatch.setattr(modal_client, "spawn", spawn)
    first = tone_wav((440.0,), duration_s=0.2)
    second = tone_wav((660.0,), duration_s=0.2)
    try:
        assert (
            context.stage("recognition", first, "one.wav", {}, ["one"], bytes)
            == hashlib.sha256(first).digest()
        )
        assert (
            context.stage("recognition", second, "two.wav", {}, ["two"], bytes)
            == hashlib.sha256(second).digest()
        )
    finally:
        for worker in workers:
            worker.join()
    assert len(calls) == 2 and all(call.future.done() for call in calls)


@pytest.mark.parametrize("cancel_fails", [False, True])
def test_blocked_smoke_call_is_cancelled_or_reports_failed_cancel(
    isolated_context, monkeypatch: pytest.MonkeyPatch, cancel_fails: bool
) -> None:
    context, volume = isolated_context
    call = QueuedCall(cancel_fails=cancel_fails)
    monkeypatch.setattr(modal_client, "spawn", lambda *_args, **_kwargs: call)
    audio = tone_wav((440.0,), duration_s=0.2)

    with pytest.raises(TimeoutError):
        run_stage(context, audio)

    assert call.future.cancelled() is not cancel_fails
    assert_input_retained(volume, audio)
    assert not list((context.root / "inference").glob("*.bin"))


def test_interrupt_during_wait_cancels_own_smoke_call(
    isolated_context, monkeypatch: pytest.MonkeyPatch
) -> None:
    context, volume = isolated_context
    call = QueuedCall(interrupted=True)
    monkeypatch.setattr(modal_client, "spawn", lambda *_args, **_kwargs: call)
    audio = tone_wav((440.0,), duration_s=0.2)

    with pytest.raises(KeyboardInterrupt, match="external test interruption"):
        run_stage(context, audio)

    assert call.future.cancelled()
    assert_input_retained(volume, audio)


def test_terminal_remote_failure_retains_verified_diagnostics(
    isolated_context, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    context, volume = isolated_context
    call = QueuedCall()
    diagnostic = b"simulated model failure diagnostics\n"
    audio = tone_wav((440.0,), duration_s=0.2)

    def spawn(output_id: str, **_kwargs):
        request = load_request(volume.root, output_id)
        source = tmp_path / "diagnostics-source.log"
        source.write_bytes(diagnostic)
        publish_file(volume.root, output_id, request, source, failed=True)
        call.future.set_exception(InferenceTransferError(output_id, "execution"))
        return call

    monkeypatch.setattr(modal_client, "spawn", spawn)
    with pytest.raises(modal_client.InferenceStageFailure):
        run_stage(context, audio)

    assert call.future.done() and not call.future.cancelled()
    assert_input_retained(volume, audio)
    assert [
        path.read_bytes() for path in (context.root / "diagnostics").glob("*.log")
    ] == [diagnostic]
