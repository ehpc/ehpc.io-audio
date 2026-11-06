"""Owned, ephemeral noncommercial GPU proof; never calls a deployed function.

SongFormer CC-BY-4.0 incorporates MuQ CC-BY-NC-4.0 weights. This development
check is noncommercial only; commercial deployment requires rights clearance.
"""

import json
import math
import os
import re
from dataclasses import asdict
from pathlib import Path

import modal
import pytest
from lyrics_fixture import full_sung_song

from backend import config
from separator.lyrics import transcript_from_json, transcript_text
from separator.modal_app import ASR_PYTHON, GPU, STRUCTURE_PYTHON, TIMEOUT, image

pytestmark = [pytest.mark.smoke, pytest.mark.timeout(TIMEOUT + 1200)]


def test_owned_noncommercial_full_song_structure_and_short_tail(tmp_path: Path) -> None:
    source = tmp_path / "full-song.ogg"
    source.write_bytes(full_sung_song())
    app = modal.App("lyrics-structure-noncommercial-smoke")
    volume = modal.Volume.from_name(
        "lyrics-structure-noncommercial-models",
        environment_name=config.MODAL_ENVIRONMENT,
        create_if_missing=True,
    )
    script = f"""
import json
import subprocess
from dataclasses import asdict
from pathlib import Path
from separator.options import SeparationOptions
from separator.processing import run_processing
from separator.lyrics import transcript_text
result = run_processing(
    Path('/tmp/full-song.ogg'), SeparationOptions(extract_lyrics=True),
    Path('/tmp'), '/dev-model-cache', '/dev-model-cache/stems', {TIMEOUT},
    {ASR_PYTHON!r}, {STRUCTURE_PYTHON!r},
)
assert result.transcript is not None
text = transcript_text(result.transcript.segments, result.transcript.sections)
# 420s + 480 samples: the genuine complete song followed by silence. The
# upstream outer chunk loop previously never advanced past this short tail.
subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', '/tmp/full-song.ogg',
    '-af', 'apad', '-t', '420.02', '-ar', '24000', '-ac', '1',
    '/tmp/short-tail.wav'], check=True)
subprocess.run([{STRUCTURE_PYTHON!r}, '-m', 'separator.structure',
    '/tmp/short-tail.wav', '/dev-model-cache/songformer', '/tmp/short-tail.json'],
    check=True, timeout={TIMEOUT}, cwd='/root')
print('STRUCTURE_REAL_RESULT ' + json.dumps(dict(
    transcript=asdict(result.transcript),
    text=text,
    short_tail=json.loads(Path('/tmp/short-tail.json').read_text()),
)))
"""
    with app.run(environment_name=config.MODAL_ENVIRONMENT):
        sandbox = modal.Sandbox.create(
            "python",
            "-c",
            script,
            app=app,
            image=image.add_local_file(source, "/tmp/full-song.ogg", copy=False),
            gpu=GPU,
            volumes={"/dev-model-cache": volume},
            timeout=TIMEOUT * 2,
            workdir="/root",
        )
        try:
            sandbox.wait()
            stdout, stderr = sandbox.stdout.read(), sandbox.stderr.read()
            assert sandbox.returncode == 0, stderr
            result = json.loads(
                next(
                    line.removeprefix("STRUCTURE_REAL_RESULT ")
                    for line in stdout.splitlines()
                    if line.startswith("STRUCTURE_REAL_RESULT ")
                )
            )
            transcript_json = json.dumps(result["transcript"])
            transcript = transcript_from_json(transcript_json)
            text = result["text"]
            assert transcript.timestamp_reference == "original"
            assert transcript.status == "recognized"
            assert {"verse", "chorus"} <= {s.label for s in transcript.sections}
            sung_text = " ".join(s.text for s in transcript.segments).lower()
            assert "acquaintance" in sung_text
            assert transcript.sections[0].start_s == 0
            assert 141 < transcript.sections[-1].end_s < 142
            assert all(
                math.isfinite(s.start_s)
                and math.isfinite(s.end_s)
                and 0 <= s.start_s < s.end_s
                for s in transcript.sections
            )
            assert text == transcript_text(transcript.segments, transcript.sections)
            assert " --> " not in text
            formatted_lines = re.findall(r"^\[\d+:\d{2}\] (.*)$", text, re.MULTILINE)
            assert formatted_lines == [s.text for s in transcript.segments]
            tail = result["short_tail"]
            assert abs(tail["sections"][-1]["end_s"] - 420.02) < 1 / 24000
            assert tail["sections"][0]["start_s"] == 0
            assert all(
                math.isfinite(s["start_s"])
                and math.isfinite(s["end_s"])
                and 0 <= s["start_s"] < s["end_s"]
                for s in tail["sections"]
            )
            evidence = os.environ.get("STRUCTURE_EVIDENCE_DIR")
            if evidence:
                directory = Path(evidence)
                directory.mkdir(parents=True, exist_ok=True)
                (directory / "transcript.json").write_text(transcript_json)
                (directory / "lyrics.txt").write_text(text)
                (directory / "short-tail.json").write_text(json.dumps(tail))
            print(stdout)
            print("STRUCTURE_MUSIC_PROOF " + json.dumps(asdict(transcript)))
        finally:
            sandbox.terminate()
