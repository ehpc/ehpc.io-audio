"""Opt-in tests against the deployed Modal app (`make smoke`).

Needs Modal auth and a prior `make deploy-modal`; CI runs them right after
deploying. They cover the far side of the boundary that tests/test_e2e.py fakes.
"""

import json
import math
import struct
import subprocess
import tempfile
import wave
from io import BytesIO
from pathlib import Path

import modal
import pytest

from backend import config
from separator.modal_app import TIMEOUT as MODAL_FUNCTION_TIMEOUT_S
from separator.options import SeparationOptions
from separator.stems import StemResult

# The suite-wide --timeout is sized for local tests; a cold run here waits on a
# container boot, a model download and the GPU pass. Allow more than the Modal
# function's own timeout so its error surfaces instead of a pytest timeout.
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


def test_deployed_container_can_import_separator_package() -> None:
    # Regression for the deploy packaging bug: the deployed function crash-looped
    # with `ModuleNotFoundError: No module named 'separator'` until the image
    # included the package. If healthcheck returns, the container imported it.
    # Opt-in (marker `smoke`); needs Modal auth + a prior `make deploy-modal`.
    fn = modal.Function.from_name(config.MODAL_APP_NAME, "healthcheck")
    assert fn.remote() == "ok"


@pytest.mark.parametrize(
    ("options", "expected"),
    [
        (
            SeparationOptions(
                extract_vocals=True, extract_instruments=True, no_cache=True
            ),
            ["vocals", "instruments"],
        ),
        (
            SeparationOptions(
                mix_female_instruments=True,
                mix_male_instruments=True,
                mix_backing_instruments=True,
                mix_lead_instruments=True,
                dereverb=True,
                no_cache=True,
            ),
            [
                "female-instruments",
                "male-instruments",
                "backing-instruments",
                "lead-instruments",
            ],
        ),
    ],
    ids=["explicit-extraction", "mix-only-dry-vocals"],
)
def test_deployed_function_separates_audio(
    options: SeparationOptions, expected: list[str], voiced_wav: bytes
) -> None:
    """Check the deployed image, models, CUDA, and output contract directly.

    The browser suite additionally exercises the HTTP/queue/native boundaries.
    `no_cache=True` ensures this check always executes real model inference
    without populating the shared raw-stem cache with fixture outputs.
    """
    fn = modal.Function.from_name(config.MODAL_APP_NAME, config.MODAL_FUNCTION_NAME)
    result: dict[str, StemResult] = fn.remote(
        voiced_wav,
        "smoke-voiced-music.wav",
        options,
    )

    assert list(result) == expected
    with wave.open(BytesIO(voiced_wav)) as source:
        duration = source.getnframes() / source.getframerate()
        channels = source.getnchannels()
    for label, stem in result.items():
        if label in {"vocals", "instruments"}:
            assert stem.duration_s > 0, f"{label} bypass must perform fresh inference"
        media = _decoded_audio_contract(stem.data, duration, channels)
        print(f"SMOKE_AUDIO {json.dumps({'label': label, **media})}")
