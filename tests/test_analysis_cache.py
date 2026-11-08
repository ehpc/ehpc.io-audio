"""Source-clock cache dependencies exercised through finite CPU inference."""

from collections import Counter
from dataclasses import replace

import pytest
from audio_samples import mp3_measurements, tone_wav
from inference_fixture import StemSignal, cpu_inference, fixture_manifest

from separator import processing
from separator.artifact_cache import cache_key, digest
from separator.inference import InferenceRequest
from separator.lyrics import Transcript, TranscriptWord
from separator.options import MixSpec, SeparationOptions
from separator.pitch import pitch_from_json
from separator.producer_manifest import save_manifest
from separator.stems import INSTRUMENTS_STEM, VOCALS_STEM


def test_legacy_audio_requires_its_actual_native_producer_identity(tmp_path):
    """An inspection on another runtime must not replace artifact provenance."""
    source = tmp_path / "source.wav"
    source_bytes = tone_wav((220,), 2.4)
    source.write_bytes(source_bytes)
    producer = tmp_path / "producer"
    runtime = fixture_manifest(producer, signals={"vocals": StemSignal(330, 2.4)})
    request = InferenceRequest(
        "separation",
        source_bytes,
        source.name,
        runtime.digest_for("separation", VOCALS_STEM.model),
        {
            "model": VOCALS_STEM.model,
            "outputs": [
                {"label": output.label, "keep_pattern": output.keep_pattern}
                for output in VOCALS_STEM.outputs
            ],
        },
    )
    # Execute the real CPU fixture producer once. Its configuration, provider
    # source and native FFmpeg fingerprint are recorded, not invented GPU output.
    archive = cpu_inference(request, request.fingerprint(), root=producer)
    native = runtime.separator
    old_key = cache_key(
        runtime.versions["STEM"],
        native.packages["audio-separator"],
        {
            name: native.packages[name]
            for name in ("torch", "onnxruntime-gpu", "librosa")
        },
        native.ffmpeg,
        VOCALS_STEM.model,
        VOCALS_STEM.outputs,
        digest(source_bytes),
        runtime.models[VOCALS_STEM.model],
    )
    root = tmp_path / "cache"
    old_path = root / "stems" / "versioned" / "outputs" / f"{old_key}.bin"
    old_path.parent.mkdir(parents=True)
    old_path.write_bytes(archive)
    save_manifest(root / "legacy-producer-manifest.json", runtime)
    inspection = replace(
        runtime,
        separator=replace(
            native, ffmpeg=digest(b"owned differing inspection-runtime dependency")
        ),
    )
    assert processing.cached_pitch_vocals(source_bytes, root, inspection) is None

    def forbidden(*args):
        raise AssertionError("completed native producer was invoked again")

    context = processing.ProcessingContext(root, runtime, forbidden)
    audio, output = context.separate(source, VOCALS_STEM, tmp_path / "job-one")[
        "vocals"
    ]
    duration, frequency = mp3_measurements(audio.data)
    assert duration == pytest.approx(2.4, abs=0.1)
    assert frequency == pytest.approx(330, abs=1)
    assert output.read_bytes() == audio.data
    assert processing.cached_pitch_vocals(source_bytes, root, runtime) == audio.data
    # A populated new cache must not turn the other runtime into a blanket alias.
    assert processing.cached_pitch_vocals(source_bytes, root, inspection) is None
    assert processing.cached_pitch_vocals(tone_wav((440,), 2.4), root, runtime) is None
    with pytest.raises(AssertionError):
        context.separate(source, INSTRUMENTS_STEM, tmp_path / "other-model")
    assert old_path.read_bytes() == archive
    assert source.read_bytes() == source_bytes


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
