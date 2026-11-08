"""Source-clock cache dependencies exercised through finite CPU inference."""

from collections import Counter
from dataclasses import replace

import pytest
from audio_samples import mp3_measurements, tone_wav
from inference_fixture import cpu_inference, fixture_manifest

from separator import processing
from separator.lyrics import Transcript, TranscriptWord
from separator.options import MixSpec, SeparationOptions
from separator.pitch import pitch_from_json
from separator.producer_manifest import save_manifest


def test_processing_reuses_source_clock_analysis_across_export_changes(tmp_path):
    source = tmp_path / "source.wav"
    source.write_bytes(tone_wav((220,), 4))
    producer = tmp_path / "producer"
    manifest = fixture_manifest(producer)
    calls = []
    vocal_durations = []

    def infer(request, key):
        calls.append(request.operation)
        if request.operation == "recognition":
            vocal_durations.append(mp3_measurements(request.audio_bytes)[0])
        return cpu_inference(request, key, root=producer)

    context = processing.ProcessingContext(tmp_path / "cache", manifest, infer)
    options = SeparationOptions(
        extract_lyrics=True,
        detect_pitch=True,
        mixes=(MixSpec("mix-one", "First name", ("vocals", "instruments")),),
    )
    first = processing.run_processing(source, options, tmp_path, context)
    assert first.transcript is not None and first.pitch_json is not None
    assert [word.text for word in first.transcript.words] == ["fixture"]
    assert first.transcript.words[0].start_s == pytest.approx(
        vocal_durations[0] / 4, abs=1 / 16000
    )
    assert Counter(calls) == Counter(
        separation=2, recognition=1, alignment=1, structure=1, pitch=1
    )

    def forbidden(*args):
        raise AssertionError("export changes invoked a cached model stage")

    context.infer = forbidden
    shifted = processing.run_processing(
        source,
        replace(
            options,
            mixes=(
                MixSpec("mix-two", "Other private name", ("vocals", "instruments")),
            ),
            pitch_semitones=12,
            tempo_percent=200,
        ),
        tmp_path,
        context,
    )
    assert shifted.transcript == first.transcript
    assert list(shifted.audio) == ["mix-two"]
    assert shifted.pitch_json is not None
    pitch = pitch_from_json(shifted.pitch_json)
    original_pitch = pitch_from_json(first.pitch_json)
    assert pitch.tracks[0].label == "vocals"
    assert pitch.tracks[0].notes[0].frequency_hz == pytest.approx(440, abs=1)
    assert pitch.tracks[0].notes[0].start_s == pytest.approx(
        original_pitch.tracks[0].notes[0].start_s / 2
    )
    assert pitch.words[0].start_s == pytest.approx(
        first.transcript.words[0].start_s / 2
    )
    assert pitch.tracks[0].notes[0].word_indices == [0]
    assert pitch.source_duration_s == original_pitch.source_duration_s
    duration, frequency = mp3_measurements(shifted.audio["mix-two"].data)
    # Processing owns source-clock audio; export transformation is a CPU consumer.
    assert duration == pytest.approx(4, abs=0.1)
    assert frequency == pytest.approx(220, rel=0.025)


@pytest.mark.parametrize(
    "version,expected",
    [
        ("ASR", "recognition"),
        ("ALIGNMENT", "alignment"),
        ("STRUCTURE", "structure"),
        ("PITCH", "pitch"),
    ],
)
def test_version_change_invokes_only_its_missing_stage(tmp_path, version, expected):
    source = tmp_path / "source.wav"
    source.write_bytes(tone_wav((220,), 4))
    producer = tmp_path / "producer"
    manifest = fixture_manifest(producer)
    context = processing.ProcessingContext(
        tmp_path / "cache",
        manifest,
        lambda request, key: cpu_inference(request, key, root=producer),
    )
    options = SeparationOptions(extract_lyrics=True, detect_pitch=True)
    first = processing.run_processing(source, options, tmp_path, context)
    context.manifest = replace(
        manifest, versions={**manifest.versions, version: "synthetic-revision-two"}
    )
    save_manifest(producer / "fixture-manifest.json", context.manifest)
    calls = []

    def only_missing(request, key):
        assert request.operation == expected, "unrelated cached stage was invoked"
        calls.append(request.operation)
        return cpu_inference(request, key, root=producer)

    context.infer = only_missing
    updated = processing.run_processing(source, options, tmp_path, context)
    assert calls == [expected]
    assert updated.transcript == first.transcript
    assert updated.pitch_json == first.pitch_json

    def forbidden(*args):
        raise AssertionError("new version was not cached")

    context.infer = forbidden
    repeated = processing.run_processing(source, options, tmp_path, context)
    assert repeated.transcript == updated.transcript
    assert repeated.pitch_json == updated.pitch_json


def test_adding_lyrics_to_cached_pitch_invokes_only_missing_dependencies(tmp_path):
    source = tmp_path / "source.wav"
    source.write_bytes(tone_wav((220,), 4))
    producer = tmp_path / "producer"
    manifest = fixture_manifest(producer)
    calls = []

    def infer(request, key):
        calls.append(request.operation)
        return cpu_inference(request, key, root=producer)

    context = processing.ProcessingContext(tmp_path / "cache", manifest, infer)
    first = processing.run_processing(
        source, SeparationOptions(detect_pitch=True), tmp_path, context
    )
    assert calls == ["separation", "pitch"]
    assert first.transcript is None and first.pitch_json is not None
    assert pitch_from_json(first.pitch_json).words == []
    calls.clear()

    def missing(request, key):
        assert request.operation not in {"separation", "pitch"}
        return infer(request, key)

    context.infer = missing
    result = processing.run_processing(
        source,
        SeparationOptions(detect_pitch=True, extract_lyrics=True),
        tmp_path,
        context,
    )
    assert calls == ["recognition", "alignment", "structure"]
    assert result.transcript is not None and result.pitch_json is not None
    pitch = pitch_from_json(result.pitch_json)
    assert pitch.words == result.transcript.words
    assert pitch.tracks[0].notes[0].word_indices == [0]


def test_baseline_alignment_tracks_decoded_pcm_not_container_or_asr_version(tmp_path):
    source = tone_wav((220,), 4)
    producer = tmp_path / "producer"
    manifest = fixture_manifest(
        producer, transcript=Transcript(words=[TranscriptWord(1, 2, "hello")])
    )
    calls = []

    def infer(request, key):
        calls.append(request.operation)
        return cpu_inference(request, key, root=producer)

    context = processing.ProcessingContext(tmp_path / "cache", manifest, infer)
    first = processing.transcribe_source(source, context, None)
    assert first.words[0].start_s == 1
    assert calls == ["recognition", "alignment"]
    metadata = b"JUNK" + (4).to_bytes(4, "little") + b"meta"
    repackaged = (
        source[:4]
        + (len(source) + len(metadata) - 8).to_bytes(4, "little")
        + source[8:]
        + metadata
    )

    def recognition_only(request, key):
        assert request.operation == "recognition", "unchanged PCM repeated alignment"
        return infer(request, key)

    context.infer = recognition_only
    assert processing.transcribe_source(repackaged, context, None) == first
    context.manifest = replace(
        manifest, versions={**manifest.versions, "ASR": "synthetic-asr-two"}
    )
    save_manifest(producer / "fixture-manifest.json", context.manifest)
    assert processing.transcribe_source(repackaged, context, None) == first
    assert calls == ["recognition", "alignment", "recognition", "recognition"]

    context.infer = infer
    # Different decoded samples with the same duration/chunks must realign.
    changed = processing.transcribe_source(tone_wav((330,), 4), context, None)
    assert changed.words == first.words
    assert calls[-2:] == ["recognition", "alignment"]
