"""Opt-in tests against the deployed Modal app (`make smoke`).

Needs Modal auth and a prior `make deploy-modal`; CI runs them right after
deploying. They cover the far side of the boundary that tests/test_e2e.py fakes.
"""

import math
import struct
import wave
from io import BytesIO

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

_SAMPLE_RATE = 44_100
_TONE_SECONDS = 5


def _tone_wav() -> bytes:
    """A short stereo tone, built with the stdlib so this needs no ffmpeg locally.

    Two sines (a low 110 Hz and a higher 440 Hz) give the models something with
    structure to pull apart. The point is that a real separation runs and returns
    playable stems — not that the split is musically meaningful.
    """
    frames = bytearray()
    for i in range(_SAMPLE_RATE * _TONE_SECONDS):
        t = i / _SAMPLE_RATE
        frames += struct.pack(
            "<hh",
            int(12_000 * math.sin(2 * math.pi * 110 * t)),
            int(12_000 * math.sin(2 * math.pi * 440 * t)),
        )
    buffer = BytesIO()
    with wave.open(buffer, "wb") as wav:
        wav.setnchannels(2)
        wav.setsampwidth(2)
        wav.setframerate(_SAMPLE_RATE)
        wav.writeframes(frames)
    return buffer.getvalue()


def _is_mp3(data: bytes) -> bool:
    """MP3s start with an ID3 tag or a raw frame sync (eleven set bits)."""
    return data.startswith(b"ID3") or (
        len(data) > 1 and data[0] == 0xFF and data[1] & 0xE0 == 0xE0
    )


def test_deployed_container_can_import_separator_package() -> None:
    # Regression for the deploy packaging bug: the deployed function crash-looped
    # with `ModuleNotFoundError: No module named 'separator'` until the image
    # included the package. If healthcheck returns, the container imported it.
    # Opt-in (marker `smoke`); needs Modal auth + a prior `make deploy-modal`.
    fn = modal.Function.from_name(config.MODAL_APP_NAME, "healthcheck")
    assert fn.remote() == "ok"


def test_deployed_function_separates_audio() -> None:
    """Runs a real separation on the GPU function — the one thing no other test
    can check: that the image's audio-separator, its models and the CUDA stack
    actually produce stems.

    `no_cache=True` so a repeat run can't be served from the stem cache, which
    would quietly stop exercising separation at all (and would pollute the cache
    volume with a test tone).
    """
    fn = modal.Function.from_name(config.MODAL_APP_NAME, config.MODAL_FUNCTION_NAME)
    result: dict[str, StemResult] = fn.remote(
        _tone_wav(), "smoke-tone.wav", SeparationOptions(no_cache=True)
    )

    assert sorted(result) == ["instruments", "vocals"]
    for label, stem in result.items():
        assert stem.duration_s > 0, f"{label} reports no separation time"
        assert _is_mp3(stem.data), f"{label} is not an mp3: {stem.data[:4]!r}"
        # A 5s mp3 is ~80 KB; anything tiny means an empty or truncated stem.
        assert len(stem.data) > 10_000, f"{label} is only {len(stem.data)} bytes"
