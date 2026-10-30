"""Known intelligible speech for genuine ASR regression checks.

JFK's US federal inaugural address is public domain (17 USC 105).
The unmodified FLAC and reference phrase assertions come from OpenAI Whisper's
MIT-licensed test suite, pinned to an immutable revision:
https://github.com/openai/whisper/tree/86098128c0b4f24f0e2aa2994de830614b474227/tests
This verifies transcription, not recognition accuracy for arbitrary singing.
"""

import hashlib
import sys
import urllib.request
from pathlib import Path

FIXTURE_URL = (
    "https://raw.githubusercontent.com/openai/whisper/"
    "86098128c0b4f24f0e2aa2994de830614b474227/tests/jfk.flac"
)
FIXTURE_SHA256 = "63a4b1e4c1dc655ac70961ffbf518acd249df237e5a0152faae9a4a836949715"


def intelligible_speech() -> bytes:
    with urllib.request.urlopen(FIXTURE_URL, timeout=60) as response:
        data = response.read()
    if hashlib.sha256(data).hexdigest() != FIXTURE_SHA256:
        raise ValueError("ASR reference fixture checksum mismatch")
    return data


def sung_excerpt() -> bytes:
    """Public-domain sung Auld Lang Syne, Frank C. Stanley (1910).

    Source: https://commons.wikimedia.org/wiki/File:Auld_Lang_Syne.ogg
    Audio: https://upload.wikimedia.org/wikipedia/commons/e/e3/Auld_Lang_Syne.ogg
    Source SHA256: 0d277de969ce02959923ec32fd94897a6791cf183fd954198d5e02166e36fb04
    Source SHA1 (Commons): 73829e0e2d0037c74309063739c51e3170740e50
    Indestructible Record #1267, UCSB Cylinder4410. Commons marks the recording
    PD-US-record-expired / public-domain life+100 / CC-PD-Mark; Robert Burns
    died1796 and Frank C. Stanley1910.

    Modification: source12-42s, FFmpeg decode/resample to mono16kHz PCM16,
    lossless FLAC compression8. No pitch or tempo processing.
    Independent timed captions (later repeated verse ends at source38s):
    https://commons.wikimedia.org/wiki/TimedText:Auld_Lang_Syne.ogg.en.srt
    """
    path = Path(__file__).with_name("fixtures") / "auld-lang-syne-30s.flac"
    data = path.read_bytes()
    expected = "ace9a14117c6c684664b964bddb5c71930a2c826c3caeb1ab9caf407ad6afbf3"
    if hashlib.sha256(data).hexdigest() != expected:
        raise ValueError("Sung reference fixture checksum mismatch")
    return data


def full_sung_song() -> bytes:
    """Uncut 141.5s original of the public-domain recording documented above."""
    path = Path(__file__).with_name("fixtures") / "auld-lang-syne-full.ogg"
    data = path.read_bytes()
    expected = "0d277de969ce02959923ec32fd94897a6791cf183fd954198d5e02166e36fb04"
    if hashlib.sha256(data).hexdigest() != expected:
        raise ValueError("Full sung reference fixture checksum mismatch")
    return data


if __name__ == "__main__":
    Path(sys.argv[1]).write_bytes(intelligible_speech())
