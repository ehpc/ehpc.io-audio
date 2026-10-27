"""Consumer-visible title tags, lossless migration, and actual HTTP downloads."""

import io
import json
import os
import shutil
import socket
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import quote

import httpx
import pytest
import uvicorn
from audio_samples import tone_wav
from fastapi.testclient import TestClient
from mutagen.id3 import APIC, ID3, TALB, TIT2, TPE1, TXXX, ID3NoHeaderError

from backend import config, db, queue
from backend.main import app
from backend.metadata import ensure_download_title
from backend.models import ResultManifestEntry, download_filename
from separator.options import SeparationOptions
from separator.stems import StemResult

_NATIVE = all(shutil.which(tool) for tool in ("ffmpeg", "ffprobe"))
_ALL_OUTPUTS = SeparationOptions(
    extract_vocals=True,
    extract_instruments=True,
    mix_female_instruments=True,
    mix_male_instruments=True,
    mix_backing_instruments=True,
    decrowd=True,
    decrowd_vocals=True,
    dereverb=True,
    genders=True,
    lead_backing=True,
    drums=True,
)


def _tags(data: bytes) -> ID3:
    return ID3(io.BytesIO(data))


def _probe(path: Path) -> dict:
    return json.loads(
        subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_format",
                "-show_packets",
                "-show_entries",
                "format_tags:packet=data_hash",
                "-show_data_hash",
                "sha256",
                "-of",
                "json",
                str(path),
            ],
            check=True,
            capture_output=True,
            text=True,
        ).stdout
    )


@pytest.fixture
def tagged_mp3(tmp_path: Path) -> bytes:
    if not _NATIVE:
        pytest.skip("ffmpeg and ffprobe required (available in nix develop)")
    source = tmp_path / "source.mp3"
    subprocess.run(
        [
            "ffmpeg",
            "-nostdin",
            "-v",
            "error",
            "-i",
            "pipe:0",
            "-c:a",
            "libmp3lame",
            "-q:a",
            "0",
            str(source),
        ],
        input=tone_wav((440.0,), duration_s=0.3),
        check=True,
        capture_output=True,
    )
    tags = ID3(source)
    tags.add(TIT2(encoding=3, text=["Original embedded title"]))
    tags.add(TPE1(encoding=3, text=["Original artist"]))
    tags.add(TALB(encoding=3, text=["Original album"]))
    tags.add(TXXX(encoding=3, desc="custom", text=["keep this value"]))
    tags.add(APIC(encoding=3, mime="image/png", type=3, desc="cover", data=b"cover"))
    tags.save(source)
    return source.read_bytes()


def test_title_is_added_to_native_mp3_without_id3_header(
    tmp_path: Path, tagged_mp3: bytes
) -> None:
    path = tmp_path / "untagged.mp3"
    path.write_bytes(tagged_mp3)
    ID3(path).delete(path, delete_v1=True)
    with pytest.raises(ID3NoHeaderError):
        ID3(path)
    before = _probe(path)["packets"]

    ensure_download_title(path, "Canonical title.mp3")

    assert ID3(path)["TIT2"].text == ["Canonical title"]
    assert _probe(path)["packets"] == before


def test_title_is_added_when_existing_id3_has_no_title(
    tmp_path: Path, tagged_mp3: bytes
) -> None:
    path = tmp_path / "no-title.mp3"
    path.write_bytes(tagged_mp3)
    tags = ID3(path)
    del tags["TIT2"]
    tags.save(path)
    before = _probe(path)["packets"]

    ensure_download_title(path, "Canonical title.mp3")

    assert ID3(path)["TIT2"].text == ["Canonical title"]
    assert ID3(path)["TPE1"].text == ["Original artist"]
    assert _probe(path)["packets"] == before


@pytest.mark.parametrize("key", [None, "Db minor"])
def test_every_generated_output_persists_canonical_title_without_touching_audio(
    client: TestClient, tagged_mp3: bytes, key: str | None, tmp_path: Path
) -> None:
    job_id = db.insert_job("s1", "upload", "Björk: Song.MP3", _ALL_OUTPUTS)
    job = db.get_job(job_id)
    assert job is not None
    job.original_key = key
    original = tmp_path / "before.mp3"
    original.write_bytes(tagged_mp3)
    original_packets = _probe(original)["packets"]
    manifest = queue._persist_results(
        job,
        {label: StemResult(tagged_mp3, 0.3) for label in _ALL_OUTPUTS.output_labels},
    )
    assert [entry.label for entry in manifest] == _ALL_OUTPUTS.output_labels
    for entry in manifest:
        path = config.RESULTS_DIR / str(job_id) / entry.filename
        expected = download_filename(job.title, job_id, entry.label, job.options, key)
        assert entry.download_name == expected
        assert entry.size_bytes == path.stat().st_size
        assert _probe(path)["format"]["tags"]["title"] == expected.removesuffix(".mp3")
        assert _probe(path)["packets"] == original_packets
        tags = ID3(path)
        assert tags["TPE1"].text == ["Original artist"]
        assert tags["TALB"].text == ["Original album"]
        assert tags["TXXX:custom"].text == ["keep this value"]
        assert tags["APIC:cover"].data == b"cover"
        assert ("source-key" in tags["TIT2"].text[0]) == (key is not None)
    assert _tags(tagged_mp3)["TIT2"].text == ["Original embedded title"]


@pytest.mark.parametrize("version", [3, 4])
def test_title_replacement_is_atomic_idempotent_and_preserves_metadata(
    tmp_path: Path, version: int
) -> None:
    path = tmp_path / "old.mp3"
    path.write_bytes(b"audio-frames")
    tags = ID3()
    tags.add(TIT2(encoding=3, text=["old"]))
    tags.add(TPE1(encoding=3, text=["artist"]))
    tags.save(path, v2_version=version)
    before = path.read_bytes()
    with path.open("rb") as active_download:
        with ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(lambda _: ensure_download_title(path, "new.mp3"), range(8)))
        assert active_download.read() == before
    assert path.read_bytes().endswith(b"audio-frames")
    assert ID3(path)["TIT2"].text == ["new"]
    assert ID3(path)["TPE1"].text == ["artist"]
    assert ID3(path).version[1] == version
    stat = path.stat()
    ensure_download_title(path, "new.mp3")
    assert (path.stat().st_ino, path.stat().st_mtime_ns) == (
        stat.st_ino,
        stat.st_mtime_ns,
    )
    assert sorted(p.name for p in tmp_path.iterdir()) == ["old.mp3"]


@pytest.mark.skipif(shutil.which("rubberband") is None, reason="Rubber Band required")
def test_transformed_whole_song_persists_combined_suffix_title(
    tagged_mp3: bytes,
) -> None:
    options = SeparationOptions(pitch_semitones=-2.25, tempo_percent=112.5)
    job_id = db.insert_job("s1", "upload", "Source.mp3", options)
    job = db.get_job(job_id)
    assert job is not None
    job.original_key = "C major"
    (entry,) = queue._persist_results(job, {"song": StemResult(tagged_mp3, 0.3)})
    path = config.RESULTS_DIR / str(job_id) / entry.filename
    assert _probe(path)["format"]["tags"]["title"] == (
        "Source - song - source-key-C-major - pitch-2.25st - tempo112.5pct"
    )
    assert entry.size_bytes == path.stat().st_size


def test_native_http_history_download_has_title_and_preserves_original(
    tagged_mp3: bytes, tmp_path: Path
) -> None:
    # Real socket and Uvicorn, not an ASGI test transport: save exactly what an
    # external consumer downloads, then inspect it with the native tag reader.
    evidence = Path(os.environ.get("DOWNLOAD_METADATA_EVIDENCE_DIR", str(tmp_path)))
    evidence.mkdir(parents=True, exist_ok=True)
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    port = listener.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app, log_level="warning", loop="asyncio"))
    thread = threading.Thread(target=server.run, kwargs={"sockets": [listener]})
    thread.start()
    try:
        deadline = time.monotonic() + 10
        while not server.started:
            assert thread.is_alive() and time.monotonic() < deadline
            time.sleep(0.01)
        with httpx.Client(base_url=f"http://127.0.0.1:{port}") as browser:
            response = browser.post(
                "/api/jobs",
                files={"file": ("Artist - Song.mp3", tagged_mp3, "audio/mpeg")},
                data={"pitch_semitones": "2.5", "tempo_percent": "120"},
            )
            assert response.status_code == 200
            job_id = response.json()["id"]
            db.set_original_key(job_id, "Bb minor")
            directory = config.RESULTS_DIR / str(job_id)
            directory.mkdir(parents=True)
            path = directory / "vocals.mp3"
            # An old persisted result has a stale title and download_name.
            path.write_bytes(tagged_mp3)
            ID3(path).save(path, padding=lambda _: 0)
            legacy_size = path.stat().st_size
            db.mark_done(
                job_id,
                [
                    ResultManifestEntry(
                        label="vocals",
                        filename=path.name,
                        size_bytes=legacy_size,
                        duration_s=0.3,
                        download_name="obsolete.mp3",
                    )
                ],
            )
            history = browser.get("/api/jobs").json()[0]
            expected = history["manifest"][0]["download_name"]
            assert expected == (
                "Artist - Song - vocals - source-key-Bb-minor"
                " - pitch+2.5st - tempo120pct.mp3"
            )
            old_inode = path.stat().st_ino
            result = browser.get(f"/api/jobs/{job_id}/results/vocals")
            assert result.status_code == 200
            assert quote(expected) in result.headers["content-disposition"]
            assert len(result.content) != legacy_size
            assert int(result.headers["content-length"]) == len(result.content)
            refreshed = browser.get("/api/jobs").json()[0]["manifest"][0]
            assert refreshed["size_bytes"] == len(result.content)
            stored = db.get_job(job_id)
            assert stored is not None and stored.result_manifest is not None
            assert stored.result_manifest[0].size_bytes == len(result.content)
            assert db.total_result_bytes() == len(result.content)
            download = evidence / expected
            download.write_bytes(result.content)
            proof = _probe(download)
            assert proof["format"]["tags"]["title"] == expected.removesuffix(".mp3")
            source = evidence / "original.mp3"
            original = browser.get(f"/api/jobs/{job_id}/original")
            assert original.content == tagged_mp3
            source.write_bytes(original.content)
            assert proof["packets"] == _probe(source)["packets"]
            assert proof["format"]["tags"]["artist"] == "Original artist"
            assert proof["format"]["tags"]["album"] == "Original album"
            assert _tags(result.content)["APIC:cover"].data == b"cover"
            assert path.stat().st_ino != old_inode
            stat = path.stat()
            assert (
                browser.get(f"/api/jobs/{job_id}/results/vocals").content
                == result.content
            )
            assert path.stat().st_mtime_ns == stat.st_mtime_ns
            partial = browser.get(
                f"/api/jobs/{job_id}/results/vocals", headers={"Range": "bytes=0-127"}
            )
            assert partial.status_code == 206
            assert partial.content == result.content[:128]
            (evidence / "ffprobe.json").write_text(json.dumps(proof, indent=2))
            (evidence / "download-proof.json").write_text(
                json.dumps(
                    {
                        "url": str(result.url),
                        "filename": expected,
                        "headers": dict(result.headers),
                        "title": proof["format"]["tags"]["title"],
                        "original_byte_identical": True,
                        "audio_packets_identical": True,
                        "legacy_size_bytes": legacy_size,
                        "download_size_bytes": len(result.content),
                        "manifest_size_bytes": refreshed["size_bytes"],
                        "stored_size_bytes": stored.result_manifest[0].size_bytes,
                        "accounted_results_bytes": db.total_result_bytes(),
                        "range_status": partial.status_code,
                    },
                    indent=2,
                )
            )
    finally:
        server.should_exit = True
        thread.join(timeout=10)
        listener.close()
        assert not thread.is_alive()


def test_concurrent_result_size_updates_preserve_other_manifest_fields() -> None:
    job_id = db.insert_job("s1", "upload", "Source.mp3", SeparationOptions())
    labels = ("vocals", "instruments", "female-instruments", "song")
    manifest = [
        ResultManifestEntry(
            label=label,
            filename=f"{label}.mp3",
            size_bytes=1,
            duration_s=0.3,
            download_name=f"legacy-{label}.mp3",
        )
        for label in labels
    ]
    db.mark_done(job_id, manifest)
    before = db.get_job(job_id)
    assert before is not None
    with ThreadPoolExecutor(max_workers=4) as pool:
        list(
            pool.map(
                lambda item: db.update_result_size(job_id, item[1], item[0] + 100),
                enumerate(labels),
            )
        )
    after = db.get_job(job_id)
    assert after is not None and after.result_manifest is not None
    assert after.finished_at == before.finished_at
    for index, entry in enumerate(after.result_manifest):
        assert entry == manifest[index].model_copy(update={"size_bytes": index + 100})
    assert db.total_result_bytes() == sum(range(100, 104))
