"""Opt-in real full-song vocals/words and calibrated neural F0 checks."""

import json
import os
import time
from collections import Counter
from dataclasses import asdict
from pathlib import Path

import modal
import pytest
from lyrics_fixture import full_sung_song

from backend import config
from backend.modal_client import LYRICS_FUNCTION_NAME
from separator.modal_app import GPU, STRUCTURE_PYTHON, TIMEOUT, image
from separator.options import SeparationOptions
from separator.pitch import pitch_from_json
from separator.processing import ProcessingResult

pytestmark = [pytest.mark.smoke, pytest.mark.timeout(TIMEOUT + 600)]


def test_deployed_full_singing_per_stem_words_and_fractional_transform() -> None:
    assert config.MODAL_APP_NAME != "audio-separator", "Use an isolated test app"
    source = full_sung_song()
    started = time.monotonic()
    result: ProcessingResult = modal.Function.from_name(
        config.MODAL_APP_NAME, LYRICS_FUNCTION_NAME
    ).remote(
        source,
        "auld-lang-syne-full.ogg",
        SeparationOptions(
            detect_pitch=True,
            extract_lyrics=True,
            extract_vocals=True,
            lead_backing=True,
            pitch_semitones=1.25,
            tempo_percent=125,
        ),
    )
    elapsed = time.monotonic() - started
    assert list(result.audio) == ["vocals", "lead", "backing"]
    assert result.pitch_json is not None
    analysis = pitch_from_json(result.pitch_json)
    assert [track.label for track in analysis.tracks] == ["vocals", "lead", "backing"]
    assert 141 < analysis.source_duration_s < 142
    assert analysis.duration_s == pytest.approx(analysis.source_duration_s / 1.25)
    assert analysis.pitch_shift_semitones == 1.25
    assert analysis.timestamp_reference == analysis.pitch_reference == "output"
    assert analysis.word_alignment == "whisper-approximate"
    assert all(
        0.21 <= note.confidence <= 1
        for track in analysis.tracks
        for note in track.notes
    )
    associations = Counter(
        index for note in analysis.tracks[0].notes for index in note.word_indices
    )
    assert any(count > 1 for count in associations.values()), (
        "Real singing must retain word-to-many-note links"
    )
    transcript = result.transcript
    assert transcript is not None
    assert transcript.timestamp_reference == "original"
    assert transcript.segments[-1].end_s > 100
    recognized = " ".join(segment.text for segment in transcript.segments).casefold()
    assert "acquaintance be forgot" in recognized
    assert "cup of kindness" in recognized
    assert "auld lang syne" in recognized
    acquaintance = next(
        word for word in analysis.words if word.text.casefold() == "acquaintance"
    )
    assert 14 < acquaintance.start_s * 1.25 < 17
    for track in analysis.tracks[:2]:
        assert any(
            note.start_s < acquaintance.end_s and note.end_s > acquaintance.start_s
            for note in track.notes
        ), f"{track.label} must detect pitch during the independently known sung word"
    assert transcript.reference is not None
    assert transcript.reference.status == "skipped"
    assert transcript.reference.original_words == transcript.words
    for original, output in zip(transcript.words, analysis.words, strict=True):
        assert output.start_s == pytest.approx(original.start_s / 1.25)
        assert output.end_s == pytest.approx(original.end_s / 1.25)
        assert output.text == original.text
    evidence = os.environ.get("PITCH_EVIDENCE_DIR")
    if evidence:
        directory = Path(evidence)
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "pitch.json").write_text(result.pitch_json, "utf-8")
        (directory / "transcript.json").write_text(
            json.dumps(asdict(transcript), ensure_ascii=False), "utf-8"
        )
        for label, audio in result.audio.items():
            (directory / f"{label}.mp3").write_bytes(audio.data)
        (directory / "runtime.json").write_text(
            json.dumps(
                {
                    "elapsed_s": elapsed,
                    "source_bytes": len(source),
                    "notes": {
                        track.label: len(track.notes) for track in analysis.tracks
                    },
                    "words": len(analysis.words),
                }
            ),
            "utf-8",
        )
    print(
        "SMOKE_PITCH_FULL_SONG "
        + json.dumps(
            {
                "elapsed_s": elapsed,
                "notes": {track.label: len(track.notes) for track in analysis.tracks},
                "words": len(analysis.words),
            }
        )
    )


def test_real_estimator_known_pitches_and_silence_keep_gpu_dependencies_isolated() -> (
    None
):
    assert config.MODAL_APP_NAME != "audio-separator", "Use an isolated test app"
    script = f"""
import importlib.metadata
import json
import subprocess
from pathlib import Path
import onnxruntime
for label, frequency, start, end in (
    ('lead', 261.625565, 0.6, 1.6), ('backing', 440, 2, 3.2),
):
    expression = (
        f'aevalsrc=if(between(t\\\\,{{start}}\\\\,{{end}})\\\\,'
        f'0.2*sin(2*PI*{{frequency}}*t)+0.08*sin(4*PI*{{frequency}}*t)\\\\,0):s=16000:d=4'
    )
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i',
        expression, f'/tmp/{{label}}.wav'], check=True)
Path('/tmp/sources.json').write_text(json.dumps(dict(
    lead='/tmp/lead.wav', backing='/tmp/backing.wav',
)))
subprocess.run([{STRUCTURE_PYTHON!r}, '-m', 'separator.detect_pitch',
    '/tmp/sources.json', '/tmp/calibrated.json'], check=True, cwd='/root')
print('PITCH_CALIBRATED ' + json.dumps(dict(
    analysis=json.loads(Path('/tmp/calibrated.json').read_text()),
    separator_runtime=importlib.metadata.version('onnxruntime-gpu'),
    separator_providers=onnxruntime.get_available_providers(),
)))
"""
    sandbox = modal.Sandbox.create(
        "python",
        "-c",
        script,
        app=modal.App.lookup(config.MODAL_APP_NAME),
        image=image,
        gpu=GPU,
        timeout=300,
        workdir="/root",
    )
    try:
        sandbox.wait()
        stdout, stderr = sandbox.stdout.read(), sandbox.stderr.read()
        assert sandbox.returncode == 0, stderr
        result = json.loads(
            next(
                line.removeprefix("PITCH_CALIBRATED ")
                for line in stdout.splitlines()
                if line.startswith("PITCH_CALIBRATED ")
            )
        )
        assert "CUDAExecutionProvider" in result["separator_providers"]
        tracks = result["analysis"]["tracks"]
        assert [track["label"] for track in tracks] == ["lead", "backing"]
        assert [note["note"] for note in tracks[0]["notes"]] == ["C4"]
        assert [note["note"] for note in tracks[1]["notes"]] == ["A4"]
        lead, backing = tracks[0]["notes"][0], tracks[1]["notes"][0]
        assert lead["start_s"] == pytest.approx(0.6, abs=0.08)
        assert lead["end_s"] == pytest.approx(1.6, abs=0.08)
        assert backing["start_s"] == pytest.approx(2, abs=0.08)
        assert backing["end_s"] == pytest.approx(3.2, abs=0.08)
        assert abs(lead["midi"] - 60) < 0.35
        assert abs(backing["midi"] - 69) < 0.35
        print("SMOKE_PITCH_CALIBRATED " + json.dumps(result))
    finally:
        sandbox.terminate()
