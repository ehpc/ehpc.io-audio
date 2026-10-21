"""Small real PCM fixtures and MP3 measurements without scientific dependencies."""

import io
import json
import math
import statistics
import struct
import subprocess
import sys
import wave
from array import array
from dataclasses import dataclass
from itertools import pairwise
from pathlib import Path


def tone_wav(
    frequencies: tuple[float, ...], duration_s: float = 4.0, *, channels: int = 1
) -> bytes:
    sample_rate = 22050
    frames = bytearray()
    for index in range(round(duration_s * sample_rate)):
        value = sum(
            math.sin(2 * math.pi * frequency * index / sample_rate)
            for frequency in frequencies
        )
        sample = round(24000 * value / max(1, len(frequencies)))
        frames.extend(struct.pack("<h", sample) * channels)
    stream = io.BytesIO()
    with wave.open(stream, "wb") as audio:
        audio.setnchannels(channels)
        audio.setsampwidth(2)
        audio.setframerate(sample_rate)
        audio.writeframes(frames)
    return stream.getvalue()


def mp3_measurements(audio_bytes: bytes) -> tuple[float, float]:
    """Return decoded duration and sine frequency via interpolated zero crossings."""
    sample_rate = 22050
    result = subprocess.run(
        [
            "ffmpeg",
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            "pipe:0",
            "-f",
            "s16le",
            "-ac",
            "1",
            "-ar",
            str(sample_rate),
            "pipe:1",
        ],
        input=audio_bytes,
        capture_output=True,
        check=True,
    )
    samples = array("h")
    samples.frombytes(result.stdout)
    # Ignore onset/tail transients; medians reject isolated MP3 artifacts.
    start = len(samples) // 4
    end = len(samples) * 3 // 4
    crossings = [
        index - samples[index] / (samples[index + 1] - samples[index])
        for index in range(start, end - 1)
        if samples[index] <= 0 < samples[index + 1]
    ]
    periods = [second - first for first, second in pairwise(crossings)]
    frequency = sample_rate / statistics.median(periods) if periods else 0.0
    return len(samples) / sample_rate, frequency


def ffmpeg_tone(
    path: Path,
    frequencies: tuple[float, ...],
    *,
    amplitude: float = 0.15,
    duration_s: float = 1.0,
    sample_rate: int = 48000,
    start_s: float = 0.0,
    end_s: float | None = None,
) -> Path:
    """Generate real float PCM using FFmpeg, one sine frequency per channel."""
    end_s = duration_s if end_s is None else end_s
    expressions = "|".join(
        f"{amplitude}*sin(2*PI*{frequency}*t)*between(t,{start_s},{end_s})"
        for frequency in frequencies
    )
    subprocess.run(
        [
            "ffmpeg",
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"aevalsrc=exprs='{expressions}':s={sample_rate}:d={duration_s}",
            "-c:a",
            "pcm_f32le",
            str(path),
        ],
        check=True,
        capture_output=True,
    )
    return path


@dataclass(frozen=True)
class DecodedAudio:
    sample_rate: int
    channels: tuple[array, ...]
    codec: str

    @property
    def duration_s(self) -> float:
        return len(self.channels[0]) / self.sample_rate

    @property
    def peak(self) -> float:
        return max(abs(sample) for channel in self.channels for sample in channel)


def decode_audio(audio_bytes: bytes) -> DecodedAudio:
    """Probe native stream properties and decode without downmixing or resampling."""
    probe = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "a:0",
            "-show_entries",
            "stream=sample_rate,channels,codec_name",
            "-of",
            "json",
            "pipe:0",
        ],
        input=audio_bytes,
        capture_output=True,
        check=True,
    )
    stream = json.loads(probe.stdout)["streams"][0]
    decoded = subprocess.run(
        [
            "ffmpeg",
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            "pipe:0",
            "-map",
            "0:a:0",
            "-f",
            "f32le",
            "-c:a",
            "pcm_f32le",
            "pipe:1",
        ],
        input=audio_bytes,
        capture_output=True,
        check=True,
    )
    samples = array("f")
    samples.frombytes(decoded.stdout)
    if sys.byteorder != "little":
        samples.byteswap()
    channel_count = int(stream["channels"])
    return DecodedAudio(
        sample_rate=int(stream["sample_rate"]),
        channels=tuple(
            samples[channel::channel_count] for channel in range(channel_count)
        ),
        codec=stream["codec_name"],
    )


def frequency_amplitude(
    audio: DecodedAudio,
    frequency: float,
    *,
    channel: int = 0,
    start_s: float = 0.15,
    end_s: float | None = None,
) -> float:
    """Measure sine amplitude by quadrature projection over a steady-state window."""
    end_s = audio.duration_s - 0.15 if end_s is None else end_s
    start = round(start_s * audio.sample_rate)
    end = round(end_s * audio.sample_rate)
    samples = audio.channels[channel][start:end]
    angular_step = 2 * math.pi * frequency / audio.sample_rate
    sine = sum(
        sample * math.sin(angular_step * index)
        for index, sample in enumerate(samples, start)
    )
    cosine = sum(
        sample * math.cos(angular_step * index)
        for index, sample in enumerate(samples, start)
    )
    return 2 * math.hypot(sine, cosine) / len(samples)


def active_bounds(
    audio: DecodedAudio, *, threshold: float = 0.02, window_s: float = 0.01
) -> tuple[float, float]:
    """Bound audible signal with short RMS windows, ignoring codec ringing."""
    width = round(window_s * audio.sample_rate)
    active = []
    for start in range(0, len(audio.channels[0]), width):
        segment = audio.channels[0][start : start + width]
        rms = math.sqrt(sum(sample * sample for sample in segment) / len(segment))
        if rms > threshold:
            active.append(start)
    if not active:
        raise AssertionError("Decoded audio contains no audible signal")
    return active[0] / audio.sample_rate, (active[-1] + width) / audio.sample_rate
