"""Real contract transformations: failed alignment cannot destroy recognized text."""

import json
import pickle
from dataclasses import asdict

import pytest

from separator.lyrics import (
    RecognitionChunk,
    TranscriptWord,
    recognition_transcript,
    transcript_export_text,
    transcript_from_json,
)
from separator.pitch import (
    PitchAnalysis,
    PitchNote,
    PitchTrack,
    pitch_from_json,
    pitch_to_json,
    transform_analysis,
)
from separator.processing import (
    ANALYSIS_SCHEMA_VERSION,
    ProcessingResult,
    analysis_transport,
)


def chunk(text: str, language: str = "English") -> RecognitionChunk:
    return RecognitionChunk(20, 47, 21, 46, text, language)


def test_unsupported_script_or_failed_alignment_is_untimed_not_chunk_start_onset():
    raw = chunk("unrepresented script text", "Thai")
    result = recognition_transcript(
        [raw], [[]], "Qwen/Qwen3-ASR-1.7B", "torchaudio/MMS_FA", 0.03
    )
    assert result.status == "recognized"
    assert result.recognition_chunks == [raw]
    assert result.segments == [] and result.words == []
    assert result.word_alignment is None
    assert result.untimed[0].text == raw.text
    text = transcript_export_text(result)
    assert "NO TIMESTAMPS" in text
    assert raw.text in text
    assert "[00:20]" not in text and "[00:21]" not in text
    assert transcript_from_json(json.dumps(asdict(result))) == result


def test_partial_and_low_score_alignment_preserves_complete_unprompted_raw_text():
    raw = chunk("Amber lanterns softly shine!")
    good = TranscriptWord(30, 31, "amber", alignment_score=0.8)
    weak = TranscriptWord(32, 33, "lanterns", alignment_score=0.001)
    result = recognition_transcript(
        [raw], [[good, weak]], "Qwen/Qwen3-ASR-1.7B", "torchaudio/MMS_FA", 0.03
    )
    assert result.recognition_chunks[0].text == "Amber lanterns softly shine!"
    assert result.words == [good]
    assert result.untimed[0].text == raw.text
    assert result.words[0].probability is None
    assert "Incomplete alignment" in result.untimed[0].reason
    assert pickle.loads(pickle.dumps(result)) == result


def test_overlapping_input_windows_publish_each_owned_word_once_without_moving_times():
    first = RecognitionChunk(0, 26, 0, 25, "amber lanterns", "English")
    second = RecognitionChunk(24, 51, 25, 50, "lanterns softly", "English")
    amber = TranscriptWord(23, 24, "amber", alignment_score=0.8)
    lanterns = TranscriptWord(24.8, 25.6, "lanterns", alignment_score=0.8)
    softly = TranscriptWord(27, 28, "softly", alignment_score=0.8)
    result = recognition_transcript(
        [first, second],
        [[amber, lanterns], [lanterns, softly]],
        "Qwen/Qwen3-ASR-1.7B",
        "torchaudio/MMS_FA",
        0.03,
    )
    assert result.words == [amber, lanterns, softly]
    assert result.recognition_chunks == [first, second]
    assert [(word.start_s, word.end_s) for word in result.words] == [
        (23, 24),
        (24.8, 25.6),
        (27, 28),
    ]


def test_canonical_null_confidence_and_ctc_evidence_survive_transformed_pitch_links():
    word = TranscriptWord(2, 4, "lanterns", alignment_score=0.71)
    source = PitchAnalysis(
        8, 8, [PitchTrack("vocals", [PitchNote(2, 3, 60, 261.6256, 0.9)])]
    )
    result = transform_analysis(source, 1.25, 125, [word], "torchaudio/MMS_FA")
    assert result.words[0].start_s == 1.6
    assert result.words[0].end_s == 3.2
    assert result.words[0].probability is None
    assert result.words[0].alignment_score == 0.71
    assert result.word_alignment == "torchaudio/MMS_FA"
    assert result.tracks[0].notes[0].word_indices == [0]
    assert pitch_from_json(pitch_to_json(result)) == result


def test_single_schema_boundary_never_fabricates_legacy_confidence_or_word_links():
    word = TranscriptWord(30, 31, "amber", alignment_score=0.8)
    transcript = recognition_transcript(
        [chunk("amber")], [[word]], "Qwen/Qwen3-ASR-1.7B", "torchaudio/MMS_FA", 0.03
    )
    pitch = PitchAnalysis(
        50,
        50,
        [PitchTrack("vocals", [PitchNote(30, 31, 60, 261.6256, 0.9, [0])])],
        [word],
        word_alignment="torchaudio/MMS_FA",
    )
    original = ProcessingResult({}, transcript, pitch_to_json(pitch))
    assert analysis_transport(original, ANALYSIS_SCHEMA_VERSION) is original
    old = analysis_transport(original, 1)
    assert old.transcript is not None
    assert old.transcript.segments == transcript.segments
    assert old.transcript.words == [] and old.transcript.reference is None
    assert old.pitch_json is not None
    legacy_pitch = pitch_from_json(old.pitch_json)
    assert legacy_pitch.words == []
    assert legacy_pitch.word_alignment is None
    assert legacy_pitch.tracks[0].notes[0].word_indices == []
    with pytest.raises(ValueError, match="schema"):
        analysis_transport(original, 999)
