"""CPU-only analysis of originals and postprocessing of completed stems."""

import re
import subprocess
import tempfile
from decimal import ROUND_HALF_UP, Decimal, localcontext
from pathlib import Path

from separator.options import SeparationOptions

_NOTES = ("C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B")
_PITCH_CLASSES = {note: index for index, note in enumerate(_NOTES)}
_PITCH_CLASSES.update({"C#": 1, "D#": 3, "F#": 6, "G#": 8, "A#": 10})


def _number(value: float) -> str:
    """Shortest roundtrip-safe spelling without a redundant decimal point."""
    text = repr(float(value))
    return text.removesuffix(".0")


def _run(command: list[str]) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(command, check=True, capture_output=True, text=True)
    except subprocess.CalledProcessError as exc:
        detail = exc.stderr.strip() or exc.stdout.strip() or "no diagnostic output"
        raise RuntimeError(f"{command[0]} failed ({exc.returncode}): {detail}") from exc
    except FileNotFoundError as exc:
        raise RuntimeError(f"Required audio tool not found: {command[0]}") from exc


def transform_audio(audio_bytes: bytes, options: SeparationOptions) -> bytes:
    """Apply independent pitch and tempo adjustments in one offline R3 pass."""
    if options.pitch_semitones == 0 and options.tempo_percent == 100:
        return audio_bytes

    with tempfile.TemporaryDirectory(prefix="vocals-transform-") as directory:
        root = Path(directory)
        source = root / "source.mp3"
        decoded = root / "decoded.wav"
        transformed = root / "transformed.wav"
        output = root / "output.mp3"
        source.write_bytes(audio_bytes)
        _run(
            [
                "ffmpeg",
                "-nostdin",
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-i",
                str(source),
                "-map",
                "0:a:0",
                "-vn",
                "-c:a",
                "pcm_f32le",
                str(decoded),
            ]
        )
        _run(
            [
                "rubberband",
                "--fine",
                "--formant",
                "--pitch",
                _number(options.pitch_semitones),
                "--tempo",
                f"100:{_number(options.tempo_percent)}",
                str(decoded),
                str(transformed),
            ]
        )
        _run(
            [
                "ffmpeg",
                "-nostdin",
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-i",
                str(transformed),
                "-map",
                "0:a:0",
                "-vn",
                "-c:a",
                "libmp3lame",
                "-q:a",
                "0",
                str(output),
            ]
        )
        return output.read_bytes()


def mix_audio(vocals: Path, instruments: Path, output: Path) -> None:
    """Time-align and sum at unity gain, limiting only peaks (no auto makeup).

    A 0.89 ceiling leaves about 1 dB of headroom for MP3 reconstruction peaks.
    Unlike amix's default normalization, quiet passages retain their level.
    """
    _run(
        [
            "ffmpeg",
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(vocals),
            "-i",
            str(instruments),
            "-filter_complex",
            "[0:a:0]aresample=48000:first_pts=0,"
            "aformat=sample_fmts=fltp:channel_layouts=stereo[v];"
            "[1:a:0]aresample=48000:first_pts=0,"
            "aformat=sample_fmts=fltp:channel_layouts=stereo[i];"
            "[v][i]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0,"
            "alimiter=limit=0.89:attack=5:release=50:level=false:latency=true[out]",
            "-map",
            "[out]",
            "-c:a",
            "libmp3lame",
            "-q:a",
            "0",
            str(output),
        ]
    )


def detect_key(audio_bytes: bytes, filename: str) -> str | None:
    """Return libkeyfinder's standard key, or None for its SILENCE result."""
    with tempfile.TemporaryDirectory(prefix="vocals-key-") as directory:
        # The absolute, fixed basename cannot be interpreted as a CLI option or
        # escape the temporary directory, even for hostile upload filenames.
        suffix = Path(filename).suffix
        if not re.fullmatch(r"\.[A-Za-z0-9]{1,10}", suffix):
            suffix = ".audio"
        source = Path(directory) / f"original{suffix}"
        source.write_bytes(audio_bytes)
        result = _run(["keyfinder-cli", "-n", "standard", str(source)])
    key = result.stdout.strip()
    if not key:
        return None
    match = re.fullmatch(r"([A-G](?:b|#)?)(m?)", key)
    if match is None or match[1] not in _PITCH_CLASSES:
        raise RuntimeError(f"Unexpected keyfinder-cli output: {key!r}")
    note = _NOTES[_PITCH_CLASSES[match[1]]]
    mode = "minor" if match[2] else "major"
    return f"{note} {mode}"


def transposed_key(original_key: str | None, pitch_semitones: float) -> str | None:
    if original_key is None:
        return None
    note, mode = original_key.split()
    if note not in _PITCH_CLASSES or mode not in ("major", "minor"):
        raise ValueError(f"Invalid original key: {original_key!r}")
    # Decimal avoids showing binary arithmetic artifacts in residual cents.
    # Precision also covers the full range of finite binary64 input values.
    with localcontext() as context:
        context.prec = 330
        pitch = Decimal(str(pitch_semitones))
        semitones = pitch.to_integral_value(rounding=ROUND_HALF_UP)
        cents = (pitch - semitones) * 100
        output_note = _NOTES[(_PITCH_CLASSES[note] + int(semitones)) % 12]
        output = f"{output_note} {mode}"
        if cents:
            amount = format(cents, "+f")
            if "." in amount:
                amount = amount.rstrip("0").rstrip(".")
            output += f" ({amount} cents)"
    return output


def modification_suffix(options: SeparationOptions) -> str:
    suffix = ""
    if options.pitch_semitones != 0:
        sign = "+" if options.pitch_semitones > 0 else ""
        suffix += f" - pitch{sign}{_number(options.pitch_semitones)}st"
    if options.tempo_percent != 100:
        suffix += f" - tempo{_number(options.tempo_percent)}pct"
    return suffix
