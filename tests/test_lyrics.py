import asyncio
import json
import sqlite3
from dataclasses import asdict
from unittest.mock import MagicMock
from urllib.parse import quote

import pytest
from audio_samples import decode_audio, frequency_amplitude, tone_wav
from fastapi.testclient import TestClient

from backend import config, db, modal_client, queue
from separator.lyrics import (
    Transcript,
    TranscriptSegment,
    format_timestamp,
    transcript_from_json,
    transcript_text,
)
from separator.options import SeparationOptions
from separator.processing import ProcessingResult


def _complete(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, transcript: Transcript | None
) -> int:
    response = client.post(
        "/api/jobs",
        files={"file": ("歌声.wav", b"source-audio", "audio/wav")},
        data={"extract_lyrics": "true"},
    )
    assert response.status_code == 200
    job_id = response.json()["id"]
    call = MagicMock(object_id="fc-lyrics")
    monkeypatch.setattr(queue, "detect_key", lambda *args: None)
    monkeypatch.setattr(modal_client, "spawn_with_lyrics", lambda *args: call)
    monkeypatch.setattr(
        modal_client, "poll", lambda *args: ProcessingResult({}, transcript)
    )
    record = db.get_job(job_id)
    assert record is not None
    asyncio.run(queue._run_job(record))
    return job_id


def test_lyrics_download_matches_browser_text_and_survives_history(
    client: TestClient, other_client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    transcript = Transcript(
        [
            TranscriptSegment(1.25, 4.0, "こんにちは、世界"),
            TranscriptSegment(61.125, 64.5, "Cœur et âme"),
        ],
        language="ja",
    )
    job_id = _complete(client, monkeypatch, transcript)
    job = client.get(f"/api/jobs/{job_id}").json()
    assert job["status"] == "done", job["error_message"]
    assert job["options"]["extract_lyrics"] is True
    assert job["manifest"] == []
    assert job["has_original"] is True
    expected = (
        "[00:01.250 --> 00:04.000] こんにちは、世界\n"
        "[01:01.125 --> 01:04.500] Cœur et âme\n"
    )
    payload = client.get(f"/api/jobs/{job_id}/lyrics").json()
    assert payload == job["transcript"]
    assert payload["status"] == "recognized"
    assert payload["timestamp_reference"] == "original"
    assert payload["timestamped_text"] == expected
    download = client.get(f"/api/jobs/{job_id}/lyrics/download")
    assert download.status_code == 200
    assert download.content == expected.encode("utf-8")
    assert download.headers["content-type"] == "text/plain; charset=utf-8"
    assert quote("歌声 - lyrics.txt") in download.headers["content-disposition"]
    assert client.get(f"/api/jobs/{job_id}/original").content == b"source-audio"
    assert client.get(f"/api/jobs/{job_id}/results/vocals").status_code == 404
    db.init_db()
    assert client.get("/api/jobs").json()[0]["transcript"] == payload
    assert client.get("/api/jobs/current").json()["transcript"] == payload
    event = client.get(f"/api/jobs/{job_id}/events").text
    assert json.loads(event.removeprefix("data: ").strip())["transcript"] == payload
    for suffix in ("", "/lyrics", "/lyrics/download", "/events"):
        assert other_client.get(f"/api/jobs/{job_id}{suffix}").status_code == 404
    assert other_client.get("/api/jobs").json() == []
    assert client.post(f"/api/jobs/{job_id}/retry").status_code == 200
    assert client.get("/api/jobs/current").json()["options"]["extract_lyrics"] is True


def test_empty_recognition_is_distinct_from_not_requested(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    job_id = _complete(client, monkeypatch, Transcript())
    payload = client.get(f"/api/jobs/{job_id}/lyrics").json()
    assert payload["status"] == "empty"
    assert payload["segments"] == []
    assert payload["language"] is None
    assert payload["timestamped_text"] == ""
    download = client.get(f"/api/jobs/{job_id}/lyrics/download")
    assert download.status_code == 200
    assert download.content == b""
    unrequested = client.post("/api/jobs", data={"url": "https://example.org/song"})
    other_id = unrequested.json()["id"]
    assert client.get(f"/api/jobs/{other_id}").json()["transcript"] is None
    assert client.get(f"/api/jobs/{other_id}/lyrics").status_code == 404


def test_missing_or_failed_asr_is_not_success_with_fabricated_text(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    job_id = _complete(client, monkeypatch, None)
    job = client.get(f"/api/jobs/{job_id}").json()
    assert job["status"] == "failed"
    assert job["error_message"] == "Lyrics extraction returned no transcript"
    assert job["transcript"] is None
    for suffix in ("/lyrics", "/lyrics/download"):
        assert client.get(f"/api/jobs/{job_id}{suffix}").status_code == 404
    assert not (config.RESULTS_DIR / str(job_id) / "lyrics.txt").exists()


def test_older_job_without_lyrics_fields_remains_download_only() -> None:
    job_id = db.insert_job(
        "old-session", "url", "https://example.org", SeparationOptions()
    )
    with sqlite3.connect(config.DB_PATH) as connection:
        connection.execute(
            "UPDATE jobs SET options_json = ? WHERE id = ?",
            ('{"extract_vocals":false,"extract_instruments":false}', job_id),
        )
    job = db.get_job(job_id)
    assert job is not None
    assert job.options.extract_lyrics is False
    assert job.transcript is None
    assert job.options.output_labels == []
    assert job.options.result_labels == []
    assert SeparationOptions(extract_lyrics=True).result_labels == []
    assert SeparationOptions(extract_lyrics=True, pitch_semitones=2).result_labels == [
        "song"
    ]


def test_timestamp_rounding_and_utf8_roundtrip() -> None:
    assert format_timestamp(59.9996) == "01:00.000"
    assert format_timestamp(3600.125) == "60:00.125"
    transcript = Transcript([TranscriptSegment(1.0, 2.0, "سلام 世界")], language="ar")
    restored = transcript_from_json(json.dumps(asdict(transcript), ensure_ascii=False))
    assert transcript_text(restored.segments) == "[00:01.000 --> 00:02.000] سلام 世界\n"


@pytest.mark.parametrize("start,end", [(-1, 1), (2, 1), (0, float("nan"))])
def test_invalid_transcript_timestamps_cannot_be_persisted(
    start: float, end: float
) -> None:
    with pytest.raises(ValueError, match="timestamps"):
        TranscriptSegment(start, end, "text")


def test_transcript_rejects_out_of_order_segments() -> None:
    with pytest.raises(ValueError, match="ordered"):
        Transcript(
            [TranscriptSegment(2, 3, "second"), TranscriptSegment(0, 1, "first")]
        )


def test_transformed_audio_does_not_rescale_original_lyrics_clock(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tone_wav((440.0,), duration_s=4)
    transcript = Transcript(
        [TranscriptSegment(2.5, 3.5, "Original clock")], language="en"
    )
    response = client.post(
        "/api/jobs",
        files={"file": ("voice.wav", source, "audio/wav")},
        data={
            "extract_lyrics": "true",
            "pitch_semitones": "12",
            "tempo_percent": "200",
        },
    )
    job_id = response.json()["id"]
    monkeypatch.setattr(queue, "detect_key", lambda *args: None)
    monkeypatch.setattr(
        modal_client, "spawn_with_lyrics", lambda *args: MagicMock(object_id="fc-time")
    )
    monkeypatch.setattr(
        modal_client, "poll", lambda *args: ProcessingResult({}, transcript)
    )
    record = db.get_job(job_id)
    assert record is not None
    asyncio.run(queue._run_job(record))
    job = client.get(f"/api/jobs/{job_id}").json()
    assert job["status"] == "done", job["error_message"]
    assert [entry["label"] for entry in job["manifest"]] == ["song"]
    modified = client.get(f"/api/jobs/{job_id}/results/song")
    decoded = decode_audio(modified.content)
    assert abs(decoded.duration_s - 2) < 0.1
    # Spectral amplitude is stable under R3's formant-preserving waveform shape;
    # counting zero crossings is not a reliable pitch estimator for that shape.
    assert frequency_amplitude(decoded, 880) > frequency_amplitude(decoded, 440) * 10
    assert client.get(f"/api/jobs/{job_id}/original").content == source
    assert job["transcript"]["timestamp_reference"] == "original"
    expected = "[00:02.500 --> 00:03.500] Original clock\n"
    assert job["transcript"]["timestamped_text"] == expected
    assert client.get(f"/api/jobs/{job_id}/lyrics/download").text == expected
