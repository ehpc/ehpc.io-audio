import asyncio
import json
import pickle
import subprocess
from dataclasses import asdict, replace
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from audio_samples import tone_wav
from fastapi.testclient import TestClient
from mutagen.id3 import ID3, TALB, TIT2, TPE1

from backend import db, modal_client, queue
from backend.source_metadata import reference_metadata
from separator import processing
from separator.lyrics import (
    Transcript,
    TranscriptSegment,
    TranscriptWord,
    transcript_from_json,
)
from separator.lyrics_reference import (
    ReferenceCorrection,
    ReferenceMetadata,
    ReferenceResult,
    ReferenceReview,
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


def test_processing_uses_reviewed_words_for_pitch_but_preserves_original_asr_clock(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    original_word = TranscriptWord(2, 3, "morninx", 0.3)
    corrected_word = replace(original_word, text="morning")
    original = Transcript(
        [TranscriptSegment(2, 3, "morninx")], language="en", words=[original_word]
    )
    review = ReferenceReview(
        "corrected",
        "Tentative spelling correction",
        source_url="https://lrclib.net/api/get/1",
        corrections=[ReferenceCorrection(0, "morninx", "morning", 2, 3)],
        original_segments=original.segments,
        original_words=original.words,
    )
    monkeypatch.setattr(
        processing,
        "run_separation",
        lambda *args: {"vocals": StemResult(b"original-vocal", 1)},
    )
    monkeypatch.setattr(
        processing,
        "review_lyrics",
        lambda transcript, metadata: ReferenceResult(
            [replace(original.segments[0], text="morning")], [corrected_word], review
        ),
    )

    def child(command, **kwargs):
        module = command[2]
        if module == "separator.transcribe":
            Path(command[5]).write_text(json.dumps(asdict(original)))
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
    result = processing.run_processing(
        tmp_path / "source.mp3",
        SeparationOptions(
            extract_lyrics=True,
            detect_pitch=True,
            pitch_semitones=1.25,
            tempo_percent=125,
        ),
        tmp_path,
        "models",
        "cache",
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
        corrections=[ReferenceCorrection(1, "morninx", "morning", 1.5, 2.2)],
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
    assert payload["timestamped_text"] == "[00:01] Good morning to you\n"
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
    assert (
        other_client.get(f"/api/jobs/{job_id}/lyrics/download.json").status_code == 404
    )
