"""Real noncommercial structure inference through the isolated single GPU pool.

SongFormer CC-BY-4.0 incorporates MuQ CC-BY-NC-4.0 weights. This development
check is noncommercial only; commercial deployment requires rights clearance.
"""

import json
import math
import os
import re
import subprocess
from dataclasses import asdict
from pathlib import Path

import pytest
from gpu_smoke import gpu_context
from lyrics_fixture import full_sung_song

from separator.artifact_cache import digest
from separator.lyrics import transcript_text
from separator.modal_app import TIMEOUT
from separator.options import SeparationOptions
from separator.processing import run_processing
from separator.structure import assemble_structure

pytestmark = [pytest.mark.smoke, pytest.mark.timeout(TIMEOUT + 1200)]


def test_owned_noncommercial_full_song_structure_and_short_tail(tmp_path: Path) -> None:
    source = tmp_path / "full-song.ogg"
    source.write_bytes(full_sung_song())
    context = gpu_context(tmp_path / "computed")
    result = run_processing(
        source, SeparationOptions(extract_lyrics=True), tmp_path, context
    )
    transcript = result.transcript
    assert transcript is not None
    text = transcript_text(transcript.segments, transcript.sections)
    # Keep the complete song followed by silence, including the genuine
    # 480-sample short tail that previously stalled the outer model chunk loop.
    tail_source = tmp_path / "short-tail.wav"
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-y",
            "-i",
            str(source),
            "-af",
            "apad",
            "-t",
            "420.02",
            "-ar",
            "24000",
            "-ac",
            "1",
            str(tail_source),
        ],
        check=True,
        capture_output=True,
    )
    tail_bytes = tail_source.read_bytes()

    def parse_structure(payload: bytes):
        return assemble_structure(**json.loads(payload))

    tail = asdict(
        context.stage(
            "structure",
            tail_bytes,
            tail_source.name,
            {},
            digest(tail_bytes),
            parse_structure,
        )
    )
    transcript_json = json.dumps(asdict(transcript))
    assert transcript.timestamp_reference == "original"
    assert transcript.status == "recognized"
    assert {"verse", "chorus"} <= {section.label for section in transcript.sections}
    sung_text = " ".join(segment.text for segment in transcript.segments).lower()
    assert "acquaintance" in sung_text
    assert transcript.sections[0].start_s == 0
    assert 141 < transcript.sections[-1].end_s < 142
    assert all(
        math.isfinite(section.start_s)
        and math.isfinite(section.end_s)
        and 0 <= section.start_s < section.end_s
        for section in transcript.sections
    )
    assert text == transcript_text(transcript.segments, transcript.sections)
    assert " --> " not in text
    formatted_lines = re.findall(r"^\[\d+:\d{2}\] (.*)$", text, re.MULTILINE)
    assert formatted_lines == [segment.text for segment in transcript.segments]
    assert abs(tail["sections"][-1]["end_s"] - 420.02) < 1 / 24000
    assert tail["sections"][0]["start_s"] == 0
    assert all(
        math.isfinite(section["start_s"])
        and math.isfinite(section["end_s"])
        and 0 <= section["start_s"] < section["end_s"]
        for section in tail["sections"]
    )
    evidence = os.environ.get("STRUCTURE_EVIDENCE_DIR")
    if evidence:
        directory = Path(evidence)
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "transcript.json").write_text(transcript_json)
        (directory / "lyrics.txt").write_text(text)
        (directory / "short-tail.json").write_text(json.dumps(tail))
    print(
        "STRUCTURE_REAL_RESULT "
        + json.dumps({"transcript": asdict(transcript), "short_tail": tail})
    )
    print("STRUCTURE_MUSIC_PROOF " + json.dumps(asdict(transcript)))
