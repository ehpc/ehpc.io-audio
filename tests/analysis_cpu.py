"""Owned deterministic signal analysis for cache tests, not a neural substitute."""

import math
import wave
from array import array
from itertools import pairwise
from pathlib import Path

RATE = 16000
WORDS = ("hello", "bright", "blue", "world")


def signal(path: Path):
    samples = array("h", [0] * (RATE // 10))
    for frequency in (220, 330, 440, 660):
        samples.extend(
            round(18000 * math.sin(2 * math.pi * frequency * i / RATE))
            for i in range(RATE // 4)
        )
        samples.extend([0] * (RATE // 10))
    with wave.open(str(path), "wb") as output:
        output.setparams((1, 2, RATE, 0, "NONE", "not compressed"))
        output.writeframes(samples.tobytes())


def load(path: Path):
    with wave.open(str(path)) as source:
        assert source.getnchannels() == 1 and source.getsampwidth() == 2
        samples = array("h", source.readframes(source.getnframes()))
        return samples, source.getframerate()


def spans(samples, rate=RATE):
    step = rate // 100
    active = []
    start = None
    for offset in range(0, len(samples), step):
        energetic = any(abs(value) > 1000 for value in samples[offset : offset + step])
        if energetic and start is None:
            start = offset
        if not energetic and start is not None:
            active.append((start, offset))
            start = None
    if start is not None:
        active.append((start, len(samples)))
    return active


def frequencies(samples, rate=RATE):
    result = []
    for start, end in spans(samples, rate):
        block = samples[start:end]
        crossing = sum(a <= 0 < b for a, b in pairwise(block))
        result.append((start / rate, end / rate, crossing * rate / len(block)))
    return result
