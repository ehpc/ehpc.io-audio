"""Song ownership, late identity convergence, and output reuse regressions."""

import asyncio
import hashlib
import json
import shutil
import sqlite3
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace

import pytest
from audio_samples import tone_wav
from inference_fixture import StemSignal, fixture_manifest

from backend import (
    config,
    coverage,
    db,
    events,
    library,
    modal_client,
    queue,
    song_projection,
)
from backend.models import ResultManifestEntry
from backend.routes import jobs
from separator import cache_versions
from separator.options import MixSpec, SeparationOptions
from separator.pitch import pitch_from_json
from separator.producer_manifest import save_manifest
from separator.progress import JobPhase
from separator.stems import INSTRUMENTS_STEM, VOCALS_STEM


def _upload(client, name="source.wav", data=b"same recording", **options):
    return client.post(
        "/api/jobs", files={"file": (name, data, "audio/wav")}, data=options
    )


def _finish(work_id, label, provenance):
    directory = config.RESULTS_DIR / str(work_id)
    directory.mkdir(parents=True, exist_ok=True)
    filename = f"{label}.mp3"
    (directory / filename).write_bytes(b"generated")
    db.mark_done(
        work_id,
        [
            ResultManifestEntry(
                label=label, filename=filename, size_bytes=9, duration_s=1
            )
        ],
        provenance=provenance,
    )


def test_repeat_upload_and_addition_are_one_owner_scoped_song(client, other_client):
    first = _upload(client, extract_vocals="true").json()
    repeat = _upload(client, name="renamed.wav", extract_vocals="true").json()
    added = _upload(client, name="another.wav", extract_instruments="true").json()
    other = _upload(other_client, extract_vocals="true").json()
    assert repeat["song_id"] == added["song_id"] == first["song_id"]
    assert repeat["work_id"] == first["work_id"]
    assert added["work_id"] != first["work_id"]
    assert other["song_id"] != first["song_id"]
    assert len(client.get("/api/songs").json()) == 1
    assert other_client.get(f"/api/songs/{first['song_id']}").status_code == 404
    assert other_client.get(f"/api/jobs/{first['work_id']}/original").status_code == 404


def test_add_work_reuses_private_source_without_upload(client):
    first = _upload(client, extract_vocals="true").json()
    response = client.post(
        f"/api/songs/{first['song_id']}/work", data={"extract_instruments": "true"}
    )
    assert response.status_code == 200
    added = response.json()
    assert added["song_id"] == first["song_id"]
    assert added["work_id"] != first["work_id"]
    assert (
        client.get(f"/api/jobs/{added['work_id']}/original").content
        == b"same recording"
    )
    snapshot = db.regeneration_snapshot(added["work_id"])
    assert snapshot is not None
    assert snapshot[1] == hashlib.sha256(b"same recording").hexdigest()


def test_song_deletion_requires_all_work_terminal_and_keeps_other_owner(
    client, other_client
):
    first = _upload(client, extract_vocals="true").json()
    other = _upload(other_client, extract_vocals="true").json()
    db.mark_done(first["work_id"], [])
    added = client.post(
        f"/api/songs/{first['song_id']}/work", data={"extract_instruments": "true"}
    ).json()
    assert client.delete(f"/api/songs/{first['song_id']}").status_code == 409
    assert (
        client.get(f"/api/jobs/{first['work_id']}/original").content
        == b"same recording"
    )
    db.mark_failed(added["work_id"], "synthetic failure")
    assert client.delete(f"/api/songs/{first['song_id']}").status_code == 204
    assert client.get(f"/api/songs/{first['song_id']}").status_code == 404
    assert (
        other_client.get(f"/api/jobs/{other['work_id']}/original").content
        == b"same recording"
    )


def test_parallel_equal_requests_claim_only_one_work():
    options = SeparationOptions(extract_vocals=True)

    def submit(_):
        return db.insert_job(
            "owner", "url", "https://example.test/exact", options, deduplicate=True
        )

    with ThreadPoolExecutor(max_workers=8) as pool:
        submitted = list(pool.map(submit, range(24)))
    assert len({value.song_id for value in submitted}) == 1
    assert len({value.work_id for value in submitted}) == 1


def test_covered_outputs_across_work_require_current_provenance_and_files(
    client, monkeypatch, tmp_path
):
    fixture_manifest(tmp_path / "producer")
    monkeypatch.setattr(
        config, "PRODUCER_MANIFEST", tmp_path / "producer" / "fixture-manifest.json"
    )
    vocals = _upload(client, extract_vocals="true").json()
    _finish(
        vocals["work_id"],
        "vocals",
        coverage.signatures(SeparationOptions(extract_vocals=True)),
    )
    instruments = _upload(client, extract_instruments="true").json()
    _finish(
        instruments["work_id"],
        "instruments",
        coverage.signatures(SeparationOptions(extract_instruments=True)),
    )
    response = _upload(client, extract_vocals="true", extract_instruments="true").json()
    assert response["song_id"] == vocals["song_id"]
    assert response["work_id"] is None and response["status"] == "done"
    (config.RESULTS_DIR / str(instruments["work_id"]) / "instruments.mp3").unlink()
    missing = _upload(client, extract_vocals="true", extract_instruments="true").json()
    assert missing["work_id"] is not None
    missing_job = db.get_job(missing["work_id"])
    assert missing_job is not None
    missing_options = missing_job.options
    assert not missing_options.extract_vocals and missing_options.extract_instruments
    detail = client.get(f"/api/songs/{vocals['song_id']}").json()
    refs = detail["variants"][0]["outputs"]
    assert {ref["label"] for ref in refs} == {"vocals", "instruments"}


def test_changed_producer_never_reuses_old_export_as_current(
    client, monkeypatch, tmp_path
):
    fixture_manifest(tmp_path / "first")
    monkeypatch.setattr(
        config, "PRODUCER_MANIFEST", tmp_path / "first" / "fixture-manifest.json"
    )
    first = _upload(client, extract_vocals="true").json()
    _finish(
        first["work_id"],
        "vocals",
        coverage.signatures(SeparationOptions(extract_vocals=True)),
    )
    assert _upload(client, extract_vocals="true").json()["work_id"] is None
    fixture_manifest(tmp_path / "second", signals={"vocals": StemSignal(440, 1)})
    monkeypatch.setattr(
        config, "PRODUCER_MANIFEST", tmp_path / "second" / "fixture-manifest.json"
    )
    requested = _upload(client, extract_vocals="true").json()
    assert requested["song_id"] == first["song_id"]
    assert requested["work_id"] is not None
    assert client.get(f"/api/jobs/{first['work_id']}/results/vocals").status_code == 200


def test_failed_addition_preserves_completed_outputs(client):
    first = _upload(client, extract_vocals="true").json()
    _finish(first["work_id"], "vocals", None)
    added = client.post(
        f"/api/songs/{first['song_id']}/work", data={"extract_instruments": "true"}
    ).json()
    db.mark_failed(added["work_id"], "synthetic failure")
    detail = client.get(f"/api/songs/{first['song_id']}").json()
    assert detail["summary"]["status"] == "done"
    assert detail["summary"]["latest_work_id"] == added["work_id"]
    assert detail["variants"][0]["outputs"][0]["work_id"] == first["work_id"]
    assert client.get(f"/api/jobs/{first['work_id']}/results/vocals").status_code == 200


def test_addition_holds_source_against_concurrent_delete(client, monkeypatch):
    first = _upload(client, extract_vocals="true").json()
    db.mark_done(first["work_id"], [])
    entered, release = threading.Event(), threading.Event()
    original = jobs._read_song_original

    def blocked(*args):
        entered.set()
        assert release.wait(5)
        return original(*args)

    monkeypatch.setattr(jobs, "_read_song_original", blocked)
    with ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(
            client.post,
            f"/api/songs/{first['song_id']}/work",
            data={"extract_instruments": "true"},
        )
        try:
            assert entered.wait(5)
            assert client.delete(f"/api/songs/{first['song_id']}").status_code == 409
        finally:
            release.set()
        assert pending.result(timeout=5).status_code == 200
    assert (
        client.get(f"/api/jobs/{first['work_id']}/original").content
        == b"same recording"
    )


def test_verified_late_content_merge_updates_work_identity(client, other_client):
    url = client.post(
        "/api/jobs", data={"url": "https://example.test/recording"}
    ).json()
    upload = _upload(client, data=b"downloaded source").json()
    other = _upload(other_client, data=b"downloaded source").json()
    assert url["song_id"] != upload["song_id"]
    directory = config.UPLOADS_DIR / str(url["work_id"])
    directory.mkdir(parents=True)
    (directory / "downloaded.wav").write_bytes(b"downloaded source")
    library.bind_digest(
        url["work_id"], hashlib.sha256(b"downloaded source").hexdigest()
    )
    canonical = min(url["song_id"], upload["song_id"])
    assert client.get(f"/api/jobs/{upload['work_id']}").json()["song_id"] == canonical
    assert client.get(f"/api/jobs/{url['work_id']}").json()["song_id"] == canonical
    assert (
        other_client.get(f"/api/jobs/{other['work_id']}").json()["song_id"]
        == other["song_id"]
    )
    assert len(client.get("/api/songs").json()) == 1


def test_output_groups_preserve_independent_tempos_and_mix_compositions(client):
    first_mix = json.dumps(
        [{"id": "mix-same", "name": "Bass and drums", "components": ["bass", "drums"]}]
    )
    second_mix = json.dumps(
        [
            {
                "id": "mix-same",
                "name": "Voice and drums",
                "components": ["vocals", "drums"],
            }
        ]
    )
    first = _upload(
        client, mixes=first_mix, pitch_semitones="1", tempo_percent="90"
    ).json()
    _finish(first["work_id"], "mix-same", None)
    second = _upload(
        client, mixes=second_mix, pitch_semitones="1", tempo_percent="90"
    ).json()
    _finish(second["work_id"], "mix-same", None)
    third = _upload(
        client, extract_vocals="true", pitch_semitones="2", tempo_percent="110"
    ).json()
    _finish(third["work_id"], "vocals", None)
    detail = client.get(f"/api/songs/{first['song_id']}").json()
    groups = {(v["pitch_semitones"], v["tempo_percent"]): v for v in detail["variants"]}
    assert set(groups) == {(1, 90), (2, 110)}
    mixed = groups[(1, 90)]["outputs"]
    assert len(mixed) == 2
    assert len({item["identity"] for item in mixed}) == 2
    assert {item["work_id"] for item in mixed} == {first["work_id"], second["work_id"]}
    assert groups[(2, 110)]["outputs"][0]["work_id"] == third["work_id"]


def test_legacy_migration_merges_verified_content_and_keeps_counts_and_files():
    first = db.insert_job("owner", "upload", "first.wav", SeparationOptions())
    second = db.insert_job(
        "owner", "upload", "second.wav", SeparationOptions(pitch_semitones=2)
    )
    other = db.insert_job("other", "upload", "third.wav", SeparationOptions())
    assert first.work_id is not None
    assert second.work_id is not None
    assert other.work_id is not None
    for work_id, filename in [
        (first.work_id, "first.wav"),
        (second.work_id, "second.wav"),
        (other.work_id, "third.wav"),
    ]:
        directory = config.UPLOADS_DIR / str(work_id)
        directory.mkdir(parents=True)
        (directory / filename).write_bytes(b"same verified source")
    with sqlite3.connect(config.DB_PATH) as conn:
        conn.execute("UPDATE jobs SET open_count=2 WHERE id=?", (first.work_id,))
        conn.execute("UPDATE jobs SET open_count=3 WHERE id=?", (second.work_id,))
        conn.executescript(
            "DELETE FROM library_song_sources; DELETE FROM library_song_jobs; "
            "DELETE FROM library_songs;"
        )
    db.init_db()
    assert library.song_for_work(first.work_id, "owner") == library.song_for_work(
        second.work_id, "owner"
    )
    assert library.song_for_work(other.work_id, "other") != library.song_for_work(
        first.work_id, "owner"
    )
    summary = song_projection.current("owner")
    assert summary is not None
    assert summary.open_count == 5
    assert (
        config.UPLOADS_DIR / str(second.work_id) / "second.wav"
    ).read_bytes() == b"same verified source"


@pytest.mark.skipif(
    not shutil.which("ffmpeg") or not shutil.which("rubberband"),
    reason="native CPU transform tools required",
)
def test_source_only_and_cpu_transform_do_not_need_model_manifest(
    monkeypatch, tmp_path
):
    monkeypatch.setattr(config, "PRODUCER_MANIFEST", tmp_path / "missing.json")
    assert coverage.known_signatures(SeparationOptions()) == {}
    signatures = coverage.known_signatures(SeparationOptions(pitch_semitones=2))
    assert signatures is not None and set(signatures) == {"audio:song"}


def test_producer_identity_excludes_release_metadata_and_targets_lyrics_policy(
    monkeypatch, tmp_path
):
    root = tmp_path / "producer"
    manifest = fixture_manifest(root)
    path = root / "fixture-manifest.json"
    monkeypatch.setattr(config, "PRODUCER_MANIFEST", path)
    options = SeparationOptions(extract_vocals=True, extract_lyrics=True)
    baseline = coverage.signatures(options)
    save_manifest(path, replace(manifest, image_id="different-deployment-image"))
    assert coverage.signatures(options) == baseline
    monkeypatch.setattr(
        cache_versions, "REFERENCE_POLICY", cache_versions.REFERENCE_POLICY + "-test"
    )
    changed = coverage.signatures(options)
    assert changed["audio:vocals"] == baseline["audio:vocals"]
    assert changed["lyrics"] != baseline["lyrics"]


def test_cleanup_and_mix_identities_have_distinct_readable_names():
    raw = SeparationOptions(drums=True)
    clean = SeparationOptions(drums=True, decrowd=True)
    assert coverage.output_identity("drums", raw) != coverage.output_identity(
        "drums", clean
    )
    assert coverage.output_display_name("drums", raw) != coverage.output_display_name(
        "drums", clean
    )
    first = SeparationOptions(mixes=(MixSpec("mix-one", "Band", ("drums", "bass")),))
    second = SeparationOptions(mixes=(MixSpec("mix-one", "Band", ("drums", "vocals")),))
    assert coverage.output_identity("mix-one", first) != coverage.output_identity(
        "mix-one", second
    )
    assert coverage.output_display_name(
        "mix-one", first
    ) != coverage.output_display_name("mix-one", second)


@pytest.mark.skipif(
    not shutil.which("ffmpeg") or not shutil.which("ffprobe"),
    reason="synthetic CPU inference requires FFmpeg",
)
def test_real_queue_reuses_existing_stem_and_exports_only_missing(
    worker_client, monkeypatch, tmp_path
):
    from test_e2e import _cpu_modal, _wait_for_terminal  # noqa: PLC0415

    spawned = _cpu_modal(monkeypatch, tmp_path)
    monkeypatch.setattr(queue, "detect_key", lambda audio, name, root: "C major")
    source = tone_wav((440,), duration_s=1)
    first = _upload(worker_client, data=source, extract_vocals="true").json()
    assert (
        _wait_for_terminal(worker_client, first["work_id"], timeout_s=30)["status"]
        == "done"
    )
    added = worker_client.post(
        f"/api/songs/{first['song_id']}/work",
        data={"extract_vocals": "true", "extract_instruments": "true"},
    ).json()
    job = _wait_for_terminal(worker_client, added["work_id"], timeout_s=30)
    assert job["status"] == "done"
    assert job["options"]["extract_vocals"] is False
    assert [entry["label"] for entry in job["manifest"]] == ["instruments"]
    models = [
        request.parameters["model"]
        for request in spawned
        if request.operation == "separation"
    ]
    assert models.count(VOCALS_STEM.model) == 1
    assert models.count(INSTRUMENTS_STEM.model) == 1
    again = worker_client.post(
        f"/api/songs/{first['song_id']}/work",
        data={"extract_vocals": "true", "extract_instruments": "true"},
    ).json()
    assert again["status"] == "done" and again["work_id"] is None


@pytest.mark.skipif(
    not shutil.which("ffmpeg") or not shutil.which("ffprobe"),
    reason="synthetic CPU inference requires FFmpeg",
)
def test_adding_lyrics_enriches_existing_karaoke_without_repeating_pitch(
    worker_client, monkeypatch, tmp_path
):
    from test_e2e import _cpu_modal, _wait_for_terminal  # noqa: PLC0415

    spawned = _cpu_modal(monkeypatch, tmp_path)
    monkeypatch.setattr(queue, "detect_key", lambda audio, name, root: "C major")
    monkeypatch.setattr(queue, "reference_metadata", lambda *args, **kwargs: None)
    source = tone_wav((440,), duration_s=1)
    first = _upload(worker_client, data=source, detect_pitch="true").json()
    assert (
        _wait_for_terminal(worker_client, first["work_id"], timeout_s=30)["status"]
        == "done"
    )
    added = worker_client.post(
        f"/api/songs/{first['song_id']}/work",
        data={"extract_lyrics": "true"},
    ).json()
    job = _wait_for_terminal(worker_client, added["work_id"], timeout_s=30)
    assert job["status"] == "done"
    assert job["transcript"] is not None and job["pitch"] is not None
    assert len([request for request in spawned if request.operation == "pitch"]) == 1
    variants = worker_client.get(f"/api/songs/{first['song_id']}").json()["variants"]
    assert variants[0]["karaoke_work_id"] == added["work_id"]
    assert variants[0]["pitched_lyrics_work_id"] == added["work_id"]


@pytest.mark.skipif(
    any(shutil.which(tool) is None for tool in ("ffmpeg", "ffprobe", "rubberband")),
    reason="native CPU transform tools required",
)
def test_real_source_and_transform_jobs_need_no_model_manifest(
    worker_client, monkeypatch, tmp_path
):
    from test_e2e import _wait_for_terminal  # noqa: PLC0415

    monkeypatch.setattr(
        config, "PRODUCER_MANIFEST", tmp_path / "missing-model-manifest.json"
    )
    monkeypatch.setattr(queue, "detect_key", lambda audio, name, root: "C major")

    def forbidden(*args, **kwargs):
        raise AssertionError("CPU-only requests must not dispatch inference")

    monkeypatch.setattr(modal_client, "spawn", forbidden)
    source = tone_wav((440,), duration_s=1)
    first = _upload(worker_client, data=source).json()
    assert (
        _wait_for_terminal(worker_client, first["work_id"], timeout_s=30)["status"]
        == "done"
    )
    again = _upload(worker_client, data=source).json()
    assert again["work_id"] is None and again["status"] == "done"
    transformed = worker_client.post(
        f"/api/songs/{first['song_id']}/work",
        data={"pitch_semitones": "2"},
    ).json()
    job = _wait_for_terminal(worker_client, transformed["work_id"], timeout_s=30)
    assert job["status"] == "done"
    assert [entry["label"] for entry in job["manifest"]] == ["song"]
    assert worker_client.get(f"/api/jobs/{first['work_id']}/original").content == source
    assert (
        worker_client.get(
            f"/api/jobs/{transformed['work_id']}/results/song"
        ).status_code
        == 200
    )


@pytest.mark.skipif(
    not shutil.which("ffmpeg") or not shutil.which("ffprobe"),
    reason="synthetic CPU inference requires FFmpeg",
)
def test_late_alias_merge_enriches_pitch_after_other_work_publishes(
    client, monkeypatch, tmp_path
):
    from test_e2e import _cpu_modal  # noqa: PLC0415

    spawned = _cpu_modal(monkeypatch, tmp_path)
    monkeypatch.setattr(queue, "detect_key", lambda audio, name, root: "C major")
    monkeypatch.setattr(queue, "reference_metadata", lambda *args, **kwargs: None)
    source = tone_wav((440,), duration_s=1)
    older = db.insert_job(
        "owner", "upload", "older.wav", SeparationOptions(detect_pitch=True)
    )
    newer = db.insert_job(
        "owner", "upload", "newer.wav", SeparationOptions(extract_lyrics=True)
    )
    assert older.work_id is not None and newer.work_id is not None
    newer_id: int = newer.work_id
    for work_id, name in ((older.work_id, "older.wav"), (newer.work_id, "newer.wav")):
        directory = config.UPLOADS_DIR / str(work_id)
        directory.mkdir(parents=True)
        (directory / name).write_bytes(source)
    first, second = db.claim_oldest_queued(), db.claim_oldest_queued()
    assert first is not None and second is not None
    assert first.id == older.work_id and second.id == newer.work_id
    source_gate = threading.Event()
    bind_seen = threading.Event()
    load_source = queue._load_source_bytes
    bind = library.bind_digest
    process = queue._process
    set_phase = queue._set_phase

    def delayed_source(job):
        if job.id == older.work_id:
            assert source_gate.wait(15)
        return load_source(job)

    def observed_bind(work_id, digest):
        result = bind(work_id, digest)
        if work_id == older.work_id:
            bind_seen.set()
        return result

    async def scenario():
        newer_entered = asyncio.Event()
        release_newer = asyncio.Event()
        newer_exporting = asyncio.Event()
        release_export = asyncio.Event()
        older_processing = asyncio.Event()
        listener = events.subscribe(newer_id)

        async def observed_process(job, *args):
            if job.id == newer.work_id:
                newer_entered.set()
                await release_newer.wait()
            elif job.id == older.work_id:
                older_processing.set()
            return await process(job, *args)

        async def observed_phase(job, phase):
            if job.id == newer.work_id and phase == JobPhase.EXPORT:
                newer_exporting.set()
                await release_export.wait()
            return await set_phase(job, phase)

        monkeypatch.setattr(queue, "_load_source_bytes", delayed_source)
        monkeypatch.setattr(library, "bind_digest", observed_bind)
        monkeypatch.setattr(queue, "_process", observed_process)
        monkeypatch.setattr(queue, "_set_phase", observed_phase)
        tasks = [
            asyncio.create_task(queue._run_job(first)),
            asyncio.create_task(queue._run_job(second)),
        ]
        try:
            await asyncio.wait_for(newer_entered.wait(), 15)
            source_gate.set()
            assert await asyncio.to_thread(bind_seen.wait, 15)
            while not listener.empty():
                listener.get_nowait()
            release_newer.set()
            await asyncio.wait_for(newer_exporting.wait(), 30)
            observed = []
            while not listener.empty():
                observed.append(listener.get_nowait())
            assert any(
                message["progress"]["current"] == "separation"
                and message["song_id"] == older.song_id
                for message in observed
            )
            try:
                await asyncio.wait_for(older_processing.wait(), 1)
            except TimeoutError:
                pass
            finally:
                release_export.set()
            await asyncio.wait_for(asyncio.gather(*tasks), 60)
        finally:
            source_gate.set()
            release_newer.set()
            release_export.set()
            for task in tasks:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            events.unsubscribe(newer_id, listener)

    asyncio.run(scenario())
    job = db.get_job(older.work_id)
    assert job is not None
    assert job.status == "done"
    assert job.transcript is not None and job.pitch_json is not None
    assert [word.text for word in job.transcript.words] == ["fixture"]
    pitch = pitch_from_json(job.pitch_json)
    assert [word.text for word in pitch.words] == ["fixture"]
    assert any(0 in note.word_indices for track in pitch.tracks for note in track.notes)
    song_id = library.song_for_work(older.work_id, "owner")
    assert song_id is not None
    detail = song_projection.detail("owner", song_id)
    assert detail is not None
    assert detail.variants[0].pitched_lyrics_work_id == older.work_id
    assert (
        len([request for request in spawned if request.operation == "recognition"]) == 1
    )
    assert len([request for request in spawned if request.operation == "pitch"]) == 1
