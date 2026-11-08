import asyncio
import json
from dataclasses import asdict
from pathlib import Path

import pytest
from audio_samples import mp3_measurements, tone_wav
from fastapi.testclient import TestClient
from inference_fixture import StemSignal, cpu_inference, fixture_manifest

from backend import config, db, queue
from separator.lyrics import (
    Transcript,
    TranscriptSection,
    TranscriptSegment,
    transcript_from_json,
    transcript_text,
)
from separator.options import SeparationOptions
from separator.processing import ProcessingContext, ProcessingResult, run_processing
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
        queue, "process_source", lambda *args: ProcessingResult({}, transcript)
    )
    job = db.get_job(job_id)
    assert job is not None
    asyncio.run(queue._run_job(job))
    payload = client.get(f"/api/jobs/{job_id}/lyrics").json()
    assert payload["sections"] == [asdict(s) for s in transcript.sections]
    assert payload["structure_model"] == MODEL_PROVENANCE
    expected = "song\n" + transcript_text(transcript.segments, transcript.sections)
    assert payload["timestamped_text"] == expected
    assert client.get(f"/api/jobs/{job_id}/lyrics/download").text == expected
    assert legacy.read_text("utf-8") == "old timestamp format, do not rewrite"
    legacy.unlink()
    db.init_db()
    assert client.get(f"/api/jobs/{job_id}/lyrics/download").text == expected
    assert client.get("/api/jobs").json()[0]["transcript"] == payload
    assert other_client.get(f"/api/jobs/{job_id}/lyrics/download").status_code == 404


def test_processing_analyzes_original_mix_after_raw_vocal_asr(tmp_path: Path) -> None:
    source = tmp_path / "original.wav"
    source.write_bytes(tone_wav((330,), 4))
    producer = tmp_path / "producer"
    manifest = fixture_manifest(producer, signals={"vocals": StemSignal(220, 4)})
    calls = []
    vocal_durations = []

    def infer(request, key):
        calls.append(request.operation)
        if request.operation == "structure":
            assert request.audio_bytes == source.read_bytes()
            assert request.filename == source.name
        elif request.operation in {"recognition", "alignment"}:
            assert request.audio_bytes != source.read_bytes()
            duration, frequency = mp3_measurements(request.audio_bytes)
            assert duration == pytest.approx(4, abs=0.1)
            assert frequency == pytest.approx(220, rel=0.025)
            if request.operation == "recognition":
                vocal_durations.append(duration)
        return cpu_inference(request, key, root=producer)

    context = ProcessingContext(tmp_path / "cache", manifest, infer)
    result = run_processing(
        source, SeparationOptions(extract_lyrics=True), tmp_path, context
    )
    assert calls == ["separation", "recognition", "alignment", "structure"]
    assert result.audio == {}
    assert result.transcript is not None
    assert [word.text for word in result.transcript.words] == ["fixture"]
    assert result.transcript.words[0].start_s == pytest.approx(
        vocal_durations[0] / 4, abs=1 / 16000
    )
    assert result.transcript.sections == [TranscriptSection(0, 4, "verse")]


def test_structure_failure_preserves_completed_dependencies_for_retry(
    tmp_path: Path,
) -> None:
    source = tmp_path / "source.wav"
    source.write_bytes(tone_wav((220,), 4))
    producer = tmp_path / "producer"
    manifest = fixture_manifest(producer)
    calls = []

    def infer(request, key):
        calls.append(request.operation)
        if request.operation == "structure":
            raise RuntimeError("real model failure")
        return cpu_inference(request, key, root=producer)

    context = ProcessingContext(tmp_path / "cache", manifest, infer)
    options = SeparationOptions(extract_lyrics=True)
    with pytest.raises(RuntimeError, match="real model failure"):
        run_processing(source, options, tmp_path, context)
    assert calls == ["separation", "recognition", "alignment", "structure"]
    assert len(list((context.root / "inference").glob("*.bin"))) == 3
    assert len(list((context.root / "transcripts").glob("*.bin"))) == 1

    def missing(request, key):
        assert request.operation == "structure", "completed dependency was recomputed"
        calls.append(request.operation)
        return cpu_inference(request, key, root=producer)

    context.infer = missing
    result = run_processing(source, options, tmp_path, context)
    assert calls[-2:] == ["structure", "structure"]
    assert result.transcript is not None
    assert result.transcript.sections == [TranscriptSection(0, 4, "verse")]
    assert len(list((context.root / "inference").glob("*.bin"))) == 4

    def forbidden(*args):
        raise AssertionError("successful retry was not cached")

    context.infer = forbidden
    repeated = run_processing(source, options, tmp_path, context)
    assert repeated.transcript == result.transcript
