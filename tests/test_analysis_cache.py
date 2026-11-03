"""Observe full cache orchestration with independently measured CPU fixtures."""

import shlex
import sys
from collections import Counter
from dataclasses import replace
from pathlib import Path

import pytest
from analysis_cpu import WORDS, frequencies, load, signal

from separator import cache_versions, processing, transcribe
from separator.lyrics import RecognitionChunk, TranscriptWord
from separator.lyrics_reference import ReferenceLine, ReferenceReview
from separator.options import MixSpec, SeparationOptions
from separator.pitch import pitch_from_json
from separator.stems import StemResult


def test_processing_reuses_and_independently_invalidates_all_analysis(
    tmp_path, monkeypatch
):
    source = tmp_path / "source.wav"
    signal(source)
    trace = tmp_path / "trace"
    monkeypatch.setenv("ANALYSIS_TRACE", str(trace))
    monkeypatch.setenv("PYTHONPATH", str(Path(__file__).resolve().parent.parent))
    launcher = tmp_path / "cpu-python"
    worker = Path(__file__).with_name("analysis_cpu.py")
    launcher.write_text(
        f"#!/bin/sh\nexec {shlex.quote(sys.executable)} "
        f'{shlex.quote(str(worker))} "$@"\n'
    )
    launcher.chmod(0o700)
    monkeypatch.setattr(cache_versions, "ASR", "owned-cpu-recognition-v1")
    monkeypatch.setattr(cache_versions, "PITCH", "owned-cpu-crossing-pitch-v1")
    monkeypatch.setattr(cache_versions, "STRUCTURE", "owned-cpu-structure-v1")

    def existing_tracks(path, options, *args):
        # Separation is independently proven in the native HTTP test. Here a
        # retained, valid PCM track isolates the real analysis cache dispatcher.
        return {
            label: StemResult(source.read_bytes(), 0)
            for label in ["vocals", *options.output_labels]
        }

    monkeypatch.setattr(processing, "run_separation", existing_tracks)
    options = SeparationOptions(
        extract_lyrics=True,
        detect_pitch=True,
        mixes=(MixSpec("mix-one", "First name", ("vocals", "instruments")),),
    )

    def run(selected):
        return processing.run_processing(
            source,
            selected,
            tmp_path,
            str(tmp_path / "models"),
            str(tmp_path / "stems"),
            30,
            str(launcher),
            str(launcher),
        )

    first = run(options)
    assert first.transcript is not None and first.pitch_json is not None
    assert [word.text for word in first.transcript.words] == list(WORDS)
    assert Counter(trace.read_text().splitlines()) == Counter(
        transcribe=1, structure=1, detect_pitch=1
    )
    shifted_options = replace(
        options,
        mixes=(MixSpec("mix-two", "Other private name", ("vocals", "instruments")),),
        pitch_semitones=12,
        tempo_percent=200,
    )
    monkeypatch.setenv("ANALYSIS_FORBID", "transcribe,structure,detect_pitch")
    shifted = run(shifted_options)
    assert shifted.transcript == first.transcript
    assert list(shifted.audio) == ["mix-two"]
    assert shifted.pitch_json is not None
    pitch = pitch_from_json(shifted.pitch_json)
    assert pitch.tracks[0].label == "vocals"
    assert pitch.tracks[0].notes[0].frequency_hz == pytest.approx(440, abs=1)
    assert pitch.tracks[0].notes[0].start_s == pytest.approx(0.05)
    assert pitch.words[0].start_s == pytest.approx(0.05)
    assert pitch.tracks[0].notes[0].word_indices == [0]
    assert Counter(trace.read_text().splitlines()) == Counter(
        transcribe=1, structure=1, detect_pitch=1
    )

    monkeypatch.setattr(cache_versions, "ASR", "owned-cpu-recognition-v2")
    monkeypatch.setenv("ANALYSIS_WORDS", "fresh bright blue world")
    monkeypatch.setenv("ANALYSIS_FORBID", "structure,detect_pitch")
    updated = run(shifted_options)
    assert updated.pitch_json is not None
    assert pitch_from_json(updated.pitch_json).words[0].text == "fresh"
    assert pitch_from_json(updated.pitch_json).tracks[0].notes[0].word_indices == [0]
    assert Counter(trace.read_text().splitlines()) == Counter(
        transcribe=2, structure=1, detect_pitch=1
    )

    monkeypatch.setattr(cache_versions, "PITCH", "owned-cpu-crossing-pitch-v2")
    monkeypatch.setenv("ANALYSIS_FORBID", "transcribe,structure")
    repitched = run(shifted_options)
    assert repitched.transcript == updated.transcript
    assert repitched.pitch_json == updated.pitch_json
    assert Counter(trace.read_text().splitlines()) == Counter(
        transcribe=2, structure=1, detect_pitch=2
    )

    monkeypatch.setattr(cache_versions, "STRUCTURE", "owned-cpu-structure-v2")
    monkeypatch.setenv("ANALYSIS_SECTION", "chorus")
    monkeypatch.setenv("ANALYSIS_FORBID", "transcribe,detect_pitch")
    structured = run(shifted_options)
    assert structured.transcript is not None and updated.transcript is not None
    assert structured.transcript.sections[0].label == "chorus"
    assert structured.transcript.words == updated.transcript.words
    assert structured.pitch_json == updated.pitch_json
    assert Counter(trace.read_text().splitlines()) == Counter(
        transcribe=2, structure=2, detect_pitch=2
    )


class Emission:
    def __init__(self, samples):
        self.samples = samples
        self.shape = (len(samples),)


class CpuAligner:
    """Measure the known waveform intervals; no canned timestamp payloads."""

    def __init__(self, calls):
        self.calls = calls

    def emissions(self, samples):
        self.calls.append("acoustics")
        return Emission(samples), 1 / 16000

    def align(self, emission, frame_s, text, offset):
        intervals = frequencies(emission.samples)
        return [
            TranscriptWord(offset + start, offset + end, word, alignment_score=0.95)
            for (start, end, _), word in zip(intervals, text.split(), strict=True)
        ]

    def log_score(self, emission, text):
        decoded = [
            WORDS[
                min(range(4), key=lambda index: abs(hz - (220, 330, 440, 660)[index]))
            ]
            for _, _, hz in frequencies(emission.samples)
        ]
        return -0.01 - sum(a != b for a, b in zip(decoded, text.split(), strict=True))


def test_changed_reference_reuses_raw_qwen_and_baseline_mms(tmp_path, monkeypatch):
    source = tmp_path / "signal.wav"
    signal(source)
    calls = []
    monkeypatch.setattr(transcribe, "_load_audio", load)
    monkeypatch.setattr(cache_versions, "ASR", "owned-cpu-recognizer-v1")
    monkeypatch.setattr(cache_versions, "ALIGNMENT", "owned-cpu-alignment-v1")

    def recognize(samples, rate, windows):
        calls.append("recognize")
        observed = frequencies(samples, rate)
        assert [round(hz / 110) for _, _, hz in observed] == [2, 3, 4, 6]
        return [
            RecognitionChunk(
                0,
                len(samples) / rate,
                0,
                len(samples) / rate,
                "hello bright blue word",
                "en",
            )
        ]

    def aligner(_):
        calls.append("aligner")
        return CpuAligner(calls)

    def forbidden(*args):
        raise AssertionError("cached raw/baseline analysis allocated its loader")

    monkeypatch.setattr(transcribe, "_recognize_windows", recognize)
    monkeypatch.setattr(transcribe, "_load_aligner", aligner)
    first = transcribe.transcribe(source, tmp_path / "models")
    assert [word.text for word in first.words] == ["hello", "bright", "blue", "word"]
    assert first.words[0].start_s == pytest.approx(0.1)
    assert calls == ["recognize", "aligner", "acoustics"]
    monkeypatch.setattr(transcribe, "_recognize_windows", forbidden)
    monkeypatch.setattr(transcribe, "_load_aligner", forbidden)
    assert transcribe.transcribe(source, tmp_path / "models") == first
    assert calls == ["recognize", "aligner", "acoustics"]

    monkeypatch.setattr(transcribe, "_load_aligner", aligner)
    original_review = ReferenceReview(
        "matched", "owned reference", lines=[ReferenceLine("hello bright blue word")]
    )
    reviewed = transcribe.transcribe(source, tmp_path / "models", original_review)
    assert reviewed.reference is not None
    assert reviewed.reference.original_words == first.words
    assert calls == ["recognize", "aligner", "acoustics", "aligner", "acoustics"]
    changed_review = replace(
        original_review, lines=[ReferenceLine("hello bright blue world")]
    )
    corrected = transcribe.transcribe(source, tmp_path / "models", changed_review)
    assert corrected.reference is not None
    assert corrected.reference.original_words == first.words
    assert corrected.reference.lines[0].text == "hello bright blue world"
    assert corrected.reference.lines[0].status == "aligned"
    assert corrected.words[-1].text == "world"
    assert corrected.reference != reviewed.reference
    assert calls == [
        "recognize",
        "aligner",
        "acoustics",
        "aligner",
        "acoustics",
        "aligner",
        "acoustics",
    ]
    assert (
        len(list((tmp_path / "models" / "results" / "recognition").glob("*.bin"))) == 1
    )
    assert (
        len(
            list(
                (tmp_path / "models" / "results" / "recognition-alignment").glob(
                    "*.bin"
                )
            )
        )
        == 1
    )


def test_baseline_alignment_tracks_decoded_pcm_not_container_or_qwen_version(
    tmp_path,
    monkeypatch,
):
    source = tmp_path / "signal.wav"
    signal(source)
    calls = []
    monkeypatch.setattr(transcribe, "_load_audio", load)
    monkeypatch.setattr(cache_versions, "ASR", "owned-cpu-recognizer-v1")
    monkeypatch.setattr(cache_versions, "ALIGNMENT", "owned-cpu-alignment-v1")
    decoder_revision = ["v1"]
    qwen_revision = ["v1"]
    original_revisions = cache_versions.environment_revisions

    def revisions(python, packages):
        if packages == cache_versions.ASR_PACKAGES:
            return {
                "owned-decoder": decoder_revision[0],
                "owned-qwen": qwen_revision[0],
            }
        return original_revisions(python, packages)

    def recognize(samples, rate, windows):
        calls.append("recognize")
        assert len(frequencies(samples, rate)) == 4
        return [
            RecognitionChunk(
                0,
                len(samples) / rate,
                0,
                len(samples) / rate,
                "hello bright blue world",
                "en",
            )
        ]

    def aligner(_):
        calls.append("aligner")
        return CpuAligner(calls)

    monkeypatch.setattr(cache_versions, "environment_revisions", revisions)
    monkeypatch.setattr(transcribe, "_recognize_windows", recognize)
    monkeypatch.setattr(transcribe, "_load_aligner", aligner)
    root = tmp_path / "models"
    first = transcribe.transcribe(source, root)
    assert first.words[0].start_s == pytest.approx(0.1)
    assert calls == ["recognize", "aligner", "acoustics"]

    def shifted_decode(path):
        samples, rate = load(path)
        delay = rate // 50
        # Keep duration/raw chunks identical while moving measured acoustic
        # intervals by 20 ms. The tail already contains sufficient silence.
        samples = samples[-delay:] + samples[:-delay]
        return samples, rate

    decoder_revision[0] = "v2"
    monkeypatch.setattr(transcribe, "_load_audio", shifted_decode)
    shifted = transcribe.transcribe(source, root)
    assert [word.text for word in shifted.words] == [word.text for word in first.words]
    for previous, current in zip(first.words, shifted.words, strict=True):
        assert current.start_s == pytest.approx(previous.start_s + 0.02)
        assert current.end_s == pytest.approx(previous.end_s + 0.02)
    assert calls == ["recognize", "aligner", "acoustics"] * 2

    def forbidden(_):
        raise AssertionError("identical PCM/raw chunks recomputed baseline alignment")

    monkeypatch.setattr(transcribe, "_load_aligner", forbidden)
    assert transcribe.transcribe(source, root) == shifted
    # A valid WAV metadata chunk changes compressed/container identity but not
    # the decoded PCM. Raw recognition may rerun; baseline alignment must not.
    original = source.read_bytes()
    metadata = b"JUNK" + (4).to_bytes(4, "little") + b"meta"
    source.write_bytes(
        original[:4]
        + (len(original) + len(metadata) - 8).to_bytes(4, "little")
        + original[8:]
        + metadata
    )
    assert transcribe.transcribe(source, root) == shifted
    assert calls.count("recognize") == 3
    assert calls.count("acoustics") == 2
    qwen_revision[0] = "v2"
    assert transcribe.transcribe(source, root) == shifted
    assert calls.count("recognize") == 4
    assert calls.count("acoustics") == 2
