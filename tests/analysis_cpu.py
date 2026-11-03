"""Owned deterministic signal analysis for cache tests, not a neural substitute."""

import json
import math
import os
import sys
import wave
from array import array
from dataclasses import asdict
from itertools import pairwise
from pathlib import Path

from separator.lyrics import Transcript, TranscriptSegment, TranscriptWord
from separator.pitch import PitchAnalysis, PitchNote, PitchTrack, pitch_to_json

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


def main():
    module = sys.argv[2]
    stage = module.rsplit(".", 1)[-1]
    if stage in os.environ.get("ANALYSIS_FORBID", "").split(","):
        raise AssertionError(f"persistent analysis hit invoked {stage}")
    with Path(os.environ["ANALYSIS_TRACE"]).open("a") as handle:
        handle.write(stage + "\n")
    if stage == "detect_pitch":
        sources = json.loads(Path(sys.argv[3]).read_text())
        label, filename = next(iter(sources.items()))
        samples, rate = load(Path(filename))
        notes = [
            PitchNote(start, end, 69 + 12 * math.log2(hz / 440), hz, 0.95)
            for start, end, hz in frequencies(samples, rate)
        ]
        duration = len(samples) / rate
        Path(sys.argv[4]).write_text(
            pitch_to_json(PitchAnalysis(duration, duration, [PitchTrack(label, notes)]))
        )
    else:
        samples, rate = load(Path(sys.argv[3]))
        if stage == "transcribe":
            text = os.environ.get("ANALYSIS_WORDS", "hello bright blue world").split()
            words = [
                TranscriptWord(start, end, word, alignment_score=0.95)
                for (start, end, _), word in zip(
                    frequencies(samples, rate), text, strict=True
                )
            ]
            transcript = Transcript(
                [TranscriptSegment(words[0].start_s, words[-1].end_s, " ".join(text))],
                "en",
                words=words,
                word_alignment="owned-cpu-energy-alignment-v1",
            )
            value = asdict(transcript)
        else:
            value = {
                "sections": [
                    {
                        "start_s": 0,
                        "end_s": len(samples) / rate,
                        "label": os.environ.get("ANALYSIS_SECTION", "verse"),
                    }
                ],
                "structure_model": "owned-cpu-structure-v1",
            }
        Path(sys.argv[5]).write_text(json.dumps(value))


if __name__ == "__main__":
    main()
