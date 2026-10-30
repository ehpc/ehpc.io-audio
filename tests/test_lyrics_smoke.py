"""Opt-in real separation + large-v3 ASR against the isolated Modal app."""

import json
import re
import subprocess

import modal
import pytest
from lyrics_fixture import intelligible_speech, sung_excerpt

from backend import config
from backend.modal_client import LYRICS_FUNCTION_NAME
from separator.lyrics import transcript_from_json, transcript_text
from separator.modal_app import (
    ASR_PYTHON,
    GPU,
    MODEL_CACHE,
    TIMEOUT,
    image,
    model_volume,
)
from separator.options import SeparationOptions
from separator.processing import ProcessingResult

pytestmark = [pytest.mark.smoke, pytest.mark.timeout(TIMEOUT + 300)]


def test_deployed_lyrics_recognizes_reference_speech() -> None:
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
    function = modal.Function.from_name(config.MODAL_APP_NAME, LYRICS_FUNCTION_NAME)
    result: ProcessingResult = function.remote(
        source,
        "jfk-reference.flac",
        SeparationOptions(extract_lyrics=True, no_cache=True),
    )
    assert result.audio == {}, "the prerequisite vocal stem must remain internal"
    transcript = result.transcript
    assert transcript is not None
    assert transcript.status == "recognized"
    assert transcript.language == "en"
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
                "model": "large-v3",
                "language": transcript.language,
                "duration_s": duration,
                "timestamped_text": text,
            },
            ensure_ascii=False,
        )
    )


def test_deployed_lyrics_retains_later_sung_verse() -> None:
    function = modal.Function.from_name(config.MODAL_APP_NAME, LYRICS_FUNCTION_NAME)
    result: ProcessingResult = function.remote(
        sung_excerpt(),
        "public-domain-singing.flac",
        SeparationOptions(extract_lyrics=True, no_cache=True),
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


def test_gpu_asr_silence_is_empty_and_runtime_dependencies_are_isolated() -> None:
    # Exercise actual ASR directly: audio-separator rejects all-zero source audio
    # before producing a vocal stem. That is an honest separation failure, not
    # an empty recognition or a reason to fabricate a fallback vocal file.
    assert config.MODAL_APP_NAME != "audio-separator", "Use an isolated test app"
    script = f"""
import importlib.metadata
import json
import subprocess
import wave
from pathlib import Path
import onnxruntime
transcripts = []
for duration in (4, 30):
    with wave.open('/tmp/silence.wav', 'wb') as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(16000)
        audio.writeframes(bytes(16000 * duration * 2))
    subprocess.run(
        [{ASR_PYTHON!r}, '-m', 'separator.transcribe', '/tmp/silence.wav',
         {MODEL_CACHE + "/whisper"!r}, '/tmp/transcript.json'],
        check=True, cwd='/root',
    )
    transcripts.append(dict(duration_s=duration,
        transcript=json.loads(Path('/tmp/transcript.json').read_text())))
asr = subprocess.run(
    [{ASR_PYTHON!r}, '-c',
     'import json, onnxruntime, importlib.metadata as m; '
     'print(json.dumps(dict(providers=onnxruntime.get_available_providers(), '
     'runtime=m.version("onnxruntime"), whisper=m.version("faster-whisper"), '
     'av=m.version("av"), ctranslate2=m.version("ctranslate2"))))'],
    capture_output=True, text=True, check=True,
)
print(json.dumps(dict(
    separator_providers=onnxruntime.get_available_providers(),
    separator_runtime=importlib.metadata.version('onnxruntime-gpu'),
    asr=json.loads(asr.stdout),
    transcripts=transcripts,
)))
"""
    sandbox = modal.Sandbox.create(
        "python",
        "-c",
        script,
        app=modal.App.lookup(config.MODAL_APP_NAME),
        image=image,
        gpu=GPU,
        volumes={MODEL_CACHE: model_volume},
        timeout=TIMEOUT,
        workdir="/root",
    )
    try:
        sandbox.wait()
        stdout = sandbox.stdout.read()
        stderr = sandbox.stderr.read()
        assert sandbox.returncode == 0, stderr
        result = json.loads(stdout.splitlines()[-1])
        assert "CUDAExecutionProvider" in result["separator_providers"]
        assert "CUDAExecutionProvider" not in result["asr"]["providers"]
        for case in result["transcripts"]:
            assert case["transcript"]["status"] == "empty", case
            assert case["transcript"]["segments"] == [], case
        print("SMOKE_ASR_RUNTIME " + json.dumps(result))
    finally:
        sandbox.terminate()


def test_gpu_asr_preserves_language_and_clock_after_long_silent_intro() -> None:
    assert config.MODAL_APP_NAME != "audio-separator", "Use an isolated test app"
    sandbox = modal.Sandbox.create(
        "sleep",
        str(TIMEOUT),
        app=modal.App.lookup(config.MODAL_APP_NAME),
        image=image,
        gpu=GPU,
        volumes={MODEL_CACHE: model_volume},
        timeout=TIMEOUT,
        workdir="/root",
    )
    try:
        sandbox.filesystem.write_bytes(intelligible_speech(), "/tmp/speech.flac")
        decode = sandbox.exec(
            "ffmpeg",
            "-nostdin",
            "-v",
            "error",
            "-i",
            "/tmp/speech.flac",
            "-af",
            "adelay=35000:all=1",
            "-ar",
            "16000",
            "-ac",
            "1",
            "-c:a",
            "pcm_s16le",
            "/tmp/intro.wav",
        )
        decode.wait()
        assert decode.returncode == 0, decode.stderr.read()
        process = sandbox.exec(
            ASR_PYTHON,
            "-m",
            "separator.transcribe",
            "/tmp/intro.wav",
            MODEL_CACHE + "/whisper",
            "/tmp/transcript.json",
        )
        process.wait()
        assert process.returncode == 0, process.stderr.read()
        transcript = transcript_from_json(
            sandbox.filesystem.read_text("/tmp/transcript.json")
        )
        assert transcript.status == "recognized"
        assert transcript.language == "en"
        assert transcript.timestamp_reference == "original"
        words = " ".join(segment.text for segment in transcript.segments).lower()
        for phrase in ("my fellow americans", "your country", "do for you"):
            assert phrase in words
        # The old one-second initial-timestamp constraint misdated this onset
        # at30s, although all35s of leading zero audio were still present.
        assert 34 <= transcript.segments[0].start_s <= 36
        assert all(s.start_s < s.end_s <= 46 for s in transcript.segments)
        print("SMOKE_SILENT_INTRO " + transcript_text(transcript.segments))
    finally:
        sandbox.terminate()
