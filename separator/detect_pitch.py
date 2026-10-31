"""Opt-in CREPE inference subprocess in the isolated Torch environment."""

import json
import subprocess
import sys
from pathlib import Path

import numpy as np  # ty: ignore[unresolved-import]
import torch  # ty: ignore[unresolved-import]
import torchcrepe  # ty: ignore[unresolved-import]

from separator.pitch import (
    FRAME_SECONDS,
    PitchAnalysis,
    PitchTrack,
    pitch_to_json,
    segment_frames,
)

SAMPLE_RATE = 16000
HOP_LENGTH = int(SAMPLE_RATE * FRAME_SECONDS)


def detect_tracks(sources: dict[str, str], *, device: str = "cuda") -> PitchAnalysis:
    tracks = []
    duration_s = 0.0
    for label, filename in sources.items():
        decoded = subprocess.run(
            [
                "ffmpeg",
                "-nostdin",
                "-v",
                "error",
                "-i",
                filename,
                "-map",
                "0:a:0",
                "-ac",
                "1",
                "-ar",
                str(SAMPLE_RATE),
                "-f",
                "f32le",
                "pipe:1",
            ],
            check=True,
            capture_output=True,
        ).stdout
        audio = np.frombuffer(decoded, dtype="<f4").copy()
        if not audio.size or not np.isfinite(audio).all():
            raise ValueError("Pitch detection requires finite, nonempty audio")
        duration_s = max(duration_s, audio.size / SAMPLE_RATE)
        pitch, periodicity = torchcrepe.predict(
            torch.from_numpy(audio).unsqueeze(0),
            SAMPLE_RATE,
            hop_length=HOP_LENGTH,
            fmin=50,
            fmax=2006,
            model="full",
            # CREPE's official local decoder; the default Viterbi can lock to
            # the range edge across rests even for calibrated voiced tones.
            decoder=torchcrepe.decode.weighted_argmax,
            return_periodicity=True,
            batch_size=1024,
            device=device,
        )
        # Centered 64 ms RMS windows match CREPE's input windows. Absolute
        # gating is essential: its periodicity is not a silence detector.
        squared = np.pad(audio.astype(np.float64) ** 2, (512, 512))
        cumulative = np.concatenate(([0.0], np.cumsum(squared)))
        starts = np.arange(pitch.shape[-1]) * HOP_LENGTH
        ends = np.minimum(starts + 1024, squared.size)
        levels = np.sqrt((cumulative[ends] - cumulative[starts]) / 1024)
        notes = segment_frames(
            pitch.squeeze(0).cpu().tolist(),
            periodicity.squeeze(0).cpu().tolist(),
            levels.tolist(),
            audio.size / SAMPLE_RATE,
        )
        tracks.append(PitchTrack(label, notes))
    return PitchAnalysis(duration_s, duration_s, tracks)


if __name__ == "__main__":
    sources = json.loads(Path(sys.argv[1]).read_text("utf-8"))
    result = detect_tracks(sources)
    Path(sys.argv[2]).write_text(pitch_to_json(result), "utf-8")
