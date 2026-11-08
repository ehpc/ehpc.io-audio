"""Opt-in CREPE inference subprocess in the isolated Torch environment."""

# Neural imports remain local to the actual producer.
# ruff: noqa: PLC0415
import io
import json
import subprocess
import zipfile
from pathlib import Path

from separator.pitch import (
    FRAME_SECONDS,
)

SAMPLE_RATE = 16000
HOP_LENGTH = int(SAMPLE_RATE * FRAME_SECONDS)


def predict_pitch(source: Path, *, device: str = "cuda") -> bytes:
    """Return canonical PCM and real CREPE frames, without RMS or note assembly."""
    import numpy as np
    import torch  # ty: ignore[unresolved-import]
    import torchcrepe  # ty: ignore[unresolved-import]

    decoded = subprocess.run(
        [
            "ffmpeg",
            "-nostdin",
            "-v",
            "error",
            "-i",
            str(source),
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
    pitch, periodicity = torchcrepe.predict(
        torch.from_numpy(audio).unsqueeze(0),
        SAMPLE_RATE,
        hop_length=HOP_LENGTH,
        fmin=50,
        fmax=2006,
        model="full",
        # Keep CREPE's official local decoder, including the original precision.
        decoder=torchcrepe.decode.weighted_argmax,
        return_periodicity=True,
        batch_size=1024,
        device=device,
    )
    frames = {
        "pitch.f32": pitch.squeeze(0).cpu().numpy(),
        "periodicity.f32": periodicity.squeeze(0).cpu().numpy(),
    }
    if any(not np.isfinite(values).all() for values in frames.values()):
        raise ValueError("Pitch prediction requires finite frames")
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w") as archive:
        archive.writestr("audio.f32", decoded)
        for name, values in frames.items():
            archive.writestr(name, values.astype("<f4", copy=False).tobytes())
        archive.writestr(
            "metadata.json",
            json.dumps(
                {"sample_rate": SAMPLE_RATE, "duration_s": audio.size / SAMPLE_RATE},
                allow_nan=False,
            ),
        )
    return stream.getvalue()
