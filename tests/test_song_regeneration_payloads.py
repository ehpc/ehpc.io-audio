"""Queue capacity and atomic rich analysis publication through the real worker."""

import asyncio
from io import BytesIO

from audio_samples import tone_wav
from mutagen.id3 import ID3
from test_admin_regeneration import original

from backend import config, db, queue
from backend.metadata import ensure_download_title
from backend.models import ResultManifestEntry, download_filename
from separator.lyrics import Transcript, TranscriptSegment, TranscriptWord
from separator.options import SeparationOptions
from separator.pitch import PitchAnalysis, PitchNote, PitchTrack, pitch_to_json
from separator.processing import ProcessingResult
from separator.stems import StemResult


def _transcript(word):
    return Transcript(
        segments=[TranscriptSegment(0, 0.2, word)],
        words=[TranscriptWord(0, 0.2, word)],
        word_alignment="synthetic",
    )


def _pitch(word, midi, frequency):
    return pitch_to_json(
        PitchAnalysis(
            0.3,
            0.3,
            [
                PitchTrack(
                    "vocals",
                    [PitchNote(0, 0.2, midi, frequency, 0.9, word_indices=[0])],
                )
            ],
            words=[TranscriptWord(0, 0.2, word)],
            word_alignment="synthetic",
        )
    )


def test_single_global_slot_processes_all_song_variants(client, monkeypatch):
    owner = client.get("/api/auth/me").json()["id"]
    audio = tone_wav((440,), 0.3)
    jobs = [original(owner, audio, options=SeparationOptions())[0] for _ in range(3)]
    song = client.get("/api/admin/cache").json()["songs"][0]["id"]
    before = [db.get_job(job_id) for job_id in jobs]
    with db._session() as conn:
        conn.execute("INSERT INTO auth_settings VALUES ('global_queue', 1)")
    response = client.post("/api/admin/cache/regenerate", json={"ids": [song]})
    assert response.status_code == 200, response.text
    operation = response.json()["operations"][0]["operation_id"]
    assert response.json()["operations"][0]["total_jobs"] == 3
    monkeypatch.setattr(queue, "detect_key", lambda *args: None)
    for completed in range(3):
        with db._session() as conn:
            assert (
                conn.execute(
                    "SELECT COUNT(*) FROM jobs WHERE internal=1 "
                    "AND status IN ('queued','running')"
                ).fetchone()[0]
                == 1
            )
        work = db.claim_oldest_queued()
        assert work is not None
        asyncio.run(queue._run_job(work))
        status = next(
            s for s in db.regeneration_status() if s["operation_id"] == operation
        )
        assert status["completed_jobs"] == completed + 1
    assert status["status"] == "done"
    assert len(client.get("/api/jobs").json()) == 3
    for job_id, old in zip(jobs, before, strict=True):
        new = db.get_job(job_id)
        assert old is not None and new is not None
        assert (
            new.id,
            new.session_id,
            new.title,
            new.options,
            new.created_at,
            new.started_at,
            new.finished_at,
        ) == (
            old.id,
            old.session_id,
            old.title,
            old.options,
            old.created_at,
            old.started_at,
            old.finished_at,
        )
        assert new.result_generation is not None


def test_worker_publishes_lyrics_pitch_reference_and_key_together(client, monkeypatch):
    owner = client.get("/api/auth/me").json()["id"]
    audio = tone_wav((440,), 0.3)
    options = SeparationOptions(extract_lyrics=True, detect_pitch=True)
    job_id, song = original(owner, audio, options=options)
    directory = config.RESULTS_DIR / str(job_id)
    directory.mkdir(parents=True)
    output = directory / "drums-vocals.mp3"
    output.write_bytes(b"old audio")
    db.set_original_key(job_id, "D major")
    old_job = db.get_job(job_id)
    assert old_job is not None
    size = ensure_download_title(
        output,
        download_filename(old_job.title, job_id, "drums-vocals", options, "D major"),
    )
    (directory / ".pitch-vocals.mp3").write_bytes(b"old reference")
    db.mark_done(
        job_id,
        [
            ResultManifestEntry(
                label="drums-vocals",
                filename=output.name,
                size_bytes=size,
                duration_s=0.3,
            )
        ],
        _transcript("oldword"),
        _pitch("oldword", 60, 261.63),
    )
    base = f"/api/jobs/{job_id}"
    old_dto = client.get(base).json()
    old_audio = client.get(base + "/results/drums-vocals").content
    old_text = client.get(base + "/lyrics/download").text
    old_pitch = client.get(base + "/pitch").json()
    old_ref = client.get(base + "/pitch-reference/vocals").content
    assert "oldword" in old_text and old_ref == b"old reference"
    monkeypatch.setattr(queue, "detect_key", lambda *args: "C major")
    monkeypatch.setattr(
        queue,
        "process_source",
        lambda *args: (_ for _ in ()).throw(RuntimeError("injected analysis failure")),
    )
    response = client.post("/api/admin/cache/regenerate", json={"ids": [song]})
    assert response.status_code == 200
    work = db.claim_oldest_queued()
    assert work is not None
    asyncio.run(queue._run_job(work))
    assert db.regeneration_status()[0]["status"] == "failed"
    assert client.get(base).json() == old_dto
    assert client.get(base + "/results/drums-vocals").content == old_audio
    assert client.get(base + "/lyrics/download").text == old_text
    assert client.get(base + "/pitch").json() == old_pitch
    assert client.get(base + "/pitch-reference/vocals").content == old_ref
    new_transcript = _transcript("newword")
    new_pitch = _pitch("newword", 64, 329.63)
    monkeypatch.setattr(
        queue,
        "process_source",
        lambda *args: ProcessingResult(
            audio={"drums-vocals": StemResult(audio, 0.3)},
            transcript=new_transcript,
            pitch_json=new_pitch,
            pitch_vocals=b"new reference",
        ),
    )
    response = client.post("/api/admin/cache/regenerate", json={"ids": [song]})
    assert response.status_code == 200, response.text
    work = db.claim_oldest_queued()
    assert work is not None
    asyncio.run(queue._run_job(work))
    assert db.regeneration_status()[0]["status"] == "done"
    new_dto = client.get(base).json()
    assert new_dto["id"] == old_dto["id"] and new_dto["options"] == old_dto["options"]
    assert (
        new_dto["created_at"] == old_dto["created_at"]
        and new_dto["title"] == old_dto["title"]
    )
    assert new_dto["result_revision"] and new_dto["original_key"] == "C major"
    assert "newword" in client.get(base + "/lyrics/download").text
    assert client.get(base + "/pitch").json()["tracks"][0]["notes"][0]["midi"] == 64
    pitched = client.get(base + "/pitched-lyrics/vocals/download")
    assert pitched.status_code == 200 and "newword" in pitched.text
    assert client.get(base + "/pitch-reference/vocals").content == b"new reference"
    response = client.get(base + "/results/drums-vocals")
    assert (
        response.status_code == 200
        and "source-key-C-major" in response.headers["content-disposition"]
    )
    assert ID3(BytesIO(response.content))["TIT2"].text[0] == new_dto["manifest"][0][
        "download_name"
    ].removesuffix(".mp3")
    assert len(client.get("/api/jobs").json()) == 1
