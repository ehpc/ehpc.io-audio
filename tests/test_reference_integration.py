import asyncio
import json
import sqlite3
import subprocess
from array import array
from dataclasses import asdict, replace
from pathlib import Path

import pytest
from analysis_cpu import WORDS, frequencies, load, signal
from audio_samples import mp3_measurements, tone_wav
from fastapi.testclient import TestClient
from inference_fixture import cpu_inference, fixture_manifest
from mutagen.id3 import ID3, TALB, TIT2, TPE1

from backend import config, db, queue
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
    AcousticEvidence,
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
)
from separator.processing import ProcessingContext, ProcessingResult


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


def measured_reference_inference(request):
    """Measure tone intervals and score lyrics against independently decoded tones."""
    decoded = subprocess.run(
        [
            "ffmpeg",
            "-nostdin",
            "-v",
            "error",
            "-i",
            "pipe:0",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-f",
            "s16le",
            "pipe:1",
        ],
        input=request.audio_bytes,
        capture_output=True,
        check=True,
    ).stdout
    samples = array("h", decoded)
    intervals = frequencies(samples)
    decoded_words = [
        WORDS[min(range(4), key=lambda index: abs(hz - (220, 330, 440, 660)[index]))]
        for _, _, hz in intervals
    ]
    assert decoded_words == list(WORDS)
    phrase = request.parameters["phrases"][0]
    assert phrase["line_indices"] == [0]
    text = request.parameters["review"]["lines"][0]["text"]
    alternative = phrase["recognized_lines"][0]

    def score(candidate):
        return -0.01 - sum(
            actual != proposed
            for actual, proposed in zip(decoded_words, candidate.split(), strict=True)
        )

    words = [
        TranscriptWord(start, end, word, alignment_score=0.95)
        for (start, end, _), word in zip(intervals, text.split(), strict=True)
    ]
    evidence = AcousticEvidence(
        score(text),
        score(alternative),
        alternative,
        len(samples),
        alternative,
        phrase["start_s"],
        phrase["end_s"],
    )
    return json.dumps(
        {
            "aligned_lines": {"0": [asdict(word) for word in words]},
            "acoustic_evidence": {"0": asdict(evidence)},
        }
    ).encode()


def test_processing_uses_reference_aligned_words_for_pitch_and_preserves_asr_clock(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "source.wav"
    signal(source)
    samples, rate = load(source)
    intervals = frequencies(samples, rate)
    original_words = [
        TranscriptWord(start, end, text, alignment_score=0.99)
        for (start, end, _), text in zip(
            intervals, ("hello", "bright", "blue", "word"), strict=True
        )
    ]
    source_pitch = PitchAnalysis(
        1.5,
        1.5,
        [PitchTrack("vocals", [PitchNote(0.1, 0.35, 57, 220, 0.99)])],
    )
    producer = tmp_path / "producer"
    manifest = fixture_manifest(
        producer, transcript=Transcript(words=original_words), pitch=source_pitch
    )
    review = ReferenceReview(
        "matched",
        "Measured synthetic reference",
        source_url="https://lrclib.net/api/get/1",
        lines=[ReferenceLine("hello bright blue world")],
    )
    monkeypatch.setattr(
        processing, "lookup_reference", lambda *args: ReferenceLookup(None, review)
    )
    calls = []
    pitch_input_durations = []

    def infer(request, key):
        calls.append((request.operation, request.parameters.get("mode")))
        if request.operation == "pitch":
            pitch_input_durations.append(mp3_measurements(request.audio_bytes)[0])
        if (
            request.operation == "alignment"
            and request.parameters["mode"] == "reference"
        ):
            return measured_reference_inference(request)
        return cpu_inference(request, key, root=producer)

    context = ProcessingContext(tmp_path / "cache", manifest, infer)
    options = SeparationOptions(
        extract_lyrics=True, detect_pitch=True, pitch_semitones=1.25, tempo_percent=125
    )
    result = processing.run_processing(source, options, tmp_path, context)
    assert list(result.audio) == ["drums-vocals"]
    assert result.transcript is not None and result.transcript.reference is not None
    assert [word.text for word in result.transcript.words] == list(WORDS)
    assert result.transcript.reference.original_words == original_words
    assert result.transcript.reference.lines[0].status == "aligned"
    assert result.transcript.reference.lines[0].acoustic_log_odds is not None
    assert result.transcript.reference.lines[0].acoustic_log_odds > 0
    assert result.transcript.reference.source_url == review.source_url
    assert result.transcript.timestamp_reference == "original"
    assert result.transcript.words[0].start_s == pytest.approx(0.1, abs=0.01)
    assert result.pitch_json is not None
    pitch = pitch_from_json(result.pitch_json)
    assert pitch.words[-1].text == "world"
    assert pitch.words[0].start_s == pytest.approx(
        result.transcript.words[0].start_s / 1.25
    )
    assert pitch.tracks[0].notes[0].word_indices == [0]
    assert pitch.tracks[0].notes[0].note == "A#3"
    assert (
        transcript_from_json(json.dumps(asdict(result.transcript))) == result.transcript
    )
    assert calls == [
        ("separation", None),
        ("separation", None),
        ("separation", None),
        ("recognition", None),
        ("alignment", "recognition"),
        ("alignment", "reference"),
        ("structure", None),
        ("pitch", None),
    ]

    def forbidden(*args):
        raise AssertionError("source-clock cache hit invoked inference")

    context.infer = forbidden
    repeated = processing.run_processing(
        source,
        replace(options, pitch_semitones=12, tempo_percent=200),
        tmp_path,
        context,
    )
    assert repeated.transcript == result.transcript
    assert repeated.pitch_json is not None
    shifted = pitch_from_json(repeated.pitch_json)
    assert shifted.tracks[0].notes[0].note == "A4"
    assert shifted.tracks[0].notes[0].start_s == pytest.approx(
        pitch.tracks[0].notes[0].start_s * 1.25 / 2
    )
    assert shifted.words[0].start_s == pytest.approx(
        result.transcript.words[0].start_s / 2
    )
    assert pitch.source_duration_s == pytest.approx(
        pitch_input_durations[0], abs=1 / 16000
    )
    assert shifted.source_duration_s == pitch.source_duration_s
    assert shifted.duration_s == pytest.approx(pitch.source_duration_s / 2)


def test_changed_reference_reuses_raw_recognition_and_baseline_alignment(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "source.wav"
    signal(source)
    samples, rate = load(source)
    words = [
        TranscriptWord(start, end, text, alignment_score=0.99)
        for (start, end, _), text in zip(
            frequencies(samples, rate), ("hello", "bright", "blue", "word"), strict=True
        )
    ]
    producer = tmp_path / "producer"
    manifest = fixture_manifest(producer, transcript=Transcript(words=words))
    review = ReferenceReview(
        "matched",
        "Synthetic reference",
        lines=[ReferenceLine("hello bright blue word")],
    )
    monkeypatch.setattr(
        processing, "lookup_reference", lambda *args: ReferenceLookup(None, review)
    )
    calls = []

    def infer(request, key):
        calls.append((request.operation, request.parameters.get("mode")))
        if (
            request.operation == "alignment"
            and request.parameters["mode"] == "reference"
        ):
            return measured_reference_inference(request)
        return cpu_inference(request, key, root=producer)

    context = ProcessingContext(tmp_path / "cache", manifest, infer)
    first = processing.transcribe_source(source.read_bytes(), context, None)
    assert first.words[-1].text == "word"
    assert calls == [
        ("recognition", None),
        ("alignment", "recognition"),
        ("alignment", "reference"),
    ]
    review = replace(review, lines=[ReferenceLine("hello bright blue world")])

    def reference_only(request, key):
        assert request.operation == "alignment"
        assert request.parameters["mode"] == "reference"
        return infer(request, key)

    context.infer = reference_only
    corrected = processing.transcribe_source(source.read_bytes(), context, None)
    assert corrected.words[-1].text == "world"
    assert corrected.reference is not None and first.reference is not None
    assert corrected.reference.original_words == first.reference.original_words == words
    assert corrected.reference.lines[0].status == "aligned"
    assert len(calls) == 4

    def forbidden(*args):
        raise AssertionError("reference cache hit invoked inference")

    context.infer = forbidden
    review = replace(review, cached=True, reason="retrieved from cache")
    assert processing.transcribe_source(source.read_bytes(), context, None) == corrected


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
        queue, "process_source", lambda *args: ProcessingResult({}, transcript)
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
        queue, "process_source", lambda *args: ProcessingResult({}, result)
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


def test_historical_persistence_cannot_invent_model_identity_in_new_history(
    client: TestClient,
) -> None:
    source = Transcript(
        [TranscriptSegment(2, 3, "Amber lanterns")],
        language="English",
        asr_model="Qwen/Qwen3-ASR-1.7B",
        word_alignment="torchaudio/MMS_FA",
    )
    # Historical rows retain their original field set, without a transport shim.
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
    full = asdict(source)
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
