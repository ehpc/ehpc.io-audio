"""Deterministic admission and lifecycle coverage for graceful drain."""

import asyncio
import socket
import sqlite3
import stat
import threading
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path

import pytest
from fastapi import FastAPI

from backend import auth_store, config, db, drain, queue
from backend.models import JobStatus
from separator.options import SeparationOptions


def test_drain_closes_work_admission_but_keeps_reads_and_liveness(client, monkeypatch):
    created = client.post("/api/jobs", data={"url": "https://example.com/song"})
    assert created.status_code == 200
    job_id = created.json()["id"]
    before = client.get("/api/jobs").json()
    assert client.get("/ready").status_code == 200
    assert client.get("/health").status_code == 200

    client.portal.call(drain.state.begin)

    def no_reservation(*args, **kwargs):
        raise AssertionError("draining requests must not consume work quota")

    monkeypatch.setattr(auth_store, "reserve_work", no_reservation)
    for path, kwargs in [
        ("/api/jobs", {"data": {"url": "https://example.com/other"}}),
        ("/api/song-search", {"json": {"query": "a song"}}),
        ("/api/key-analysis", {"data": {"url": "https://example.com/song"}}),
        (f"/api/jobs/{job_id}/retry", {}),
        (f"/api/jobs/{job_id}/pitch-reference/vocals", {}),
    ]:
        assert client.post(path, **kwargs).status_code == 503
    assert client.get("/api/jobs").json() == before
    assert client.get("/ready").status_code == 503
    assert client.get("/health").status_code == 200


def test_deferred_job_keeps_one_quota_reservation_and_rejection_adds_none(
    client, monkeypatch
):
    owner = client.get("/api/auth/me").json()["id"]

    def reservations():
        with sqlite3.connect(config.DB_PATH) as conn:
            return conn.execute("SELECT user_id FROM auth_work").fetchall()

    assert reservations() == []
    response = client.post(
        "/api/jobs",
        data={"extract_vocals": "true"},
        files={"file": ("song.wav", b"audio", "audio/wav")},
    )
    assert response.status_code == 200
    job_id = response.json()["id"]
    assert reservations() == [(owner,)]
    monkeypatch.setattr(queue, "detect_key", lambda *args: None)

    async def defer(*args):
        await drain.state.begin()
        raise drain.DrainDeferred()

    monkeypatch.setattr(queue, "_process", defer)

    async def process():
        job = await queue._claim_next_job()
        assert job is not None and job.id == job_id and job.session_id == owner
        await queue._run_job(job)

    client.portal.call(process)
    job = db.get_job(job_id)
    assert job is not None and job.status is JobStatus.QUEUED
    assert job.session_id == owner
    assert reservations() == [(owner,)]
    assert (
        client.post(
            "/api/jobs", data={"url": "https://example.com/rejected"}
        ).status_code
        == 503
    )
    assert reservations() == [(owner,)]


def test_drain_waits_for_request_admitted_before_gate_closed(client, monkeypatch):
    started = threading.Event()
    release = threading.Event()
    real_insert = db.insert_job

    def blocked_insert(*args, **kwargs):
        started.set()
        if not release.wait(2):
            raise AssertionError("admitted request was not released")
        return real_insert(*args, **kwargs)

    monkeypatch.setattr(db, "insert_job", blocked_insert)
    with ThreadPoolExecutor(max_workers=1) as pool:
        request = pool.submit(
            client.post, "/api/jobs", data={"url": "https://example.com/admitted"}
        )
        try:
            assert started.wait(2)
            client.portal.call(drain.state.begin)
            waiting = client.portal.start_task_soon(drain.state.wait)
            assert not waiting.done()
            assert (
                client.post(
                    "/api/jobs", data={"url": "https://example.com/rejected"}
                ).status_code
                == 503
            )
        finally:
            release.set()
        assert request.result(timeout=2).status_code == 200
        waiting.result(timeout=2)
    assert len(client.get("/api/jobs").json()) == 1


def test_socket_is_private_and_acknowledges_only_after_admitted_work_exits(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    socket_path = tmp_path / "drain.sock"
    monkeypatch.setattr(drain, "SOCKET", socket_path)

    async def exercise():
        server = await drain.serve()
        try:
            assert stat.S_IMODE(socket_path.stat().st_mode) == 0o600
            assert await drain.state.enter()
            reader, writer = await asyncio.open_unix_connection(socket_path)
            writer.write(b"drain\n")
            await writer.drain()
            await asyncio.wait_for(drain.state.changed.wait(), 2)
            reply = asyncio.create_task(reader.readline())
            await asyncio.sleep(0)
            assert not reply.done()
            assert not await drain.state.enter()
            drain.state.leave()
            assert await asyncio.wait_for(reply, 2) == b"drained\n"
            writer.close()
            await writer.wait_closed()
        finally:
            server.close()
            await server.wait_closed()
            drain.cleanup_socket(server)

    asyncio.run(exercise())


def test_invalid_socket_command_does_not_start_drain(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    socket_path = tmp_path / "drain.sock"
    monkeypatch.setattr(drain, "SOCKET", socket_path)

    async def exercise():
        server = await drain.serve()
        try:
            reader, writer = await asyncio.open_unix_connection(socket_path)
            writer.write(b"not-drain\n")
            await writer.drain()
            assert await asyncio.wait_for(reader.read(), 2) == b""
            assert not drain.state.draining
            writer.close()
            await writer.wait_closed()
        finally:
            server.close()
            await server.wait_closed()
            drain.cleanup_socket(server)

    asyncio.run(exercise())


def test_drain_wakes_idle_worker_without_waiting_for_poll(monkeypatch):
    monkeypatch.setattr(queue.config, "QUEUE_POLL_INTERVAL_S", 3600)

    async def exercise():
        polled = asyncio.Event()

        async def no_job():
            polled.set()
            return None

        monkeypatch.setattr(queue, "_claim_next_job", no_job)
        worker = asyncio.create_task(queue._worker_loop(0))
        drain.state.workers = [worker]
        try:
            await asyncio.wait_for(polled.wait(), 2)
            await drain.state.begin()
            await asyncio.wait_for(drain.state.wait(), 2)
            assert worker.done()
        finally:
            if not worker.done():
                worker.cancel()
            await asyncio.gather(worker, return_exceptions=True)

    asyncio.run(exercise())


def test_claim_after_drain_does_not_change_queued_job():
    job_id = db.insert_job(
        "owner", "url", "https://example.com/song", SeparationOptions()
    )

    async def exercise():
        await drain.state.begin()
        assert await queue._claim_next_job() is None

    asyncio.run(exercise())
    job = db.get_job(job_id)
    assert job is not None and job.status is JobStatus.QUEUED


def test_drain_serializes_with_inflight_claim_and_waits_for_worker(
    monkeypatch: pytest.MonkeyPatch,
):
    first = db.insert_job(
        "owner", "url", "https://example.com/one", SeparationOptions()
    )
    second = db.insert_job(
        "owner", "url", "https://example.com/two", SeparationOptions()
    )
    claim_started = threading.Event()
    release_claim = threading.Event()
    real_claim = db.claim_oldest_queued
    claims = []

    def blocked_claim():
        claims.append(1)
        claim_started.set()
        if not release_claim.wait(2):
            raise AssertionError("claim was not released")
        return real_claim()

    monkeypatch.setattr(db, "claim_oldest_queued", blocked_claim)

    async def exercise():
        job_started = asyncio.Event()
        release_job = asyncio.Event()
        finished = []

        async def run_job(job):
            assert job.id == first
            job_started.set()
            await release_job.wait()
            finished.append(job.id)

        monkeypatch.setattr(queue, "_run_job", run_job)
        worker = asyncio.create_task(queue._worker_loop(0))
        drain.state.workers = [worker]
        try:
            assert await asyncio.to_thread(claim_started.wait, 2)
            begin = asyncio.create_task(drain.state.begin())
            await asyncio.wait_for(drain.state.changed.wait(), 2)
            assert drain.state.draining
            assert not await asyncio.wait_for(drain.state.enter(), 2)
            assert not begin.done()
            release_claim.set()
            await asyncio.wait_for(begin, 2)
            await asyncio.wait_for(job_started.wait(), 2)
            waiting = asyncio.create_task(drain.state.wait())
            await asyncio.sleep(0)
            assert not waiting.done()
            release_job.set()
            await asyncio.wait_for(waiting, 2)
            assert finished == [first]
            assert len(claims) == 1
        finally:
            release_claim.set()
            release_job.set()
            if not worker.done():
                worker.cancel()
            await asyncio.gather(worker, return_exceptions=True)

    asyncio.run(exercise())
    queued = db.get_job(second)
    assert queued is not None and queued.status is JobStatus.QUEUED


def test_dispatch_barrier_does_not_block_readiness_or_admission(client):
    started = threading.Event()
    release = threading.Event()

    def blocked_dispatch():
        with drain.state.dispatch():
            started.set()
            assert release.wait(5)

    with ThreadPoolExecutor(max_workers=2) as pool:
        dispatch = pool.submit(blocked_dispatch)
        try:
            assert started.wait(2)
            begin = client.portal.start_task_soon(drain.state.begin)
            client.portal.call(drain.state.changed.wait)
            rejected = pool.submit(blocked_dispatch)
            assert not begin.done()
            assert client.get("/ready").status_code == 503
            assert (
                client.post(
                    "/api/jobs", data={"url": "https://example.com/rejected"}
                ).status_code
                == 503
            )
        finally:
            release.set()
        dispatch.result(timeout=2)
        begin.result(timeout=2)
        with pytest.raises(drain.DrainDeferred):
            rejected.result(timeout=2)


def test_wait_keeps_tracking_task_after_request_leaves():
    async def exercise():
        state = drain.DrainState()
        release = asyncio.Event()
        assert await state.enter()
        task = asyncio.create_task(release.wait())
        state.track(task)
        state.leave()
        await state.begin()
        waiting = asyncio.create_task(state.wait())
        await asyncio.sleep(0)
        assert not waiting.done()
        release.set()
        await asyncio.wait_for(waiting, 2)
        assert task.done()

    asyncio.run(exercise())


def test_reset_rejects_active_workers_and_lifespan_ownership_survives_reset():
    async def exercise():
        state = drain.DrainState()
        assert state.acquire_lifespan()
        assert not state.acquire_lifespan()
        state.reset()
        assert not state.acquire_lifespan()

        async def worker_loop() -> None:
            await asyncio.Event().wait()

        worker = asyncio.create_task(worker_loop())
        state.workers = [worker]
        with pytest.raises(RuntimeError, match="active"):
            state.reset()
        assert state.workers == [worker]
        worker.cancel()
        await asyncio.gather(worker, return_exceptions=True)
        state.reset()
        state.release_lifespan()
        assert state.acquire_lifespan()
        state.release_lifespan()

    asyncio.run(exercise())


def test_socket_startup_preserves_unrelated_and_active_paths(monkeypatch, tmp_path):
    path = tmp_path / "drain.sock"
    monkeypatch.setattr(drain, "SOCKET", path)

    async def exercise():
        path.write_text("unrelated")
        with pytest.raises(RuntimeError, match="not an owned socket"):
            await drain.serve()
        assert path.read_text() == "unrelated"
        path.unlink()
        server = await drain.serve()
        try:
            with pytest.raises(RuntimeError, match="already in use"):
                await drain.serve()
            assert path.exists()
        finally:
            server.close()
            await server.wait_closed()
            drain.cleanup_socket(server)

    asyncio.run(exercise())


def test_socket_replaces_stale_owned_socket_and_preserves_replacement(
    monkeypatch, tmp_path
):
    path = tmp_path / "drain.sock"
    monkeypatch.setattr(drain, "SOCKET", path)
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as stale:
        stale.bind(str(path))

    async def exercise():
        server = await drain.serve()
        server.close()
        await server.wait_closed()
        path.unlink(missing_ok=True)
        path.write_text("replacement")
        drain.cleanup_socket(server)
        assert path.read_text() == "replacement"

    asyncio.run(exercise())


def test_uncertain_dispatch_prevents_drain_acknowledgement():
    async def exercise():
        state = drain.DrainState()
        state.fail_drain()
        await state.begin()
        with pytest.raises(RuntimeError, match="cannot confirm"):
            await state.wait()

    asyncio.run(exercise())


def test_socket_rejects_nonprivate_directory(monkeypatch, tmp_path):
    directory = tmp_path / "public"
    directory.mkdir(mode=0o755)
    directory.chmod(0o755)
    monkeypatch.setattr(drain, "SOCKET", directory / "drain.sock")
    with pytest.raises(RuntimeError, match="not private"):
        asyncio.run(drain.serve())
    assert not drain.SOCKET.exists()


def test_unsafe_socket_prevents_worker_start(monkeypatch, tmp_path):
    path = tmp_path / "drain.sock"
    path.write_text("unrelated")
    monkeypatch.setattr(drain, "SOCKET", path)
    monkeypatch.setattr(config, "QUEUE_CONCURRENCY", 1)
    job_id = db.insert_job(
        "owner", "url", "https://example.com/song", SeparationOptions()
    )
    assert db.claim_oldest_queued() is not None
    queued_id = db.insert_job(
        "owner", "url", "https://example.com/queued", SeparationOptions()
    )

    async def exercise():
        with pytest.raises(RuntimeError, match="not an owned socket"):
            async with queue.lifespan(FastAPI()):
                pytest.fail("startup must not succeed")
        assert not drain.state.workers
        assert path.read_text() == "unrelated"
        job = db.get_job(job_id)
        assert job is not None and job.status is JobStatus.RUNNING
        queued = db.get_job(queued_id)
        assert queued is not None and queued.status is JobStatus.QUEUED

    asyncio.run(exercise())


def test_failed_search_startup_stops_and_joins_audio_workers(monkeypatch, tmp_path):
    monkeypatch.setattr(drain, "SOCKET", tmp_path / "drain.sock")
    monkeypatch.setattr(config, "QUEUE_CONCURRENCY", 1)
    monkeypatch.setattr(config, "QUEUE_POLL_INTERVAL_S", 3600)
    claimed = threading.Event()
    calls = []

    def no_job():
        calls.append("claim")
        claimed.set()
        return None

    @asynccontextmanager
    async def failed_search(done):
        assert await asyncio.to_thread(claimed.wait, 5)
        raise RuntimeError("search startup failed")
        yield

    monkeypatch.setattr(db, "claim_oldest_queued", no_job)
    monkeypatch.setattr(queue.song_search_worker, "lifespan", failed_search)

    async def exercise():
        with pytest.raises(RuntimeError, match="search startup failed"):
            async with queue.lifespan(FastAPI()):
                pytest.fail("startup must not succeed")
        assert drain.state.draining
        assert len(drain.state.workers) == 1
        assert all(task.done() for task in drain.state.workers)
        assert drain.state.search_done is None
        assert not drain.SOCKET.exists()
        assert calls == ["claim"]

    asyncio.run(exercise())


def test_worker_failure_waits_for_other_workers_and_search():
    async def exercise():
        state = drain.DrainState()
        release = asyncio.Event()
        search_done = asyncio.Event()

        async def failed():
            raise ValueError("worker failed")

        async def held():
            await release.wait()

        state.workers = [asyncio.create_task(failed()), asyncio.create_task(held())]
        state.search_done = search_done
        waiter = asyncio.create_task(state.wait())
        await asyncio.sleep(0)
        assert not waiter.done()
        release.set()
        await asyncio.sleep(0)
        assert not waiter.done()
        search_done.set()
        with pytest.raises(ExceptionGroup) as error:
            await waiter
        assert any(isinstance(item, ValueError) for item in error.value.exceptions)

    asyncio.run(exercise())
