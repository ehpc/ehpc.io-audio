"""Portable real-inference endpoint for the ephemeral mixer integration test.

Kept separate from the pytest/web module: GPU Python is 3.13, the client is 3.15,
and serialized function bytecode is not portable between those interpreters.
"""

import tempfile
from pathlib import Path

from separator.options import OPTIONS_SCHEMA_VERSION, SeparationOptions
from separator.stems import SeparationResult, run_separation


def isolated_separate(
    audio_bytes: bytes,
    filename: str,
    options: SeparationOptions,
    *,
    options_schema: int,
) -> SeparationResult:
    if options_schema != OPTIONS_SCHEMA_VERSION:
        raise ValueError("incompatible separation options schema")
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        source = root / "source.wav"
        source.write_bytes(audio_bytes)
        return run_separation(
            source, options, root, "/private-models", "/private-models/stems"
        )
