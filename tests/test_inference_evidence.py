"""Deterministic evidence-policy regressions without neural dependencies."""

import hashlib
import io
import json
import zipfile
from array import array
from dataclasses import asdict, replace
from typing import TYPE_CHECKING, cast

import numpy as np
import pytest

from separator import inference_runtime, lyrics, lyrics_reference
from separator.inference import InferenceRequest
from separator.inference_runtime import run_inference
from separator.lyrics import RecognitionChunk, TranscriptWord
from separator.lyrics_reference import ReferenceLine, ReferencePhrase, ReferenceReview
from separator.pitch import (
    FRAME_SECONDS,
    PitchAnalysis,
    PitchTrack,
    _pitch_rms,
    assemble_pitch_prediction,
    segment_frames,
)
from separator.structure import assemble_structure
from separator.transcribe import SAMPLE_RATE, align_reference_acoustics

if TYPE_CHECKING:
    from separator.align_lyrics import VocalAligner


class Emission:
    def __init__(self, start=0, end=80):
        self.start = start
        self.end = end
        self.shape = (end - start,)

    def __getitem__(self, interval):
        return Emission(self.start + interval.start, self.start + interval.stop)


class RecordingAligner:
    """Observe exact contexts and score hypotheses at the acoustic boundary."""

    def __init__(self, *, incomplete=False, nonfinite=False):
        self.calls = []
        self.incomplete = incomplete
        self.nonfinite = nonfinite

    def emissions(self, audio):
        self.calls.append(("emissions", len(audio)))
        return Emission(), len(audio) / SAMPLE_RATE / 80

    def align(self, emission, frame_s, text, offset):
        self.calls.append(("align", text, offset))
        words = [
            TranscriptWord(offset + 1, offset + 2, "amber", alignment_score=0.9),
            TranscriptWord(offset + 3, offset + 4, "blue", alignment_score=0.8),
        ]
        return words[:1] if self.incomplete else words

    def search(self, emission, frame_s, text, offset, start, end):
        self.calls.append(("search", text, offset, start, end))
        onset = offset + (1 if text == "amber" else 3)
        return [TranscriptWord(onset, onset + 1, text, alignment_score=0.9)]

    def log_score(self, emission, text):
        self.calls.append(("score", emission.start, emission.end, text))
        if self.nonfinite:
            return float("-inf")
        return -0.1 if text in {"amber", "blue", "amber\nblue"} else -0.5


def candidates(*, timed=False):
    review = ReferenceReview(
        status="matched",
        reason="Prepared on the VPS",
        lines=[
            ReferenceLine("amber", provider_start_s=2.5, provider_end_s=3.5),
            ReferenceLine("blue", provider_start_s=3.0, provider_end_s=6.0),
        ],
        provider_timing_status="validated" if timed else "absent",
    )
    phrase = ReferencePhrase([0, 1], 2, 12, "amber\nblue", ["ember", "blew"])
    return review, [phrase]


def test_untimed_candidates_score_full_phrase_without_planning(monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("GPU evidence must not plan or accept references")

    monkeypatch.setattr(lyrics_reference, "plan_reference", forbidden)
    monkeypatch.setattr(lyrics_reference, "apply_reference", forbidden)
    review, phrases = candidates()
    aligner = RecordingAligner()
    aligned, evidence = align_reference_acoustics(
        np.zeros(15 * SAMPLE_RATE, dtype=np.float32),
        cast("VocalAligner", aligner),
        review,
        phrases,
    )
    assert [word.text for words in aligned.values() for word in words] == [
        "amber",
        "blue",
    ]
    assert aligner.calls == [
        ("emissions", 10 * SAMPLE_RATE),
        ("align", "amber\nblue", 2.0),
        ("score", 0, 80, "amber\nblue"),
        ("score", 0, 80, "ember\nblue"),
        ("score", 0, 80, "amber\nblew"),
    ]
    for index, alternative in enumerate(["ember", "blew"]):
        item = evidence[index]
        assert item.frame_count == 80
        assert (item.context_start_s, item.context_end_s) == (2, 12)
        assert item.alternative_text == alternative
        assert item.recognized_text == alternative
        assert item.canonical_log_score == -0.1
        assert item.alternative_log_score == -0.5
        assert item.log_odds == pytest.approx(32)


def test_provider_search_preserves_previous_end_and_shared_scoring_interval():
    review, phrases = candidates(timed=True)
    aligner = RecordingAligner()
    _, evidence = align_reference_acoustics(
        np.zeros(15 * SAMPLE_RATE, dtype=np.float32),
        cast("VocalAligner", aligner),
        review,
        phrases,
    )
    searches = [call for call in aligner.calls if call[0] == "search"]
    assert searches == [
        ("search", "amber", 2.0, 1.75, 4.25),
        ("search", "blue", 2.0, 4.0, 6.75),
    ]
    scores = [call for call in aligner.calls if call[0] == "score"]
    assert scores == [
        ("score", 0, 80, "amber\nblue"),
        ("score", 7, 17, "amber"),
        ("score", 7, 17, "ember"),
        ("score", 23, 33, "blue"),
        ("score", 23, 33, "blew"),
    ]
    assert evidence[0].frame_count == 10
    assert evidence[1].frame_count == 10
    assert evidence[0].context_start_s == pytest.approx(2.85)
    assert evidence[0].context_end_s == pytest.approx(4.15)


def test_partial_phrase_and_nonfinite_scores_never_invent_evidence():
    review, phrases = candidates()
    partial = RecordingAligner(incomplete=True)
    assert align_reference_acoustics(
        np.zeros(15 * SAMPLE_RATE, dtype=np.float32),
        cast("VocalAligner", partial),
        review,
        phrases,
    ) == ({}, {})
    assert not any(call[0] == "score" for call in partial.calls)
    aligned, evidence = align_reference_acoustics(
        np.zeros(15 * SAMPLE_RATE, dtype=np.float32),
        cast("VocalAligner", RecordingAligner(nonfinite=True)),
        review,
        phrases,
    )
    assert set(aligned) == {0, 1}
    assert evidence == {}


def test_previous_candidate_end_carries_across_phrase_boundaries(monkeypatch):
    review, phrases = candidates(timed=True)
    first = replace(
        phrases[0], line_indices=[0], text="amber", recognized_lines=["ember"]
    )
    second = replace(first, line_indices=[1], text="blue", recognized_lines=["blew"])
    aligner = RecordingAligner()

    def one_word_alignment(emission, frame_s, text, offset):
        return [TranscriptWord(3, 4, text, alignment_score=0.9)]

    monkeypatch.setattr(aligner, "align", one_word_alignment)
    align_reference_acoustics(
        np.zeros(15 * SAMPLE_RATE, dtype=np.float32),
        cast("VocalAligner", aligner),
        review,
        [first, second],
    )
    searches = [call for call in aligner.calls if call[0] == "search"]
    assert searches[1] == ("search", "blue", 2.0, 4.0, 6.75)


@pytest.mark.parametrize("sample_count", [1, 511, 512, 513, 15999, 16000, 16001])
def test_cpu_pitch_assembly_matches_original_numpy_rms(sample_count):
    sample_rate = 16000
    frame_count = sample_count // 160 + 1
    audio = (0.002 * np.sin(np.arange(sample_count) * 0.17)).astype("<f4")
    audio[: sample_count // 3] = 0
    frequencies = np.full(frame_count, 440, dtype="<f4")
    periodicities = np.full(frame_count, 0.9, dtype="<f4")
    duration_s = sample_count / sample_rate
    # Independent oracle: the original detector's exact NumPy implementation.
    squared = np.pad(audio.astype(np.float64) ** 2, (512, 512))
    cumulative = np.concatenate(([0.0], np.cumsum(squared)))
    starts = np.arange(frame_count) * int(sample_rate * FRAME_SECONDS)
    ends = np.minimum(starts + 1024, squared.size)
    levels = np.sqrt((cumulative[ends] - cumulative[starts]) / 1024)
    np.testing.assert_array_equal(
        _pitch_rms(audio.tolist(), frame_count, sample_rate), levels
    )
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w") as archive:
        archive.writestr("audio.f32", audio.tobytes())
        archive.writestr("pitch.f32", frequencies.tobytes())
        archive.writestr("periodicity.f32", periodicities.tobytes())
        archive.writestr(
            "metadata.json",
            json.dumps({"sample_rate": sample_rate, "duration_s": duration_s}),
        )
    expected = PitchAnalysis(
        duration_s,
        duration_s,
        [
            PitchTrack(
                "vocals-male",
                segment_frames(
                    frequencies.tolist(),
                    periodicities.tolist(),
                    levels.tolist(),
                    duration_s,
                ),
            )
        ],
    )
    assert assemble_pitch_prediction(stream.getvalue(), "vocals-male") == expected


def test_baseline_gpu_alignment_returns_unfiltered_complete_windows(
    monkeypatch, tmp_path
):
    audio = array("f", [0.0]) * (26 * SAMPLE_RATE)
    chunks = [
        RecognitionChunk(0, 25, 2, 3, "amber", "en"),
        RecognitionChunk(25, 26, 25.5, 26, "blue", "en"),
    ]
    observed_lengths = []

    class Aligner:
        def emissions(self, samples):
            observed_lengths.append(len(samples))
            return None, 0.02

        def align(self, emission, frame_s, text, offset):
            return [TranscriptWord(offset + 0.1, offset + 0.2, text)]

    def forbidden(*args, **kwargs):
        raise AssertionError("Transcript assembly belongs on the VPS")

    monkeypatch.setattr(lyrics, "recognition_transcript", forbidden)
    monkeypatch.setattr(
        inference_runtime, "_audio", lambda _: (audio, SAMPLE_RATE, 26.0)
    )
    monkeypatch.setattr(inference_runtime, "_aligner", lambda _: Aligner())
    result = json.loads(
        inference_runtime._alignment(
            tmp_path / "unused.wav",
            {"mode": "recognition", "chunks": [asdict(chunk) for chunk in chunks]},
            tmp_path,
        )
    )
    assert observed_lengths == [25 * SAMPLE_RATE, SAMPLE_RATE]
    assert set(result) == {"alignments", "duration_s", "pcm_identity"}
    assert [words[0]["start_s"] for words in result["alignments"]] == [0.1, 25.1]
    assert result["duration_s"] == 26.0
    pcm = memoryview(audio)
    shape = pcm.shape
    assert shape is not None
    assert result["pcm_identity"] == [
        SAMPLE_RATE,
        pcm.format,
        list(shape),
        hashlib.sha256(pcm).hexdigest(),
    ]


def test_structure_cpu_assembly_preserves_clamps_and_final_boundary():
    predictions = [
        {"start": 0.0, "end": 4.0, "label": "verse"},
        {"start": 4.0, "end": 9.9, "label": "chorus"},
    ]
    result = assemble_structure(predictions, 10.0, "exact-model-revision")
    assert result.structure_model == "exact-model-revision"
    assert result.sections[-1].end_s == 10.0
    assert predictions[-1]["end"] == 9.9
    assert (
        assemble_structure(
            [{"start": 0.0, "end": 12.0, "label": "verse"}], 10.0, "exact"
        )
        .sections[0]
        .end_s
        == 10.0
    )
    with pytest.raises(ValueError, match="Unsupported SongFormer label"):
        assemble_structure([{"start": 0, "end": 1, "label": "invented"}], 1, "exact")
    with pytest.raises(ValueError, match="no musical sections"):
        assemble_structure([], 1, "exact")


@pytest.mark.parametrize("filename", ["../outside.wav", "/tmp/outside.wav", ".."])
def test_runtime_revalidates_deserialized_request_before_file_io(tmp_path, filename):
    request = InferenceRequest("pitch", b"audio", "source.wav", "a" * 64)
    # Like pickle reconstruction, bypass the frozen dataclass's constructor.
    object.__setattr__(request, "filename", filename)
    with pytest.raises(ValueError, match="filename must be a basename"):
        run_inference(request, tmp_path / "work", tmp_path / "models")
    assert not (tmp_path / "work").exists()
