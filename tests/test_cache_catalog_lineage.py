import io
import json
import zipfile

import pytest

from backend import cache_catalog, config
from backend.models import JobRecord, JobStatus
from backend.routes.results import _with_source
from separator.artifact_cache import cache_key, cached_bytes
from separator.options import SeparationOptions


@pytest.fixture
def cache_root(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    return tmp_path / "artifacts"


def test_real_cache_hits_and_shared_artifacts_are_attributed(cache_root):
    calls = []
    shared_key = cache_key("shared")
    unique_key = cache_key("unique")

    def produce():
        calls.append(True)
        return b"artifact"

    with cache_catalog.capture() as first:
        first.bind(b"original one", "First")
        assert (
            cached_bytes(cache_root / "inference", shared_key, produce) == b"artifact"
        )
        cached_bytes(cache_root / "inference", unique_key, produce)
    with cache_catalog.capture() as second:
        second.bind(b"original two", "Second")
        assert (
            cached_bytes(cache_root / "inference", shared_key, produce) == b"artifact"
        )

    assert len(calls) == 2
    snapshot = cache_catalog.snapshot()
    assert snapshot["selective_ready"]
    songs = {song["title"]: song for song in snapshot["songs"]}
    assert songs["First"]["bytes"] == 16
    assert songs["Second"]["bytes"] == 8
    shared = f"inference/{shared_key}.bin"
    assert shared in cache_catalog.select_paths([songs["First"]["id"]])
    assert cache_catalog.select_paths([songs["Second"]["id"]]) == {shared}
    (cache_root / shared).unlink()
    cache_catalog.forget_paths({shared})
    assert cache_catalog.select_paths([songs["First"]["id"]]) != {shared}
    with pytest.raises(ValueError):
        cache_catalog.select_paths([songs["Second"]["id"]])


def test_pending_source_capture_and_legacy_unknown_fail_closed(cache_root):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w") as archive:
        archive.writestr("audio", b"original")
        archive.writestr("name", json.dumps("Track.mp3"))
        archive.writestr("metadata", b"")
    with cache_catalog.capture() as recorder:
        cached_bytes(cache_root / "sources", cache_key("download"), stream.getvalue)
        recorder.bind(b"original", "Track")
    unknown = (
        cache_root
        / "qwen-asr"
        / "results"
        / "recognition"
        / (cache_key("old") + ".bin")
    )
    unknown.parent.mkdir(parents=True)
    unknown.write_bytes(b"old")
    snapshot = cache_catalog.snapshot()
    assert snapshot["unattributed_bytes"] == 3
    assert not snapshot["selective_ready"]
    assert len(cache_catalog.select_paths([snapshot["songs"][0]["id"]])) == 1
    unknown.write_bytes(b"")
    assert cache_catalog.snapshot()["unattributed_bytes"] == 0
    assert not cache_catalog.snapshot()["selective_ready"]
    unknown.unlink()
    assert cache_catalog.snapshot()["selective_ready"]


def test_legacy_zip_proves_source_and_excludes_symlinks_and_locks(cache_root, tmp_path):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w") as archive:
        archive.writestr("audio", b"source")
        archive.writestr("name", json.dumps("fallback.mp3"))
        archive.writestr("metadata", json.dumps({"track": "Title", "artist": "Artist"}))
    path = cache_root / "sources" / (cache_key("source") + ".bin")
    path.parent.mkdir(parents=True)
    path.write_bytes(stream.getvalue())
    (path.parent / (cache_key("lock") + ".lock")).write_bytes(b"lock")
    link = path.parent / (cache_key("link") + ".bin")
    link.symlink_to(tmp_path / "outside")
    snapshot = cache_catalog.snapshot()
    assert not snapshot["selective_ready"]
    assert snapshot["unsafe"]
    assert snapshot["songs"][0]["title"] == "Title"
    assert snapshot["songs"][0]["artist"] == "Artist"
    with pytest.raises(ValueError):
        cache_catalog.all_paths()
    link.unlink()
    assert cache_catalog.all_paths() == {f"sources/{path.name}"}


def test_private_pitch_reference_is_not_reusable_cache(cache_root, tmp_path):
    private = tmp_path / "results" / "42" / ".pitch-vocals.mp3"
    private.parent.mkdir(parents=True)
    private.write_bytes(b"vocals")
    snapshot = cache_catalog.snapshot()
    assert snapshot["songs"] == []
    assert snapshot["unattributed_bytes"] == 0
    assert snapshot["selective_ready"]
    assert cache_catalog.all_paths() == set()
    assert private.read_bytes() == b"vocals"


def test_snapshot_omits_uploads_without_cache_and_keeps_null_title(
    cache_root, tmp_path
):
    upload = tmp_path / "uploads" / "7" / "song.mp3"
    upload.parent.mkdir(parents=True)
    upload.write_bytes(b"unused")
    assert cache_catalog.snapshot()["songs"] == []
    with cache_catalog.capture() as recorder:
        recorder.bind(b"different source")
        cached_bytes(cache_root / "keys", cache_key("key"), lambda: b"")
    songs = cache_catalog.snapshot()["songs"]
    assert len(songs) == 1
    assert songs[0]["title"] is None


def test_unsafe_cache_directory_fails_closed(cache_root, tmp_path):
    cache_root.mkdir()
    (cache_root / "inference").symlink_to(tmp_path, target_is_directory=True)
    assert cache_catalog.unsafe_paths()
    assert not cache_catalog.snapshot()["selective_ready"]
    with pytest.raises(ValueError):
        cache_catalog.all_paths()


def test_playback_source_hash_streams_and_rejects_symlinks(
    cache_root, tmp_path, monkeypatch
):
    uploads = tmp_path / "uploads"
    directory = uploads / "5"
    directory.mkdir(parents=True)
    source = directory / "original.mp3"
    source.write_bytes(b"original")
    monkeypatch.setattr(config, "UPLOADS_DIR", uploads)
    job = JobRecord(
        id=5,
        session_id="test",
        status=JobStatus.DONE,
        source_type="upload",
        source_value="original.mp3",
        title="Song",
        options=SeparationOptions(),
        modal_call_id=None,
        result_manifest=[],
        error_message=None,
        created_at=0,
        started_at=None,
        finished_at=None,
    )
    _with_source(job, cached_bytes, cache_root / "keys", cache_key("x"), lambda: b"key")
    assert cache_catalog.snapshot()["songs"][0]["title"] == "Song"
    source.unlink()
    source.symlink_to(tmp_path / "outside")
    _with_source(job, cached_bytes, cache_root / "keys", cache_key("y"), lambda: b"key")
    assert not cache_catalog.snapshot()["selective_ready"]


def test_legacy_source_fingerprint_skips_unchanged_and_rechecks_replacement(
    cache_root, monkeypatch
):
    def source_zip(audio, name):
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w") as archive:
            archive.writestr("audio", audio)
            archive.writestr("name", json.dumps(name))
            archive.writestr("metadata", b"")
        return output.getvalue()

    path = cache_root / "sources" / (cache_key("source") + ".bin")
    path.parent.mkdir(parents=True)
    path.write_bytes(source_zip(b"first", "first.mp3"))
    calls = []
    original = zipfile.ZipFile.open

    def counted(archive, name, *args, **kwargs):
        if name == "audio":
            calls.append(1)
        return original(archive, name, *args, **kwargs)

    monkeypatch.setattr(zipfile.ZipFile, "open", counted)
    first = cache_catalog.snapshot()
    assert first["songs"][0]["title"] == "first"
    assert len(calls) == 1
    assert cache_catalog.snapshot()["songs"] == first["songs"]
    assert len(calls) == 1
    path.write_bytes(source_zip(b"different recording", "second.mp3"))
    replaced = cache_catalog.snapshot()
    assert len(calls) == 2
    assert [song["title"] for song in replaced["songs"]] == ["second"]
    path.write_bytes(b"invalid archive")
    invalid = cache_catalog.snapshot()
    assert invalid["songs"] == []
    assert not invalid["selective_ready"]


def test_nested_dependencies_follow_parent_hits_across_sources(cache_root):
    parent_key = cache_key("parent")
    child_key = cache_key("child")
    grandchild_key = cache_key("grandchild")
    calls = []

    def child():
        calls.append("child")
        return cached_bytes(cache_root / "keys", grandchild_key, lambda: b"nested")

    def parent():
        calls.append("parent")
        return cached_bytes(cache_root / "inference", child_key, child)

    with cache_catalog.capture() as first:
        first.bind(b"source one", "One")
        cached_bytes(cache_root / "transcripts", parent_key, parent)
    with cache_catalog.capture() as second:
        second.bind(b"source two", "Two")
        cached_bytes(cache_root / "transcripts", parent_key, parent)
    assert calls == ["parent", "child"]
    snapshot = cache_catalog.snapshot()
    assert snapshot["selective_ready"]
    second_id = next(song["id"] for song in snapshot["songs"] if song["title"] == "Two")
    assert cache_catalog.select_paths([second_id]) == {
        f"transcripts/{parent_key}.bin",
        f"inference/{child_key}.bin",
        f"keys/{grandchild_key}.bin",
    }


def test_preexisting_parent_hit_never_claims_complete_dependencies(cache_root):
    key = cache_key("old parent")
    path = cache_root / "transcripts" / f"{key}.bin"
    path.parent.mkdir(parents=True)
    path.write_bytes(b"old")
    with cache_catalog.capture() as recorder:
        recorder.bind(b"source", "Song")
        assert (
            cached_bytes(path.parent, key, lambda: pytest.fail("unexpected miss"))
            == b"old"
        )
    snapshot = cache_catalog.snapshot()
    assert not snapshot["selective_ready"]
    assert snapshot["unattributed_bytes"] == 3


def test_failed_parent_is_not_marked_complete(cache_root):
    parent_key = cache_key("failed")
    child_key = cache_key("produced")

    def produce():
        cached_bytes(cache_root / "keys", child_key, lambda: b"child")
        raise RuntimeError("producer failed")

    with cache_catalog.capture() as recorder:
        recorder.bind(b"source", "Song")
        with pytest.raises(RuntimeError):
            cached_bytes(cache_root / "transcripts", parent_key, produce)
    parent = cache_root / "transcripts" / f"{parent_key}.bin"
    parent.write_bytes(b"preexisting")
    with cache_catalog.capture() as recorder:
        recorder.bind(b"other", "Other")
        cached_bytes(parent.parent, parent_key, lambda: pytest.fail("unexpected miss"))
    assert not cache_catalog.snapshot()["selective_ready"]


def test_evicted_shared_child_remains_dependency_of_surviving_parent(cache_root):
    child_key = cache_key("shared-child")
    parent_key = cache_key("surviving-parent")
    child = cache_root / "keys" / f"{child_key}.bin"
    parent = cache_root / "transcripts" / f"{parent_key}.bin"
    with cache_catalog.capture() as recorder:
        recorder.bind(b"source A", "A")
        cached_bytes(child.parent, child_key, lambda: b"shared")
    with cache_catalog.capture() as recorder:
        recorder.bind(b"source B", "B")
        cached_bytes(
            parent.parent,
            parent_key,
            lambda: cached_bytes(child.parent, child_key, lambda: pytest.fail("miss")),
        )
    before = cache_catalog.snapshot()
    ids = {song["title"]: song["id"] for song in before["songs"]}
    assert cache_catalog.select_paths([ids["A"]]) == {f"keys/{child_key}.bin"}
    child.unlink()
    cache_catalog.forget_paths({f"keys/{child_key}.bin"})
    assert cache_catalog.snapshot()["selective_ready"]
    with cache_catalog.capture() as recorder:
        recorder.bind(b"source C", "C")
        cached_bytes(child.parent, child_key, lambda: b"recreated")
    after = cache_catalog.snapshot()
    assert after["selective_ready"]
    song_b = next(song for song in after["songs"] if song["title"] == "B")
    assert song_b["bytes"] == len(b"shared") + len(b"recreated")
    assert cache_catalog.select_paths([ids["B"]]) == {
        f"transcripts/{parent_key}.bin",
        f"keys/{child_key}.bin",
    }
