import asyncio
import json
import subprocess
from dataclasses import asdict
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

from backend import config, db, modal_client, queue
from separator.lyrics import (
    Transcript,
    TranscriptSection,
    TranscriptSegment,
    transcript_from_json,
    transcript_text,
)
from separator.options import SeparationOptions
from separator.processing import ProcessingResult, run_processing
from separator.stems import StemResult
from separator.structure import MODEL_PROVENANCE


def test_structure_keeps_all_predicted_intervals_and_whole_lyric_lines() -> None:
    sections = [
        TranscriptSection(0, 10, "intro"),
        TranscriptSection(10, 20, "verse"),
        TranscriptSection(20, 25, "pre-chorus"),
        TranscriptSection(25, 40, "chorus"),
        TranscriptSection(40, 50, "chorus"),
        TranscriptSection(50, 60, "inst"),
    ]
    segments = [
        TranscriptSegment(10.1, 12, "Verse line"),
        TranscriptSegment(19, 21, "Boundary tie stays whole"),
        TranscriptSegment(22.9, 24, "Before the chorus"),
        TranscriptSegment(25, 25, "Exact onset"),
        TranscriptSegment(39, 42, "Mostly second chorus"),
        TranscriptSegment(70, 72, "Uncovered words"),
    ]
    rendered = transcript_text(segments, sections)
    assert rendered == (
        "[Intro]\n\n[Verse]\n[00:10] Verse line\n"
        "[00:19] Boundary tie stays whole\n\n"
        "[Pre-chorus]\n[00:22] Before the chorus\n\n"
        "[Chorus]\n[00:25] Exact onset\n\n"
        "[Chorus]\n[00:39] Mostly second chorus\n\n"
        "[Instrumental]\n\n[01:10] Uncovered words\n"
    )
    for segment in segments:
        assert rendered.count(segment.text) == 1


def test_legacy_json_remains_readable_without_structure_fields() -> None:
    transcript = Transcript(
        [TranscriptSegment(1.125, 2.875, "歌声")],
        language="ja",
        sections=[TranscriptSection(0, 3.125, "pre-chorus")],
        structure_model=MODEL_PROVENANCE,
    )
    legacy = asdict(transcript)
    del legacy["sections"]
    del legacy["structure_model"]
    restored = transcript_from_json(json.dumps(legacy))
    assert restored.sections == []
    assert restored.structure_model is None
    assert restored.segments == transcript.segments


@pytest.mark.parametrize(
    "start,end,label",
    [
        (-1, 3, "verse"),
        (2, 2, "chorus"),
        (0, float("inf"), "intro"),
        (0, 3, "invented"),
        (float("nan"), 3, "bridge"),
    ],
)
def test_structure_rejects_invalid_intervals(start, end, label) -> None:
    with pytest.raises(ValueError):
        TranscriptSection(start, end, label)


def test_structure_rejects_overlapping_or_unsorted_intervals() -> None:
    with pytest.raises(ValueError, match="ordered"):
        Transcript(
            sections=[
                TranscriptSection(5, 9, "verse"),
                TranscriptSection(8, 12, "chorus"),
            ]
        )


def test_structure_without_recognition_still_shows_instrumental_sections() -> None:
    assert transcript_text([], [TranscriptSection(0, 3, "inst")]) == "[Instrumental]\n"
    assert transcript_text([]) == ""


def test_canonical_json_controls_txt_without_rewriting_legacy_files(
    client: TestClient, other_client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    transcript = Transcript(
        [TranscriptSegment(15.9, 18, "Keep these exact words")],
        language="en",
        sections=[
            TranscriptSection(0, 15, "intro"),
            TranscriptSection(15, 20, "pre-chorus"),
        ],
        structure_model=MODEL_PROVENANCE,
    )
    response = client.post(
        "/api/jobs",
        files={"file": ("song.wav", b"audio")},
        data={"extract_lyrics": "true"},
    )
    job_id = response.json()["id"]
    directory = config.RESULTS_DIR / str(job_id)
    directory.mkdir(parents=True)
    legacy = directory / "lyrics.txt"
    legacy.write_text("old timestamp format, do not rewrite", encoding="utf-8")
    monkeypatch.setattr(queue, "detect_key", lambda *args: None)
    monkeypatch.setattr(
        modal_client,
        "spawn_with_lyrics",
        lambda *args: MagicMock(object_id="fc-structure"),
    )
    monkeypatch.setattr(
        modal_client, "poll", lambda *args: ProcessingResult({}, transcript)
    )
    job = db.get_job(job_id)
    assert job is not None
    asyncio.run(queue._run_job(job))
    payload = client.get(f"/api/jobs/{job_id}/lyrics").json()
    assert payload["sections"] == [asdict(s) for s in transcript.sections]
    assert payload["structure_model"] == MODEL_PROVENANCE
    expected = transcript_text(transcript.segments, transcript.sections)
    assert payload["timestamped_text"] == expected
    assert client.get(f"/api/jobs/{job_id}/lyrics/download").text == expected
    assert legacy.read_text("utf-8") == "old timestamp format, do not rewrite"
    legacy.unlink()
    db.init_db()
    assert client.get(f"/api/jobs/{job_id}/lyrics/download").text == expected
    assert client.get("/api/jobs").json()[0]["transcript"] == payload
    assert other_client.get(f"/api/jobs/{job_id}/lyrics/download").status_code == 404


def test_processing_analyzes_original_mix_after_raw_vocal_asr(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "original.wav"
    source.write_bytes(b"original mix")
    transcript = Transcript([TranscriptSegment(3, 5, "Actual recognition")], "en")
    monkeypatch.setattr(
        "separator.processing.run_separation",
        lambda *args: {"vocals": StemResult(b"raw vocal", 10)},
    )
    calls = []

    def run(command, **kwargs):
        calls.append(command)
        if command[2] == "separator.transcribe":
            assert Path(command[3]).read_bytes() == b"raw vocal"
            Path(command[-1]).write_text(json.dumps(asdict(transcript)))
        else:
            assert command[2] == "separator.structure"
            assert Path(command[3]) == source
            Path(command[-1]).write_text(
                json.dumps(
                    {
                        "sections": [
                            {"start_s": 0, "end_s": 10, "label": "pre-chorus"}
                        ],
                        "structure_model": MODEL_PROVENANCE,
                    }
                )
            )
        assert kwargs["timeout"] > 0
        return subprocess.CompletedProcess(command, 0)

    monkeypatch.setattr("separator.processing.subprocess.run", run)
    result = run_processing(
        source,
        SeparationOptions(extract_lyrics=True),
        tmp_path,
        "/cache",
        "/stems",
        1200,
        "/asr/python",
        "/structure/python",
    )
    assert [call[0] for call in calls] == ["/asr/python", "/structure/python"]
    assert result.audio == {}
    assert result.transcript is not None
    assert result.transcript.segments == transcript.segments
    assert result.transcript.sections == [TranscriptSection(0, 10, "pre-chorus")]


def test_structure_failure_does_not_return_asr_only_success(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        "separator.processing.run_separation",
        lambda *args: {"vocals": StemResult(b"raw", 3)},
    )

    def run(command, **kwargs):
        if command[2] == "separator.transcribe":
            Path(command[-1]).write_text(json.dumps(asdict(Transcript())))
            return subprocess.CompletedProcess(command, 0)
        raise subprocess.CalledProcessError(1, command, stderr="real model failure")

    monkeypatch.setattr("separator.processing.subprocess.run", run)
    with pytest.raises(
        RuntimeError, match="Musical structure analysis failed: real model failure"
    ):
        run_processing(
            tmp_path / "source.wav",
            SeparationOptions(extract_lyrics=True),
            tmp_path,
            "/cache",
            "/stems",
            1200,
        )
