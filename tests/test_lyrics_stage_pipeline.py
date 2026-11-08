"""Synthetic raw acoustic fixtures exercise real CPU policy, not neural accuracy."""

import io
import json
import wave
from array import array
from dataclasses import asdict, replace
from pathlib import Path

import pytest
from inference_fixture import fixture_manifest

from separator.artifact_cache import atomic_write, digest
from separator.inference import InferenceRequest
from separator.lyrics import (
    RecognitionChunk,
    TranscriptWord,
    recognition_transcript,
    transcript_export_text,
    transcript_from_json,
)
from separator.lyrics_reference import (
    AcousticEvidence,
    ReferenceLine,
    ReferenceReview,
    plan_reference,
)
from separator.pitch import (
    PitchAnalysis,
    PitchNote,
    PitchTrack,
    pitch_from_json,
    pitch_to_json,
    transform_analysis,
)
from separator.processing import ProcessingContext, _transcribe_source


def test_serialized_raw_evidence_keeps_source_clock_and_unknown_lyrics(
    tmp_path: Path,
) -> None:
    # An owned 16-kHz PCM carrier gives these synthetic model-boundary records
    # genuine, internally consistent source/PCM provenance. No ASR is run and
    # these invented words are not claimed to be recognized from this tone.
    samples = array("h", [0, 4096, 0, -4096]) * (50 * 16000 // 4)
    pcm = array("f", (value / 32768 for value in samples))
    stream = io.BytesIO()
    with wave.open(stream, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(16000)
        audio.writeframes(samples.tobytes())
    source = stream.getvalue()
    pcm_identity = [16000, "f", [len(pcm)], digest(memoryview(pcm))]
    manifest = fixture_manifest(tmp_path / "producer")

    def no_inference(request: InferenceRequest, key: str) -> bytes:
        raise AssertionError("Saved acoustic evidence must suffice for CPU assembly")

    context = ProcessingContext(tmp_path / "cache", manifest, no_inference)
    chunks = [
        RecognitionChunk(0, 25, 0, 25, "amber lanterns", "English"),
        RecognitionChunk(25, 50, 25, 50, "glow silver branches sway", "English"),
    ]
    word_start = 34.63176117411608
    note_start = 34.705
    alignments = [
        [
            TranscriptWord(24.0, 24.2, "amber", alignment_score=0.9),
            TranscriptWord(24.5, 24.7, "lanterns", alignment_score=0.9),
        ],
        [
            TranscriptWord(25.1, 25.4, "glow", alignment_score=0.02),
            TranscriptWord(
                word_start, 34.99200133422281, "silver", alignment_score=0.8
            ),
            TranscriptWord(35.1, 35.4, "branches", alignment_score=0.8),
            TranscriptWord(35.6, 35.9, "sway", alignment_score=0.8),
        ],
    ]
    raw_chunks = [asdict(chunk) for chunk in chunks]
    recognition = {
        "chunks": raw_chunks,
        "duration_s": 50.0,
        "pcm_identity": pcm_identity,
    }
    baseline = {
        "alignments": [[asdict(word) for word in words] for words in alignments],
        "duration_s": 50.0,
        "pcm_identity": pcm_identity,
    }
    review = ReferenceReview(
        "matched",
        "Synthetic canonical comparison",
        lines=[
            ReferenceLine("amber lanterns glow", group=0),
            ReferenceLine("silver branches sway", group=1),
            ReferenceLine("quiet gardens sleep", group=2),
        ],
    )
    original = recognition_transcript(
        chunks,
        alignments,
        str(manifest.versions["QWEN_MODEL"]),
        str(manifest.versions["ALIGNMENT_MODEL"]),
        0.03,
    )
    evidence = [word for words in alignments for word in words]
    planned, phrases = plan_reference(original, review, 50.0, evidence)
    # The weak third word completes the three-anchor minimum for the first
    # phrase. Filtering raw evidence at publication strength would lose it.
    assert [phrase.line_indices for phrase in phrases] == [[0], [1]]
    request_review = asdict(
        replace(
            planned,
            reason="",
            fetched_at=None,
            cached=False,
            original_segments=[],
            original_words=[],
            original_untimed=[],
        )
    )
    parameters = {
        "mode": "reference",
        "review": request_review,
        "phrases": [asdict(phrase) for phrase in phrases],
    }
    # Fixed saved evidence, not an inference callback that echoes requests.
    # Both aligned phrases retain their absolute recording-clock positions.
    reference = {
        "aligned_lines": {
            "0": [asdict(word) for word in evidence[:3]],
            "1": [asdict(word) for word in evidence[3:]],
        },
        "acoustic_evidence": {
            str(index): asdict(
                AcousticEvidence(
                    -0.1,
                    -0.2,
                    review.lines[index].text,
                    100,
                    "different acoustic hypothesis",
                    phrase.start_s,
                    phrase.end_s,
                )
            )
            for index, phrase in enumerate(phrases)
        },
    }
    records = [
        (context.key("recognition", digest(source)), recognition),
        (
            context.key(
                "alignment",
                ["recognition", pcm_identity, digest(json.dumps(raw_chunks).encode())],
            ),
            baseline,
        ),
        (context.key("alignment", [pcm_identity, parameters]), reference),
    ]
    for key, payload in records:
        atomic_write(
            context.root / "inference" / f"{key}.bin",
            json.dumps(payload, allow_nan=False).encode(),
        )

    result = _transcribe_source(source, context, review, asdict(review))
    restored = transcript_from_json(json.dumps(asdict(result)))
    assert restored.reference is not None
    assert [line.status for line in restored.reference.lines] == [
        "aligned",
        "aligned",
        "unconfirmed",
    ]
    assert restored.reference.lines[0].support == 1
    assert restored.reference.lines[0].unconfirmed_words == ["glow"]
    assert restored.reference.lines[2].start_s is None
    assert restored.reference.lines[2].end_s is None
    assert "[??:??] quiet gardens sleep" in transcript_export_text(restored)
    assert [word.text for word in restored.words] == [
        "amber",
        "lanterns",
        "silver",
        "branches",
        "sway",
    ]
    assert restored.reference.original_words == original.words
    assert [item.text for item in restored.reference.original_untimed] == ["glow"]
    assert restored.recognition_chunks == chunks
    assert restored.words[0].start_s == 24.0
    assert restored.words[2].start_s == word_start
    assert restored.reference.lines[0].end_s == 25.4
    assert restored.timestamp_reference == "original"

    source_pitch = PitchAnalysis(
        50,
        50,
        [
            PitchTrack(
                "vocals",
                [PitchNote(note_start, 34.965, 60, 261.625565, 0.9)],
            )
        ],
    )
    projected = pitch_from_json(
        pitch_to_json(
            transform_analysis(
                source_pitch, 0, 104, restored.words, restored.word_alignment
            )
        )
    )
    assert projected.words[2].start_s == pytest.approx(word_start / 1.04)
    note = projected.tracks[0].notes[0]
    assert note.start_s == pytest.approx(note_start / 1.04)
    assert note.word_indices == [2]
    assert projected.duration_s == pytest.approx(50 / 1.04)
    assert projected.source_duration_s == 50
    assert restored.words[2].start_s == word_start
    assert source_pitch.tracks[0].notes[0].start_s == note_start
