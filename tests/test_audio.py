import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
from audio_samples import (
    active_bounds,
    decode_audio,
    ffmpeg_tone,
    frequency_amplitude,
    mp3_measurements,
    tone_wav,
)

from separator import stems
from separator.audio import (
    detect_key,
    mix_audio,
    modification_suffix,
    transform_audio,
    transposed_key,
)
from separator.options import SeparationOptions
from separator.stems import Stem, StemResult

_FFMPEG = shutil.which("ffmpeg") is not None
_MIX_TOOLS = _FFMPEG and shutil.which("ffprobe") is not None
_TRANSFORM_TOOLS = _FFMPEG and shutil.which("rubberband") is not None
_KEYFINDER = shutil.which("keyfinder-cli") is not None


@pytest.mark.parametrize("pitch", [float("nan"), float("inf"), -float("inf")])
def test_reject_nonfinite_pitch(pitch: float) -> None:
    with pytest.raises(ValueError, match="pitch_semitones"):
        SeparationOptions(pitch_semitones=pitch)


@pytest.mark.parametrize("tempo", [0, -1, float("nan"), float("inf"), -float("inf")])
def test_reject_invalid_tempo(tempo: float) -> None:
    with pytest.raises(ValueError, match="tempo_percent"):
        SeparationOptions(tempo_percent=tempo)


def test_identity_never_needs_tools(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PATH", "")
    original = b"not even valid audio"
    assert transform_audio(original, SeparationOptions()) is original


@pytest.mark.parametrize(
    ("key", "pitch", "expected"),
    [
        (None, 2, None),
        ("C major", 0, "C major"),
        ("C major", 2, "D major"),
        ("B minor", 2, "Db minor"),
        ("C major", -1, "B major"),
        ("Db minor", -25, "C minor"),
        ("C major", 2.25, "D major (+25 cents)"),
        ("C major", -0.25, "C major (-25 cents)"),
        ("C major", 1.75, "D major (-25 cents)"),
        ("C# minor", 12.001, "Db minor (+0.1 cents)"),
    ],
)
def test_transposed_key(key: str | None, pitch: float, expected: str | None) -> None:
    assert transposed_key(key, pitch) == expected


@pytest.mark.parametrize(
    ("options", "expected"),
    [
        (SeparationOptions(), ""),
        (SeparationOptions(pitch_semitones=-0.0), ""),
        (SeparationOptions(pitch_semitones=2), " - pitch+2st"),
        (SeparationOptions(pitch_semitones=-2.25), " - pitch-2.25st"),
        (SeparationOptions(tempo_percent=120), " - tempo120pct"),
        (
            SeparationOptions(pitch_semitones=2, tempo_percent=120),
            " - pitch+2st - tempo120pct",
        ),
        (
            SeparationOptions(pitch_semitones=0.12345678901234568),
            " - pitch+0.12345678901234568st",
        ),
    ],
)
def test_modification_suffix(options: SeparationOptions, expected: str) -> None:
    assert modification_suffix(options) == expected


@pytest.fixture
def sine_mp3(tmp_path: Path) -> bytes:
    source = tmp_path / "source.wav"
    target = tmp_path / "source.mp3"
    source.write_bytes(tone_wav((440.0,)))
    subprocess.run(
        [
            "ffmpeg",
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(source),
            "-c:a",
            "libmp3lame",
            "-q:a",
            "0",
            str(target),
        ],
        check=True,
        capture_output=True,
    )
    return target.read_bytes()


@pytest.mark.skipif(not _TRANSFORM_TOOLS, reason="ffmpeg and Rubber Band required")
@pytest.mark.parametrize(
    ("pitch", "tempo"), [(12, 100), (0, 125), (-12, 80), (7.25, 120)]
)
def test_real_pitch_and_tempo_are_independent(
    sine_mp3: bytes, pitch: float, tempo: float
) -> None:
    original_duration, original_frequency = mp3_measurements(sine_mp3)
    result = transform_audio(
        sine_mp3, SeparationOptions(pitch_semitones=pitch, tempo_percent=tempo)
    )
    duration, frequency = mp3_measurements(result)
    assert duration == pytest.approx(original_duration * 100 / tempo, abs=0.10)
    assert frequency == pytest.approx(original_frequency * 2 ** (pitch / 12), rel=0.02)


@pytest.mark.skipif(not _KEYFINDER, reason="native keyfinder-cli required")
def test_real_silence_has_no_key() -> None:
    assert detect_key(tone_wav(()), "../../--unsafe.wav") is None


@pytest.mark.skipif(
    not (_KEYFINDER and _FFMPEG), reason="native keyfinder-cli and ffmpeg required"
)
@pytest.mark.parametrize("channels", [1, 2])
@pytest.mark.parametrize("audio_format", ["wav", "mp3"])
def test_real_major_chord_key(channels: int, audio_format: str) -> None:
    # Both container/sample formats must preserve channel count and musical key.
    # The old FFmpeg<=6 CLI passed the stereo layout bitmask (3) as a channel
    # count (2), shifting C to G; a mono-only test missed its octave-equivalent bug.
    chord = tone_wav((261.6256, 329.6276, 391.9954), duration_s=8, channels=channels)
    encoded = subprocess.run(
        [
            "ffmpeg",
            "-nostdin",
            "-v",
            "error",
            "-i",
            "pipe:0",
            "-ar",
            "44100",
            "-f",
            audio_format,
            "pipe:1",
        ],
        input=chord,
        check=True,
        capture_output=True,
    ).stdout
    assert detect_key(encoded, f"original.{audio_format}") == "C major"


@pytest.mark.skipif(not _KEYFINDER, reason="native keyfinder-cli required")
def test_keyfinder_decode_error_is_not_unknown_key() -> None:
    with pytest.raises(RuntimeError):
        detect_key(b"not audio", "original.mp3")


@pytest.mark.skipif(
    not (_KEYFINDER and _FFMPEG), reason="native keyfinder-cli and ffmpeg required"
)
def test_full_six_minute_key_analysis_stays_within_memory_budget(
    tmp_path: Path,
) -> None:
    # A silent first minute must not hide the remaining five-minute C chord.
    # Generate compressed media without retaining a full-rate Python PCM buffer.
    source = tmp_path / "full-song.mp3"
    subprocess.run(
        [
            "ffmpeg",
            "-nostdin",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "aevalsrc=if(lt(t\\,60)\\,0\\,"
            "0.15*(sin(2*PI*261.6256*t)+sin(2*PI*329.6276*t)"
            "+sin(2*PI*391.9954*t))):s=48000:d=360",
            "-ac",
            "2",
            str(source),
        ],
        check=True,
        capture_output=True,
    )
    # A separate interpreter gives this analysis its own child RSS high-water
    # mark. Direct full-rate CLI input used >700 MiB for a six-minute song.
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            "import json,resource,sys; from pathlib import Path; "
            "from separator.audio import detect_key; "
            "key=detect_key(Path(sys.argv[1]).read_bytes(), 'full-song.mp3'); "
            "rss=resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss; "
            "print(json.dumps({'key':key, 'rss_kib':"
            "rss/1024 if sys.platform=='darwin' else rss}))",
            str(source),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    proof = json.loads(result.stdout)
    assert proof["key"] == "C major"
    # Leave room inside the production 512 MiB limit for Python, yt-dlp, and
    # compressed source bytes, instead of merely fitting the native child.
    assert proof["rss_kib"] < 256 * 1024, proof


@pytest.mark.skipif(not _MIX_TOOLS, reason="ffmpeg and ffprobe required")
def test_real_mix_preserves_both_sources_at_unity_gain_and_stereo(
    tmp_path: Path,
) -> None:
    vocals = ffmpeg_tone(
        tmp_path / "vocals.wav",
        (440.0, 550.0),
        amplitude=0.12,
        sample_rate=44100,
    )
    instruments = ffmpeg_tone(
        tmp_path / "instruments.wav",
        (880.0, 1100.0),
        amplitude=0.18,
    )
    output = tmp_path / "mix.mp3"
    mix_audio(vocals, instruments, output)
    audio = decode_audio(output.read_bytes())

    assert audio.codec == "mp3"
    assert audio.sample_rate == 48000
    assert len(audio.channels) == 2
    assert audio.duration_s == pytest.approx(1.0, abs=0.04)
    assert audio.peak < 0.35
    for channel, vocal_frequency, instrument_frequency in (
        (0, 440.0, 880.0),
        (1, 550.0, 1100.0),
    ):
        # Averaging loses 6 dB; limiter auto-makeup would instead boost these.
        assert frequency_amplitude(
            audio, vocal_frequency, channel=channel
        ) == pytest.approx(0.12, abs=0.012)
        assert frequency_amplitude(
            audio, instrument_frequency, channel=channel
        ) == pytest.approx(0.18, abs=0.015)
    for channel, other_channel_frequencies in (
        (0, (550.0, 1100.0)),
        (1, (440.0, 880.0)),
    ):
        for frequency in other_channel_frequencies:
            assert frequency_amplitude(audio, frequency, channel=channel) < 0.008


@pytest.mark.skipif(not _MIX_TOOLS, reason="ffmpeg and ffprobe required")
def test_real_mix_aligns_onsets_and_keeps_longer_source_without_silence_tail(
    tmp_path: Path,
) -> None:
    vocals = ffmpeg_tone(
        tmp_path / "short.wav",
        (400.0, 400.0),
        amplitude=0.16,
        duration_s=0.4,
        sample_rate=22050,
        start_s=0.04,
        end_s=0.34,
    )
    instruments = ffmpeg_tone(
        tmp_path / "long.wav",
        (1000.0, 1000.0),
        amplitude=0.14,
        duration_s=0.8,
        sample_rate=44100,
        start_s=0.04,
        end_s=0.74,
    )
    output = tmp_path / "aligned.mp3"
    mix_audio(vocals, instruments, output)
    audio = decode_audio(output.read_bytes())

    assert audio.sample_rate == 48000
    assert len(audio.channels) == 2
    assert audio.duration_s == pytest.approx(0.8, abs=0.04)
    assert active_bounds(audio) == pytest.approx((0.04, 0.74), abs=0.015)
    for frequency, amplitude in ((400.0, 0.16), (1000.0, 0.14)):
        assert frequency_amplitude(
            audio, frequency, start_s=0.06, end_s=0.16
        ) == pytest.approx(amplitude, abs=0.015)
    # The shorter stem must not truncate the mix or change the survivor's gain.
    assert frequency_amplitude(
        audio, 1000.0, start_s=0.50, end_s=0.70
    ) == pytest.approx(0.14, abs=0.015)
    assert frequency_amplitude(audio, 400.0, start_s=0.50, end_s=0.70) < 0.005
    # Check both boundaries, rather than letting long silent padding pass a
    # frequency-only assertion.
    for start, end in ((0.0, 0.02), (0.77, 0.79)):
        assert (
            max(
                abs(sample)
                for sample in audio.channels[0][
                    round(start * audio.sample_rate) : round(end * audio.sample_rate)
                ]
            )
            < 0.015
        )


@pytest.mark.skipif(not _MIX_TOOLS, reason="ffmpeg and ffprobe required")
def test_real_mix_upmixes_mono_and_resamples_to_stereo_48k(tmp_path: Path) -> None:
    vocals = ffmpeg_tone(
        tmp_path / "mono.wav",
        (440.0,),
        sample_rate=22050,
    )
    instruments = ffmpeg_tone(
        tmp_path / "stereo.wav",
        (880.0, 880.0),
        sample_rate=44100,
    )
    output = tmp_path / "stereo.mp3"
    mix_audio(vocals, instruments, output)
    audio = decode_audio(output.read_bytes())

    assert audio.sample_rate == 48000
    assert len(audio.channels) == 2
    for channel in (0, 1):
        assert frequency_amplitude(audio, 440.0, channel=channel) > 0.08
        assert frequency_amplitude(audio, 880.0, channel=channel) > 0.12
    assert (
        max(
            abs(left - right)
            for left, right in zip(audio.channels[0], audio.channels[1], strict=True)
        )
        < 0.005
    )


@pytest.mark.skipif(not _MIX_TOOLS, reason="ffmpeg and ffprobe required")
@pytest.mark.parametrize("amplitude", [0.7, 0.95])
def test_real_mix_limits_overload_without_clipping_or_long_tail(
    tmp_path: Path,
    amplitude: float,
) -> None:
    vocals = ffmpeg_tone(
        tmp_path / "loud-vocals.wav",
        (1000.0, 1000.0),
        amplitude=amplitude,
        duration_s=0.8,
        start_s=0.04,
        end_s=0.74,
    )
    instruments = ffmpeg_tone(
        tmp_path / "loud-instruments.wav",
        (1000.0, 1000.0),
        amplitude=amplitude,
        duration_s=0.8,
        start_s=0.04,
        end_s=0.74,
    )
    output = tmp_path / "limited.mp3"
    mix_audio(vocals, instruments, output)
    audio = decode_audio(output.read_bytes())

    # Inspect float PCM: integer decoding would hide overshoots by clipping them.
    assert 0.82 < audio.peak < 0.97
    assert frequency_amplitude(audio, 1000.0) > 0.80
    assert audio.duration_s == pytest.approx(0.8, abs=0.04)
    assert active_bounds(audio) == pytest.approx((0.04, 0.74), abs=0.015)
    assert all(abs(sample) < 0.99 for channel in audio.channels for sample in channel)


@pytest.mark.skipif(not _MIX_TOOLS, reason="ffmpeg and ffprobe required")
@pytest.mark.parametrize("clean", [False, True])
def test_real_graph_mix_content_uses_selected_cleaning_without_leaking_prerequisites(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    clean: bool,
) -> None:
    frequencies = {
        "vocals": 330.0,
        "vocals-decrowded": 440.0,
        "vocals-male": 550.0,
        "vocals-female": 660.0,
        "lead": 770.0,
        "backing": 880.0,
        "instruments": 220.0,
        "instruments-decrowded": 110.0,
        "vocals-decrowded-dry": 1440.0,
        "vocals-male-dry": 1550.0,
        "vocals-female-dry": 1660.0,
        "lead-dry": 1770.0,
        "backing-dry": 1880.0,
    }
    calls: list[tuple[Path, Stem]] = []

    def separate(
        input_path: Path,
        stem: Stem,
        out_dir: Path,
        model_cache: str,
        stem_cache: str,
        use_cache: bool = True,
    ) -> dict[str, tuple[StemResult, Path]]:
        calls.append((input_path, stem))
        out_dir.mkdir(parents=True)
        result = {}
        for output in stem.outputs:
            frequency = frequencies[output.label]
            path = ffmpeg_tone(
                out_dir / f"{output.label}.wav",
                (frequency, frequency),
                amplitude=0.12,
            )
            result[output.label] = (StemResult(path.read_bytes(), 0.1), path)
        return result

    # Mock only model inference. Graph routing, FFmpeg mixing, encoding and
    # decoded spectral measurements all execute for real.
    monkeypatch.setattr(stems, "run_separator", separate)
    result = stems.run_separation(
        tmp_path / "original.wav",
        SeparationOptions(
            mix_female_instruments=True,
            mix_male_instruments=True,
            mix_backing_instruments=True,
            mix_lead_instruments=True,
            decrowd=clean,
            decrowd_vocals=clean,
            dereverb=clean,
        ),
        tmp_path,
        "models",
        "cache",
    )
    assert list(result) == (
        ["vocals-decrowded", "vocals-decrowded-dry", "instruments-decrowded"]
        if clean
        else []
    ) + [
        "female-instruments",
        "male-instruments",
        "backing-instruments",
        "lead-instruments",
    ]
    for label, vocal in (
        ("female-instruments", "vocals-female"),
        ("male-instruments", "vocals-male"),
        ("backing-instruments", "backing"),
        ("lead-instruments", "lead"),
    ):
        audio = decode_audio(result[label].data)
        expected_frequencies = {
            frequencies[f"{vocal}-dry" if clean else vocal],
            frequencies["instruments-decrowded" if clean else "instruments"],
        }
        assert audio.codec == "mp3"
        assert audio.sample_rate == 48000
        assert len(audio.channels) == 2
        assert audio.duration_s == pytest.approx(1.0, abs=0.04)
        for channel in (0, 1):
            for frequency in expected_frequencies:
                assert frequency_amplitude(
                    audio, frequency, channel=channel
                ) == pytest.approx(0.12, abs=0.015)
        for frequency in set(frequencies.values()) - expected_frequencies:
            assert frequency_amplitude(audio, frequency) < 0.008
    for model in (stems.GENDER_STEMS[0].model, stems.LEAD_BACKING_STEMS[0].model):
        split_inputs = [path for path, stem in calls if stem.model == model]
        assert len(split_inputs) == 1
        assert split_inputs[0].name == (
            "vocals-decrowded.wav" if clean else "vocals.wav"
        )
