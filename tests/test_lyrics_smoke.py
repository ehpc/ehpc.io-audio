"""Real singing ASR through the single GPU pool and VPS-side assembly."""

import io
import json
import re
import subprocess
import wave
from pathlib import Path

import pytest
from gpu_smoke import gpu_context
from lyrics_fixture import intelligible_speech, sung_excerpt

from separator.lyrics import transcript_text
from separator.modal_app import TIMEOUT
from separator.options import SeparationOptions
from separator.processing import run_processing, transcribe_source

pytestmark = [pytest.mark.smoke, pytest.mark.timeout(TIMEOUT + 300)]


def test_deployed_lyrics_recognizes_reference_speech(tmp_path: Path) -> None:
    source = intelligible_speech()
    duration = float(
        json.loads(
            subprocess.run(
                [
                    "ffprobe",
                    "-v",
                    "error",
                    "-show_entries",
                    "format=duration",
                    "-of",
                    "json",
                    "pipe:0",
                ],
                input=source,
                capture_output=True,
                check=True,
            ).stdout
        )["format"]["duration"]
    )
    source_path = tmp_path / "jfk-reference.flac"
    source_path.write_bytes(source)
    result = run_processing(
        source_path,
        SeparationOptions(extract_lyrics=True),
        tmp_path,
        gpu_context(tmp_path / "computed"),
    )
    assert result.audio == {}, "the prerequisite vocal stem must remain internal"
    transcript = result.transcript
    assert transcript is not None
    assert transcript.status == "recognized"
    assert transcript.language == "English"
    assert transcript.timestamp_reference == "original"
    words = " ".join(segment.text for segment in transcript.segments).lower()
    for phrase in ("my fellow americans", "your country", "do for you"):
        assert phrase in words
    previous_end = 0.0
    for segment in transcript.segments:
        assert previous_end <= segment.start_s < segment.end_s <= duration + 0.1
        previous_end = segment.end_s
    text = transcript_text(transcript.segments, transcript.sections)
    assert text.encode("utf-8").decode("utf-8") == text
    assert " --> " not in text
    print(
        "SMOKE_LYRICS "
        + json.dumps(
            {
                "model": transcript.asr_model,
                "language": transcript.language,
                "duration_s": duration,
                "timestamped_text": text,
            },
            ensure_ascii=False,
        )
    )


def test_deployed_lyrics_retains_later_sung_verse(tmp_path: Path) -> None:
    source_path = tmp_path / "public-domain-singing.flac"
    source_path.write_bytes(sung_excerpt())
    result = run_processing(
        source_path,
        SeparationOptions(extract_lyrics=True),
        tmp_path,
        gpu_context(tmp_path / "computed"),
    )
    assert result.audio == {}
    transcript = result.transcript
    assert transcript is not None
    assert transcript.status == "recognized"
    assert transcript.timestamp_reference == "original"
    # Speech-only VAD used to discard this sung repetition entirely. Check the
    # actual later lyric and timing, not model kwargs or a particular spelling.
    later = " ".join(s.text for s in transcript.segments if s.end_s > 20).casefold()
    assert re.search(r"\b(?:auld|old)\s+(?:lang|long)\s+(?:syne|sign)\b", later), later
    assert all(0 <= s.start_s < s.end_s <= 30.1 for s in transcript.segments)
    print("SMOKE_SINGING " + transcript_text(transcript.segments, transcript.sections))


def test_gpu_asr_silence_is_empty(tmp_path: Path) -> None:
    # Actual ASR, without separation: separators legitimately reject zero audio.
    # No substitute vocal file, standalone GPU process or extra function exists.
    context = gpu_context(tmp_path / "computed")
    evidence = []
    for duration in (4, 30):
        stream = io.BytesIO()
        with wave.open(stream, "wb") as audio:
            audio.setnchannels(1)
            audio.setsampwidth(2)
            audio.setframerate(16000)
            audio.writeframes(bytes(16000 * duration * 2))
        transcript = transcribe_source(stream.getvalue(), context, None)
        assert transcript.status == "empty"
        assert transcript.segments == []
        evidence.append(
            {
                "duration_s": duration,
                "status": transcript.status,
                "model": transcript.asr_model,
            }
        )
    print("SMOKE_ASR_SILENCE " + json.dumps(evidence))


def test_gpu_asr_preserves_language_and_clock_after_long_silent_intro(
    tmp_path: Path,
) -> None:
    speech = tmp_path / "speech.flac"
    speech.write_bytes(intelligible_speech())
    intro = tmp_path / "intro.wav"
    subprocess.run(
        [
            "ffmpeg",
            "-nostdin",
            "-v",
            "error",
            "-i",
            str(speech),
            "-af",
            "adelay=35000:all=1",
            "-ar",
            "16000",
            "-ac",
            "1",
            "-c:a",
            "pcm_s16le",
            str(intro),
        ],
        check=True,
        capture_output=True,
    )
    transcript = transcribe_source(
        intro.read_bytes(), gpu_context(tmp_path / "computed"), None
    )
    assert transcript.status == "recognized"
    assert transcript.language == "English"
    assert transcript.timestamp_reference == "original"
    words = " ".join(segment.text for segment in transcript.segments).lower()
    for phrase in ("my fellow americans", "your country", "do for you"):
        assert phrase in words
    # The old initial-timestamp constraint misplaced this onset at 30 seconds.
    assert 34 <= transcript.segments[0].start_s <= 36
    assert all(s.start_s < s.end_s <= 46 for s in transcript.segments)
    print("SMOKE_SILENT_INTRO " + transcript_text(transcript.segments))
