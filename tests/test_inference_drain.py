"""Drain boundaries preserve accepted work without dispatching the next stage."""

import asyncio
import json
import os
import signal
import subprocess
import sys
import threading
import time
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest
from inference_crash_worker import CALL_ID
from inference_fixture import fixture_manifest
from transport_fixture import LocalVolume

from backend import config, db, drain, inference, modal_client
from separator.artifact_cache import digest
from separator.options import SeparationOptions
from separator.processing import ProcessingContext
from separator.producer_manifest import load_manifest
from separator.structure import assemble_structure

pytest_plugins = ["test_inference_durability"]


@pytest.fixture
def stages(tmp_path, monkeypatch):
    drain.state.reset()
    monkeypatch.setattr(config, "DATA_DIR", tmp_path / "data")
    monkeypatch.setattr(config, "DB_PATH", config.DATA_DIR / "jobs.db")
    db.init_db()
    manifest = fixture_manifest(tmp_path / "producer")
    job = db.insert_job("drain-test", "upload", "source.wav", SeparationOptions())
    stop = threading.Event()
    runner = inference.StageRunner(job, manifest, stop)
    context = ProcessingContext(
        config.DATA_DIR / "artifacts", manifest, runner, on_committed=runner.committed
    )
    monkeypatch.setattr(inference, "ensure_prepared", lambda *args: None)
    yield SimpleNamespace(job=job, stop=stop, context=context)
    drain.state.reset()


def stage(context, identity):
    return context.stage(
        "structure", b"source", "source.wav", {}, identity, lambda data: data
    )


def begin_drain():
    asyncio.run(drain.state.begin())


def test_accepted_stage_finishes_and_checkpoints_before_next_stage_defers(
    stages, monkeypatch
):
    events = []
    result = b"validated stage result"
    outputs = []

    def upload(request, output_id):
        events.append("upload")
        outputs.append(output_id)

    def spawn(output_id, **kwargs):
        events.append("spawn")
        return SimpleNamespace(object_id="call-1")

    def poll(call, timeout):
        events.append("poll")
        if events.count("poll") == 1:
            begin_drain()
            return None
        return outputs[-1]

    def read_result(output_id, fingerprint):
        events.append("read")
        return result

    def cleanup(output_id):
        events.append("cleanup")

    monkeypatch.setattr(modal_client, "stage_input", upload)
    monkeypatch.setattr(modal_client, "spawn", spawn)
    monkeypatch.setattr(modal_client, "poll", poll)
    monkeypatch.setattr(modal_client, "read_result", read_result)
    monkeypatch.setattr(modal_client, "cleanup", cleanup)

    assert stage(stages.context, "first") == result
    assert drain.state.draining
    assert not stages.stop.is_set()
    first_key = stages.context.key("structure", "first")
    artifact = stages.context.root / "inference" / f"{first_key}.bin"
    receipt_path = stages.context.root / "inference-requests" / f"{first_key}.json"
    receipt = json.loads(receipt_path.read_bytes())
    assert artifact.read_bytes() == result
    assert receipt["result_sha256"] == digest(result)
    assert receipt["result_size"] == len(result)
    assert receipt["cleaned"] is True
    assert events.count("spawn") == 1
    assert events.count("cleanup") == 1

    # A completed cache hit remains usable, but another missing stage cannot
    # perform an upload or accept a new call while admission is drained.
    assert stage(stages.context, "first") == result
    with pytest.raises(drain.DrainDeferred):
        stage(stages.context, "second")
    second_key = stages.context.key("structure", "second")
    assert not (stages.context.root / "inference" / f"{second_key}.bin").exists()
    assert events.count("upload") == 1
    assert events.count("spawn") == 1

    # The deferred stage can be completed by a fresh, accepting worker without
    # paying for the already committed first stage again.
    drain.state.reset()
    assert stage(stages.context, "second") == result
    assert events.count("spawn") == 2
    assert stage(stages.context, "first") == result
    assert events.count("spawn") == 2


@pytest.mark.parametrize("drain_before_resume", [False, True])
def test_recorded_call_resumes_during_drain(stages, monkeypatch, drain_before_resume):
    output = []
    resumed = []
    polls = []
    monkeypatch.setattr(
        modal_client, "stage_input", lambda request, oid: output.append(oid)
    )
    monkeypatch.setattr(
        modal_client,
        "spawn",
        lambda *args, **kwargs: SimpleNamespace(object_id="known-call"),
    )

    def interrupted_poll(call, timeout):
        stages.stop.set()
        return None

    monkeypatch.setattr(modal_client, "poll", interrupted_poll)
    with pytest.raises(InterruptedError):
        stage(stages.context, "first")
    key = stages.context.key("structure", "first")
    owner = db.get_job(stages.job)
    assert owner is not None
    assert (owner.active_stage_key, owner.modal_call_id) == (key, "known-call")
    stages.stop.clear()
    if drain_before_resume:
        begin_drain()

    def resume(call_id):
        resumed.append(call_id)
        return SimpleNamespace(object_id=call_id)

    def resumed_poll(call, timeout):
        polls.append(call.object_id)
        if len(polls) == 1 and not drain_before_resume:
            begin_drain()
            return None
        return output[0]

    monkeypatch.setattr(modal_client, "resume", resume)
    monkeypatch.setattr(modal_client, "poll", resumed_poll)
    monkeypatch.setattr(modal_client, "read_result", lambda *args: b"resumed result")
    monkeypatch.setattr(modal_client, "cleanup", lambda output_id: None)
    monkeypatch.setattr(
        modal_client,
        "spawn",
        lambda *args, **kwargs: pytest.fail("redispatched accepted call"),
    )
    monkeypatch.setattr(
        modal_client,
        "stage_input",
        lambda *args: pytest.fail("reuploaded accepted call"),
    )
    assert stage(stages.context, "first") == b"resumed result"
    assert resumed == ["known-call"]
    assert polls == (
        ["known-call"] if drain_before_resume else ["known-call", "known-call"]
    )
    assert (
        stages.context.root / "inference" / f"{key}.bin"
    ).read_bytes() == b"resumed result"
    assert drain.state.draining


def test_uncertain_dispatch_remains_fail_closed_across_drain(stages, monkeypatch):
    attempts = []
    monkeypatch.setattr(modal_client, "stage_input", lambda *args: None)

    def uncertain_spawn(*args, **kwargs):
        attempts.append("spawn")
        raise OSError("lost dispatch acknowledgement")

    monkeypatch.setattr(modal_client, "spawn", uncertain_spawn)
    with pytest.raises(inference.UncertainInferenceDispatch):
        stage(stages.context, "first")
    key = stages.context.key("structure", "first")
    owner = db.get_job(stages.job)
    assert owner is not None
    assert (owner.active_stage_key, owner.modal_call_id) == (key, None)
    receipt_path = stages.context.root / "inference-requests" / f"{key}.json"
    receipt = receipt_path.read_bytes()

    begin_drain()
    with pytest.raises(inference.UncertainInferenceDispatch):
        stage(stages.context, "first")
    drain.state.reset()  # A new worker may resume; it must not redispatch intent.
    with pytest.raises(inference.UncertainInferenceDispatch):
        stage(stages.context, "first")
    assert attempts == ["spawn"]
    assert receipt_path.read_bytes() == receipt
    owner = db.get_job(stages.job)
    assert owner is not None
    assert (owner.active_stage_key, owner.modal_call_id) == (key, None)
    assert not (stages.context.root / "inference" / f"{key}.bin").exists()


def test_drain_during_upload_releases_unaccepted_claim(stages, monkeypatch):
    uploads = []
    spawns = []

    def upload(request, output_id):
        uploads.append(output_id)
        if len(uploads) == 1:
            begin_drain()

    def spawn(output_id, **kwargs):
        spawns.append(output_id)
        return SimpleNamespace(object_id="later-call")

    monkeypatch.setattr(modal_client, "stage_input", upload)
    monkeypatch.setattr(modal_client, "spawn", spawn)
    monkeypatch.setattr(modal_client, "poll", lambda call, timeout: uploads[-1])
    monkeypatch.setattr(modal_client, "read_result", lambda *args: b"later result")
    monkeypatch.setattr(modal_client, "cleanup", lambda output_id: None)

    with pytest.raises(drain.DrainDeferred):
        stage(stages.context, "first")
    owner = db.get_job(stages.job)
    assert owner is not None
    assert owner.active_stage_key is None and owner.modal_call_id is None
    assert spawns == []

    drain.state.reset()
    assert stage(stages.context, "first") == b"later result"
    assert len(uploads) == 2
    assert len(spawns) == 1


@pytest.mark.parametrize("recorded", [False, True], ids=["uncertain", "accepted"])
def test_changed_producer_cannot_replace_uncompleted_owner(
    stages, monkeypatch, recorded
):
    calls = []
    monkeypatch.setattr(modal_client, "stage_input", lambda *args: None)

    def spawn(*args, **kwargs):
        calls.append("spawn")
        if not recorded:
            raise OSError("acceptance unknown")
        return SimpleNamespace(object_id="original-call")

    def interrupt(call, timeout):
        stages.stop.set()
        return None

    monkeypatch.setattr(modal_client, "spawn", spawn)
    monkeypatch.setattr(modal_client, "poll", interrupt)
    with pytest.raises(
        InterruptedError if recorded else inference.UncertainInferenceDispatch
    ):
        stage(stages.context, "first")
    stages.stop.clear()
    original_key = stages.context.key("structure", "first")
    manifest = stages.context.manifest
    changed = replace(
        manifest,
        versions={**manifest.versions, "STRUCTURE_REVISION": "a" * 40},
    )
    runner = inference.StageRunner(stages.job, changed, stages.stop)
    context = ProcessingContext(stages.context.root, changed, runner)
    assert context.key("structure", "first") != original_key
    with pytest.raises(ValueError, match="another uncompleted inference stage"):
        stage(context, "first")
    owner = db.get_job(stages.job)
    assert owner is not None
    assert (owner.active_stage_key, owner.modal_call_id) == (
        original_key,
        "original-call" if recorded else None,
    )
    assert calls == ["spawn"]


def test_killed_recorded_worker_resumes_while_already_draining(
    durable_stage, monkeypatch
):
    root, job, key, request = durable_stage
    project = Path(__file__).resolve().parent.parent
    marker = root / "recorded"
    program = """
import sys, time
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import inference_crash_worker as worker
original = worker.db.set_active_stage
marker = Path(sys.argv[2])
def record_and_wait(*args):
    original(*args)
    marker.write_text("recorded")
    while True:
        time.sleep(1)
worker.db.set_active_stage = record_and_wait
sys.argv = ["worker", sys.argv[3], sys.argv[4], "produce"]
worker.main()
"""
    env = {
        **os.environ,
        "PYTHONPATH": os.pathsep.join(
            filter(None, [str(project), os.environ.get("PYTHONPATH", "")])
        ),
    }
    process = subprocess.Popen(
        [
            sys.executable,
            "-c",
            program,
            str(project / "tests"),
            str(marker),
            str(root),
            str(job),
        ],
        cwd=project,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    try:
        deadline = time.monotonic() + 30
        while (
            not marker.exists()
            and process.poll() is None
            and time.monotonic() < deadline
        ):
            time.sleep(0.05)
        assert marker.exists(), "worker did not durably record its accepted call"
    finally:
        process.kill()
        process.communicate(timeout=10)
    assert process.returncode == -signal.SIGKILL
    owner = db.get_job(job)
    assert owner is not None
    assert (owner.active_stage_key, owner.modal_call_id) == (key, CALL_ID)
    assert (root / "accepted.log").read_text().splitlines() == [request.fingerprint()]

    manifest = load_manifest(root / "producer" / "fixture-manifest.json")
    runner = inference.StageRunner(job, manifest, threading.Event())
    context = ProcessingContext(
        config.DATA_DIR / "artifacts", manifest, runner, runner.committed
    )
    remote = json.loads((root / "remote-call.json").read_text())
    resumed = []
    monkeypatch.setattr(
        modal_client,
        "_get_transport_volume",
        lambda: LocalVolume(root / "private-transport"),
    )
    monkeypatch.setattr(
        modal_client,
        "resume",
        lambda call_id: resumed.append(call_id) or SimpleNamespace(object_id=call_id),
    )
    monkeypatch.setattr(modal_client, "poll", lambda call, timeout: remote["output_id"])
    monkeypatch.setattr(
        modal_client,
        "spawn",
        lambda *args, **kwargs: pytest.fail("redispatched accepted call"),
    )
    monkeypatch.setattr(
        modal_client,
        "stage_input",
        lambda *args: pytest.fail("reuploaded accepted call"),
    )
    drain.state.reset()
    try:
        begin_drain()
        result = context.stage(
            "structure",
            request.audio_bytes,
            "source.wav",
            {},
            digest(request.audio_bytes),
            lambda data: assemble_structure(**json.loads(data)),
        )
        assert result.sections[0].label == "verse"
        assert resumed == [CALL_ID]
        assert (context.root / "inference" / f"{key}.bin").is_file()
        assert (root / "accepted.log").read_text().splitlines() == [
            request.fingerprint()
        ]
    finally:
        drain.state.reset()
