import asyncio
import json
import pickle
import sqlite3
import subprocess
from dataclasses import asdict, replace
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from audio_samples import tone_wav
from fastapi.testclient import TestClient
from mutagen.id3 import ID3, TALB, TIT2, TPE1

from backend import config, db, modal_client, queue
from backend.source_metadata import reference_metadata
from separator import processing
from separator.lyrics import (
    RecognitionChunk,
    Transcript,
    TranscriptSegment,
    TranscriptWord,
    UntimedRecognition,
    transcript_from_json,
)
from separator.lyrics_reference import (
    HistoricalReferenceCorrection,
    ReferenceLine,
    ReferenceLookup,
    ReferenceMetadata,
    ReferenceReview,
    apply_reference,
)
from separator.options import SeparationOptions
from separator.pitch import (
    PitchAnalysis,
    PitchNote,
    PitchTrack,
    pitch_from_json,
    pitch_to_json,
)
from separator.processing import ProcessingResult
from separator.stems import StemResult


def test_only_actual_tags_or_structured_music_fields_identify_a_reference(
    tmp_path: Path,
) -> None:
    source = tmp_path / "artist - title.mp3"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-i", "pipe:0", "-y", str(source)],
        input=tone_wav((440,), 4),
        check=True,
        capture_output=True,
    )
    assert reference_metadata(source.read_bytes()) is None
    tags = ID3(source)
    tags.add(TPE1(encoding=3, text=["Real artist"]))
    tags.add(TIT2(encoding=3, text=["Real track"]))
    tags.add(TALB(encoding=3, text=["Real album"]))
    tags.save(source)
    actual = reference_metadata(source.read_bytes())
    assert actual is not None
    assert (actual.artist, actual.title, actual.album) == (
        "Real artist",
        "Real track",
        "Real album",
    )
    assert 4 <= actual.duration_s < 4.1
    sidecar = tmp_path / "metadata.json"
    sidecar.write_text(
        json.dumps(
            {
                "uploader": "Do not trust",
                "creator": "Do not trust",
                "title": "Video title",
                "duration": 4,
            }
        )
    )
    # Downloaded uploader-derived tags must not override absent music metadata.
    assert reference_metadata(source.read_bytes(), downloaded_metadata=sidecar) is None
    sidecar.write_text(
        json.dumps(
            {
                "artist": "Music artist",
                "track": "Music track",
                "album": "Music album",
                "duration": 4,
            }
        )
    )
    assert reference_metadata(
        source.read_bytes(), downloaded_metadata=sidecar
    ) == ReferenceMetadata("Music artist", "Music track", 4, "Music album")
    assert reference_metadata(b"invalid") is None


def test_processing_uses_reference_aligned_words_for_pitch_and_preserves_asr_clock(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    original_word = TranscriptWord(2, 3, "morninx", 0.3)
    corrected_word = replace(original_word, text="morning")
    original = Transcript(
        [TranscriptSegment(2, 3, "morninx")], language="en", words=[original_word]
    )
    review = ReferenceReview(
        "aligned",
        "Reference-aligned, not verified.",
        source_url="https://lrclib.net/api/get/1",
        lines=[ReferenceLine("morning", "aligned", 1, 2, 3)],
        original_segments=original.segments,
        original_words=original.words,
    )
    monkeypatch.setattr(
        processing,
        "run_separation",
        lambda *args: {"vocals": StemResult(b"original-vocal", 1)},
    )
    canonical = replace(
        original,
        segments=[replace(original.segments[0], text="morning")],
        words=[corrected_word],
        reference=review,
        word_alignment="torchaudio/MMS_FA",
    )
    monkeypatch.setattr(
        processing,
        "lookup_reference",
        lambda *args: ReferenceLookup(None, review),
    )

    def child(command, **kwargs):
        module = command[2]
        if module == "separator.transcribe":
            assert (
                json.loads(Path(command[6]).read_text())["source_url"]
                == review.source_url
            )
            Path(command[5]).write_text(json.dumps(asdict(canonical)))
        elif module == "separator.structure":
            Path(command[5]).write_text(
                json.dumps({"sections": [], "structure_model": "test"})
            )
        elif module == "separator.detect_pitch":
            sources = json.loads(Path(command[3]).read_text())
            assert list(sources) == ["vocals"]
            assert Path(sources["vocals"]).read_bytes() == b"original-vocal"
            Path(command[4]).write_text(
                pitch_to_json(
                    PitchAnalysis(
                        5,
                        5,
                        [PitchTrack("vocals", [PitchNote(2, 3, 60, 261.6256, 0.9)])],
                    )
                )
            )
        else:
            raise AssertionError(module)
        return subprocess.CompletedProcess(command, 0)

    monkeypatch.setattr(processing.subprocess, "run", child)
    (tmp_path / "source.mp3").write_bytes(b"original-source")
    result = processing.run_processing(
        tmp_path / "source.mp3",
        SeparationOptions(
            extract_lyrics=True,
            detect_pitch=True,
            pitch_semitones=1.25,
            tempo_percent=125,
        ),
        tmp_path,
        str(tmp_path / "models"),
        str(tmp_path / "cache"),
        60,
    )
    assert result.audio == {}
    assert result.transcript is not None
    assert result.transcript.words == [corrected_word]
    assert result.transcript.reference == review
    assert result.transcript.timestamp_reference == "original"
    assert result.pitch_json is not None
    pitch = pitch_from_json(result.pitch_json)
    assert pitch.words[0].text == "morning"
    assert pitch.words[0].start_s == 1.6
    assert pitch.tracks[0].notes[0].word_indices == [0]
    assert pitch.tracks[0].notes[0].note == "C#4"
    encoded = pickle.dumps(result.transcript)
    assert b"ReferenceReview" not in encoded
    assert b"TranscriptWord" not in encoded
    assert (
        transcript_from_json(json.dumps(asdict(result.transcript))) == result.transcript
    )

    def no_child(*args, **kwargs):
        raise AssertionError("source-clock cache hit spawned an analysis process")

    monkeypatch.setattr(processing.subprocess, "run", no_child)
    repeated = processing.run_processing(
        tmp_path / "source.mp3",
        SeparationOptions(
            extract_lyrics=True,
            detect_pitch=True,
            pitch_semitones=12,
            tempo_percent=200,
        ),
        tmp_path,
        str(tmp_path / "models"),
        str(tmp_path / "cache"),
        60,
    )
    assert repeated.transcript == result.transcript
    assert repeated.pitch_json is not None
    shifted = pitch_from_json(repeated.pitch_json)
    assert shifted.tracks[0].notes[0].note == "C5"
    assert shifted.tracks[0].notes[0].start_s == 1
    assert shifted.words[0].start_s == 1
    assert shifted.source_duration_s == 5


def test_review_provenance_json_download_and_history_preserve_original_asr(
    client: TestClient, other_client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    original = TranscriptSegment(1.2, 3, "Good morninx to you")
    words = [
        TranscriptWord(1.2, 1.5, "Good", 0.9),
        TranscriptWord(1.5, 2.2, "morninx", 0.3),
        TranscriptWord(2.2, 2.5, "to", 0.9),
        TranscriptWord(2.5, 3, "you", 0.9),
    ]
    review = ReferenceReview(
        "corrected",
        "Tentative correction, not verified lyrics.",
        source_url="https://lrclib.net/api/get/1",
        record_id=1,
        artist="Artist",
        title="Track",
        agreement=0.98,
        corrections=[HistoricalReferenceCorrection(1, "morninx", "morning", 1.5, 2.2)],
        original_segments=[original],
        original_words=words,
    )
    transcript = Transcript(
        [replace(original, text="Good morning to you")],
        language="en",
        words=[
            replace(word, text="morning") if word.text == "morninx" else word
            for word in words
        ],
        reference=review,
    )
    job_id = client.post(
        "/api/jobs",
        files={"file": ("song.wav", b"source", "audio/wav")},
        data={"extract_lyrics": "true"},
    ).json()["id"]
    monkeypatch.setattr(queue, "detect_key", lambda *args: None)
    monkeypatch.setattr(
        modal_client,
        "spawn_with_lyrics",
        lambda *args: MagicMock(object_id="fc-review"),
    )
    monkeypatch.setattr(
        modal_client, "poll", lambda *args: ProcessingResult({}, transcript)
    )
    job = db.get_job(job_id)
    assert job is not None
    asyncio.run(queue._run_job(job))
    payload = client.get(f"/api/jobs/{job_id}/lyrics").json()
    assert payload["timestamped_text"] == (
        "Artist — Track\n[00:01] Good morning to you\n"
    )
    assert payload["original_timestamped_text"] == "[00:01] Good morninx to you\n"
    assert payload["reference"]["original_words"][1]["text"] == "morninx"
    assert (
        payload["words"][1]["start_s"]
        == payload["reference"]["original_words"][1]["start_s"]
    )
    download = client.get(f"/api/jobs/{job_id}/lyrics/download.json")
    assert download.json() == payload
    assert "lyrics.json" in download.headers["content-disposition"]
    assert (
        client.get(f"/api/jobs/{job_id}/lyrics/download").text
        == payload["timestamped_text"]
    )
    db.init_db()
    assert client.get("/api/jobs").json()[0]["transcript"] == payload
    assert client.get("/api/jobs").json()[0]["transcript"]["reference"][
        "corrections"
    ] == [
        {
            "word_index": 1,
            "original": "morninx",
            "replacement": "morning",
            "start_s": 1.5,
            "end_s": 2.2,
        }
    ]
    assert (
        other_client.get(f"/api/jobs/{job_id}/lyrics/download.json").status_code == 404
    )


def test_historical_review_survives_history_and_download_without_row_rewrite(
    client: TestClient,
    other_client: TestClient,
) -> None:
    job_id = client.post(
        "/api/jobs",
        files={"file": ("historical.wav", b"historical-source", "audio/wav")},
    ).json()["id"]
    # Persist the previous release's actual field shape, not today's dataclass
    # with defaults. Legacy correction provenance is historical evidence.
    legacy = {
        "segments": [{"start_s": 1, "end_s": 2, "text": "Good morning"}],
        "language": "en",
        "timestamp_reference": "original",
        "sections": [],
        "structure_model": None,
        "status": "recognized",
        "words": [{"start_s": 1, "end_s": 2, "text": "morning", "probability": 0.3}],
        "reference": {
            "status": "corrected",
            "reason": "Tentative correction.",
            "provider": "LRCLIB",
            "source_url": "https://lrclib.net/api/get/1",
            "record_id": 1,
            "artist": "Artist",
            "title": "Track",
            "album": None,
            "duration_s": 4,
            "agreement": 0.98,
            "corrections": [
                {
                    "word_index": 0,
                    "original": "morninx",
                    "replacement": "morning",
                    "start_s": 1,
                    "end_s": 2,
                }
            ],
            "original_segments": [{"start_s": 1, "end_s": 2, "text": "Good morninx"}],
            "original_words": [
                {"start_s": 1, "end_s": 2, "text": "morninx", "probability": 0.3}
            ],
        },
    }
    stored = json.dumps(legacy)
    with sqlite3.connect(config.DB_PATH) as connection:
        connection.execute(
            "UPDATE jobs SET status='done', transcript_json=?, "
            "result_manifest_json='[]' WHERE id=?",
            (stored, job_id),
        )
    db.init_db()
    payload = client.get(f"/api/jobs/{job_id}/lyrics").json()
    assert payload["reference"]["status"] == "corrected"
    assert payload["reference"]["corrections"] == legacy["reference"]["corrections"]
    assert payload["reference"]["original_words"][0]["text"] == "morninx"
    assert payload["original_timestamped_text"] == "[00:01] Good morninx\n"
    assert payload["asr_model"] is None
    assert payload["word_alignment"] is None
    assert payload["words"] == [
        {
            "start_s": 1,
            "end_s": 2,
            "text": "morning",
            "probability": 0.3,
            "alignment_score": None,
            "origin": "asr",
        }
    ]
    assert (
        client.get(f"/api/jobs/{job_id}/lyrics/download").text
        == "Artist — Track\n[00:01] Good morning\n"
    )
    assert client.get(f"/api/jobs/{job_id}/lyrics/download.json").json() == payload
    assert client.get("/api/jobs").json()[0]["transcript"] == payload
    assert other_client.get(f"/api/jobs/{job_id}/lyrics").status_code == 404
    assert client.get(f"/api/jobs/{job_id}/original").content == b"historical-source"
    with sqlite3.connect(config.DB_PATH) as connection:
        assert (
            connection.execute(
                "SELECT transcript_json FROM jobs WHERE id=?",
                (job_id,),
            ).fetchone()[0]
            == stored
        )


def test_reference_first_json_txt_history_and_privacy_keep_raw_and_untimed_provenance(
    client: TestClient,
    other_client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    original_words = [
        TranscriptWord(1, 1.5, "Amber", alignment_score=0.8),
        TranscriptWord(1.5, 2, "lanterns", alignment_score=0.8),
        TranscriptWord(2.5, 3, "shine", alignment_score=0.8),
    ]
    original = Transcript(
        [TranscriptSegment(1, 3, "Amber lanterns shine")],
        language="English",
        words=original_words,
        recognition_chunks=[
            RecognitionChunk(0, 4, 0, 4, "Amber lanterns shine hmm", "English")
        ],
        untimed=[UntimedRecognition("hmm", "Insufficient acoustic evidence")],
        asr_model="Qwen/Qwen3-ASR-1.7B",
        word_alignment="torchaudio/MMS_FA",
    )
    canonical = [
        original_words[0],
        original_words[1],
        TranscriptWord(2, 2.5, "softly", alignment_score=0.8),
        original_words[2],
    ]
    result = apply_reference(
        original,
        ReferenceReview(
            "matched",
            "Synthetic policy fixture",
            provider="Synthetic fixture",
            lines=[
                ReferenceLine("Amber lanterns softly shine"),
                ReferenceLine("Silver branches sway"),
            ],
        ),
        {0: canonical},
    )
    job_id = client.post(
        "/api/jobs",
        files={"file": ("source.wav", b"unaltered-source", "audio/wav")},
        data={"extract_lyrics": "true"},
    ).json()["id"]
    monkeypatch.setattr(queue, "detect_key", lambda *args: None)
    monkeypatch.setattr(
        modal_client,
        "spawn_with_lyrics",
        lambda *args: MagicMock(object_id="fc-canonical"),
    )
    monkeypatch.setattr(
        modal_client, "poll", lambda *args: ProcessingResult({}, result)
    )
    job = db.get_job(job_id)
    assert job is not None
    asyncio.run(queue._run_job(job))
    payload = client.get(f"/api/jobs/{job_id}/lyrics").json()
    assert payload["reference"]["status"] == "partial"
    assert payload["reference"]["lines"][0]["unconfirmed_words"] == ["softly"]
    assert payload["reference"]["lines"][1]["start_s"] is None
    assert payload["words"][0]["probability"] is None
    assert payload["words"][0]["alignment_score"] == 0.8
    assert payload["recognition_chunks"][0]["text"] == "Amber lanterns shine hmm"
    assert payload["reference"]["original_untimed"][0]["text"] == "hmm"
    assert payload["untimed"] == []
    text = client.get(f"/api/jobs/{job_id}/lyrics/download").text
    assert text == payload["timestamped_text"]
    assert text.startswith("source\n")
    assert "[00:01] Amber lanterns softly shine" in text
    assert "[??:??] Silver branches sway" in text
    assert "NOT verified" not in text
    assert "Word-level timing uncertainty" not in text
    assert "NO WORD TIMESTAMPS" not in text
    assert "Reference source" not in text
    assert "hmm" in payload["original_timestamped_text"]
    assert client.get(f"/api/jobs/{job_id}/lyrics/download.json").json() == payload
    db.init_db()
    assert client.get("/api/jobs").json()[0]["transcript"] == payload
    assert client.get(f"/api/jobs/{job_id}/original").content == b"unaltered-source"
    assert other_client.get(f"/api/jobs/{job_id}/lyrics/download").status_code == 404
    assert (
        other_client.get(f"/api/jobs/{job_id}/lyrics/download.json").status_code == 404
    )


def test_gpu_first_old_persistence_cannot_invent_model_identity_in_new_history(
    client: TestClient,
) -> None:
    source = Transcript(
        [TranscriptSegment(2, 3, "Amber lanterns")],
        language="English",
        asr_model="Qwen/Qwen3-ASR-1.7B",
        word_alignment="torchaudio/MMS_FA",
    )
    transported = processing.analysis_transport(
        processing.ProcessingResult({}, source), 1
    ).transcript
    assert transported is not None
    # Exact pre-schema field set retained by the frozen 8e479ec reader/asdict.
    # New model fields are not persisted by that old consumer.
    old_fields = (
        "segments",
        "language",
        "timestamp_reference",
        "sections",
        "structure_model",
        "words",
        "reference",
        "status",
    )
    full = asdict(transported)
    stored = json.dumps({key: full[key] for key in old_fields})
    job_id = client.post(
        "/api/jobs",
        files={"file": ("transition.wav", b"immutable-source", "audio/wav")},
    ).json()["id"]
    with sqlite3.connect(config.DB_PATH) as connection:
        connection.execute(
            "UPDATE jobs SET status='done', transcript_json=?, "
            "result_manifest_json='[]' WHERE id=?",
            (stored, job_id),
        )
    history = client.get("/api/jobs").json()[0]["transcript"]
    assert history["asr_model"] is None and history["word_alignment"] is None
    assert history["timestamped_text"] == "transition\n[00:02] Amber lanterns\n"
    assert client.get(f"/api/jobs/{job_id}/lyrics/download.json").json() == history
    assert client.get(f"/api/jobs/{job_id}/lyrics/download").text == (
        "transition\n[00:02] Amber lanterns\n"
    )
    with sqlite3.connect(config.DB_PATH) as connection:
        assert (
            connection.execute(
                "SELECT transcript_json FROM jobs WHERE id=?", (job_id,)
            ).fetchone()[0]
            == stored
        )
