"""Opt-in real model operations through the isolated single GPU pool.

CPU orchestration, output caches and native mixing run in this test process;
the deployed function receives only finite inference requests.
"""

import json
import math
import struct
import subprocess
import tempfile
import wave
from io import BytesIO
from pathlib import Path

import pytest
from gpu_smoke import gpu_context

from separator.modal_app import TIMEOUT as MODAL_FUNCTION_TIMEOUT_S
from separator.options import MixSpec, SeparationOptions
from separator.processing import run_processing

# The suite-wide timeout is sized for CPU tests. Weights are prepared before
# this suite; allow a cold GPU container and actual inference without hiding
# the remote operation's own timeout.
pytestmark = [
    pytest.mark.smoke,
    pytest.mark.timeout(MODAL_FUNCTION_TIMEOUT_S + 300),
]


@pytest.fixture(scope="module")
def voiced_wav() -> bytes:
    """Use the same qualified, licensed multi-voice music as browser E2E.

    A tone is not sufficient: models legitimately discard absent vocal parts,
    so a sine-only test cannot exercise gender, backing, or dry-vocal outputs.
    The shared generator verifies pinned CC-BY source checksums and mixes its
    own accompaniment; Node and FFmpeg are also needed by the browser suite.
    """
    return subprocess.run(
        [
            "node",
            "--input-type=module",
            "-e",
            "import { randomBytes } from 'node:crypto';"
            "import { vocalFixture } from './frontend/e2e/fixture.mjs';"
            "process.stdout.write(await vocalFixture(randomBytes(4).readUInt32LE()));",
        ],
        cwd=Path(__file__).resolve().parent.parent,
        check=True,
        capture_output=True,
        timeout=180,
    ).stdout


def _decoded_audio_contract(
    data: bytes, duration: float, channels: int
) -> dict[str, float | int | str]:
    """Verify actual decoded audio, not container headers or byte counts."""
    with tempfile.TemporaryDirectory(prefix="vocals-smoke-") as directory:
        source = Path(directory) / "stem.mp3"
        source.write_bytes(data)
        probe = json.loads(
            subprocess.run(
                [
                    "ffprobe",
                    "-v",
                    "error",
                    "-select_streams",
                    "a:0",
                    "-show_entries",
                    "stream=codec_name,channels,sample_rate",
                    "-of",
                    "json",
                    str(source),
                ],
                check=True,
                capture_output=True,
                text=True,
            ).stdout
        )["streams"][0]
        assert probe["codec_name"] == "mp3"
        assert probe["channels"] == channels
        sample_rate = int(probe["sample_rate"])
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
                "-f",
                "f32le",
                "pipe:1",
            ],
            check=True,
            capture_output=True,
        ).stdout
    seconds = len(decoded) / 4 / channels / sample_rate
    assert abs(seconds - duration) < 0.2
    energy = 0.0
    peak = 0.0
    for (sample,) in struct.iter_unpack("<f", decoded):
        assert math.isfinite(sample)
        energy += sample * sample
        peak = max(peak, abs(sample))
    rms = math.sqrt(energy / (len(decoded) / 4))
    assert rms > 1e-7, "model output contains no decoded signal"
    assert peak <= 1.05
    return {
        "codec": probe["codec_name"],
        "channels": channels,
        "sample_rate": sample_rate,
        "duration_s": seconds,
        "rms": rms,
        "peak": peak,
    }


@pytest.mark.parametrize(
    ("options", "expected"),
    [
        (
            SeparationOptions(extract_vocals=True, extract_instruments=True),
            ["vocals", "instruments"],
        ),
        (
            SeparationOptions(
                mixes=tuple(
                    MixSpec(
                        f"mix-{part}", f"{part} + instruments", (part, "instruments")
                    )
                    for part in ("female", "male", "backing", "lead")
                ),
                dereverb=True,
            ),
            [
                "mix-female",
                "mix-male",
                "mix-backing",
                "mix-lead",
            ],
        ),
    ],
    ids=["explicit-extraction", "mix-only-dry-vocals"],
)
def test_deployed_function_separates_audio(
    options: SeparationOptions, expected: list[str], voiced_wav: bytes, tmp_path: Path
) -> None:
    """Check the deployed image, models, CUDA, and output contract directly.

    The browser suite additionally exercises the HTTP/queue/native boundaries.
    Version-matching artifacts are reusable; this test never bypasses the cache.
    """
    source_path = tmp_path / "smoke-voiced-music.wav"
    source_path.write_bytes(voiced_wav)
    result = run_processing(
        source_path, options, tmp_path, gpu_context(tmp_path / "computed")
    ).audio

    assert list(result) == expected
    with wave.open(BytesIO(voiced_wav)) as source:
        duration = source.getnframes() / source.getframerate()
        channels = source.getnchannels()
    for label, stem in result.items():
        media = _decoded_audio_contract(stem.data, duration, channels)
        print(f"SMOKE_AUDIO {json.dumps({'label': label, **media})}")
