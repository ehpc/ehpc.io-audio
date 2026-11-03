"""Producer-observed cache contracts; native audio, no neural inference."""

import asyncio
import io
import json
import subprocess
import sys
import time
import wave
from concurrent.futures import ThreadPoolExecutor

import pytest
from audio_samples import mp3_measurements, tone_wav

from backend import config
from backend.source_cache import cached_download, source_identity
from separator import audio, cache_versions
from separator.artifact_cache import async_locked, cached_bytes
from separator.options import SeparationOptions
from separator.processing import _analysis_output


def forbidden(*args, **kwargs):
    raise AssertionError("cache hit invoked its producer")


def test_atomic_failure_and_concurrent_native_producer(tmp_path):
    root = tmp_path / "artifacts"
    calls = []

    def failed():
        raise RuntimeError("incomplete producer")

    with pytest.raises(RuntimeError, match="incomplete"):
        cached_bytes(root, "audio", failed)
    assert not (root / "audio.bin").exists()
    source = tone_wav((440,), 0.5)

    def produce():
        calls.append(1)
        return audio._transform_audio(source, SeparationOptions(tempo_percent=125))

    with ThreadPoolExecutor(max_workers=6) as workers:
        outputs = list(
            workers.map(lambda _: cached_bytes(root, "audio", produce), range(6))
        )
    assert calls == [1]
    assert all(output == outputs[0] for output in outputs)
    duration, frequency = mp3_measurements(outputs[0])
    assert duration == pytest.approx(0.4, abs=0.07)
    assert frequency == pytest.approx(440, rel=0.025)
    assert cached_bytes(root, "audio", forbidden) == outputs[0]
    assert not list(root.glob(".pending-*"))


def test_cancelled_async_waiter_does_not_leak_lock(tmp_path):
    async def scenario():
        lock = tmp_path / "source.lock"
        artifact = tmp_path / "cache"
        entered = asyncio.Event()

        async def waiting():
            entered.set()
            async with async_locked(lock):
                forbidden()

        async with async_locked(lock):
            waiter = asyncio.create_task(waiting())
            await entered.wait()
            await asyncio.sleep(0.01)
            waiter.cancel()
            with pytest.raises(asyncio.CancelledError):
                await asyncio.wait_for(waiter, 0.2)
            assert cached_bytes(artifact, "result", lambda: b"complete") == b"complete"
        async with async_locked(lock):
            assert cached_bytes(artifact, "result", forbidden) == b"complete"

    asyncio.run(asyncio.wait_for(scenario(), 2))


def test_decoded_key_reuse_unknown_and_relevant_versions(tmp_path, monkeypatch):
    source = tone_wav((261.6256, 329.6276, 391.9954), 3)
    root = tmp_path / "keys"
    actual = audio._detect_decoded_key
    calls = []

    def observe(decoded):
        calls.append(1)
        return actual(decoded)

    monkeypatch.setattr(audio, "_detect_decoded_key", observe)
    assert audio.detect_key(source, "one.wav", root) == "C major"
    assert audio.detect_key(source, "renamed.wav", root) == "C major"
    monkeypatch.setattr(cache_versions, "STRUCTURE", "unrelated-change")
    assert audio.detect_key(source, "three.wav", root) == "C major"
    assert calls == [1]
    monkeypatch.setattr(cache_versions, "KEY", "changed-key-algorithm")
    assert audio.detect_key(source, "four.wav", root) == "C major"
    assert calls == [1, 1]
    silence = io.BytesIO()
    with wave.open(silence, "wb") as output:
        output.setparams((1, 2, 11025, 0, "NONE", "not compressed"))
        output.writeframes(b"\0\0" * 11025)
    assert audio.detect_key(silence.getvalue(), "silence.wav", root) is None
    monkeypatch.setattr(audio, "_decode_key_audio", forbidden)
    monkeypatch.setattr(audio, "_detect_decoded_key", forbidden)
    assert audio.detect_key(silence.getvalue(), "renamed.wav", root) is None


def test_native_artifacts_survive_process_restart(tmp_path):
    source = tmp_path / "input.wav"
    source.write_bytes(tone_wav((261.6256, 329.6276, 391.9954), 3))
    root = tmp_path / "artifacts"
    script = """
import sys
from pathlib import Path
from separator import audio
from separator.options import SeparationOptions
root, source, phase = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
if phase == 'repeat':
    def forbidden(*args): raise AssertionError('recomputed after restart')
    audio._decode_key_audio = forbidden
    audio._detect_decoded_key = forbidden
    audio._transform_audio = forbidden
assert audio.detect_key(source.read_bytes(), 'renamed.wav', root) == 'C major'
options = SeparationOptions(pitch_semitones=2, tempo_percent=125)
result = audio.transform_audio(source.read_bytes(), options, root)
(root / (phase + '.mp3')).write_bytes(result)
"""
    for phase in ("fresh", "repeat"):
        subprocess.run(
            [sys.executable, "-c", script, str(root), str(source), phase], check=True
        )
    assert (root / "fresh.mp3").read_bytes() == (root / "repeat.mp3").read_bytes()
    assert mp3_measurements((root / "repeat.mp3").read_bytes())[0] == pytest.approx(
        2.4, abs=0.07
    )


def test_download_aliases_metadata_and_own_copies(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DATA_DIR", tmp_path / "data")
    calls = []
    source = tone_wav((440,), 0.5)

    def produce(url, directory, **kwargs):
        calls.append(1)
        kwargs["metadata_path"].write_text(
            json.dumps({"artist": "Artist", "track": "Track"})
        )
        result = audio._transform_audio(source, SeparationOptions(tempo_percent=110))
        return result, "original.mp3"

    first, _ = cached_download(
        "https://youtu.be/abcdefghijk?si=tracking",
        str(tmp_path / "preview"),
        producer=produce,
    )
    metadata = tmp_path / "job-metadata.json"
    second, _ = cached_download(
        "https://music.youtube.com/watch?v=abcdefghijk&list=ignored",
        str(tmp_path / "job"),
        metadata_path=metadata,
        producer=forbidden,
    )
    assert first == second
    assert json.loads(metadata.read_text()) == {"artist": "Artist", "track": "Track"}
    (tmp_path / "job" / "original.mp3").write_bytes(b"own tags changed")
    third, _ = cached_download(
        "https://www.youtube.com/shorts/abcdefghijk",
        str(tmp_path / "other-session"),
        producer=forbidden,
    )
    assert third == first
    assert calls == [1]
    assert mp3_measurements(third)[0] == pytest.approx(0.5 / 1.1, abs=0.07)
    assert source_identity("https://youtu.be/abcdefghijl") != source_identity(
        "https://youtu.be/abcdefghijk"
    )
    assert source_identity("https://example.test/song?version=1") != source_identity(
        "https://example.test/song?version=2"
    )
    monkeypatch.setattr(cache_versions, "KEY", "irrelevant")
    cached_download(
        "https://youtu.be/abcdefghijk", str(tmp_path / "last"), producer=forbidden
    )
    monkeypatch.setattr(cache_versions, "DOWNLOAD", "new-download-algorithm")
    cached_download(
        "https://youtu.be/abcdefghijk", str(tmp_path / "new"), producer=produce
    )
    assert calls == [1, 1]


def test_analysis_cache_precedes_process_spawn_and_rejects_partial(
    tmp_path, monkeypatch
):
    output = tmp_path / "structure.json"
    trace = tmp_path / "trace"
    script = """
from pathlib import Path
import sys,json
value = {'sections': [{'start_s':0,'end_s':1,'label':'verse'}],
         'structure_model':'owned-cpu-fixture'}
Path(sys.argv[1]).write_text(json.dumps(value))
Path(sys.argv[2]).write_text('produced')
"""
    command = [sys.executable, "-c", script, str(output), str(trace)]
    root = tmp_path / "structure"
    first = _analysis_output(
        command,
        output,
        root,
        "version1",
        time.monotonic() + 10,
        "Musical structure analysis",
    )
    assert trace.read_text() == "produced"
    assert json.loads(first)["sections"][0] == {
        "start_s": 0,
        "end_s": 1,
        "label": "verse",
    }
    monkeypatch.setattr(subprocess, "run", forbidden)
    assert (
        _analysis_output(
            command, output, root, "version1", 0, "Musical structure analysis"
        )
        == first
    )
    with pytest.raises(TimeoutError):
        _analysis_output(
            command, output, root, "version2", 0, "Musical structure analysis"
        )
    assert not (root / "version2.bin").exists()


def test_concurrent_processes_share_one_native_producer(tmp_path):
    source = tmp_path / "input.wav"
    source.write_bytes(tone_wav((440,), 0.4))
    script = """
import sys
from pathlib import Path
from separator.artifact_cache import cached_bytes
from separator.audio import _transform_audio
from separator.options import SeparationOptions
root, source = Path(sys.argv[1]), Path(sys.argv[2])
def produce():
    with (root / 'calls').open('a') as trace: trace.write('produce\\n')
    return _transform_audio(source.read_bytes(), SeparationOptions(tempo_percent=125))
result = cached_bytes(root, 'same-source', produce)
assert len(result) > 100
"""
    processes = [
        subprocess.Popen([sys.executable, "-c", script, str(tmp_path), str(source)])
        for _ in range(4)
    ]
    assert [process.wait(timeout=15) for process in processes] == [0, 0, 0, 0]
    assert (tmp_path / "calls").read_text() == "produce\n"
    assert mp3_measurements((tmp_path / "same-source.bin").read_bytes())[
        0
    ] == pytest.approx(0.32, abs=0.07)


def test_invalid_analysis_success_cannot_publish(tmp_path):
    output = tmp_path / "pitch.json"
    root = tmp_path / "pitch"
    command = [
        sys.executable,
        "-c",
        "from pathlib import Path; import sys; Path(sys.argv[1]).write_text('{}')",
        str(output),
    ]
    with pytest.raises((KeyError, ValueError, TypeError)):
        _analysis_output(
            command, output, root, "bad", time.monotonic() + 10, "Vocal pitch detection"
        )
    assert not (root / "bad.bin").exists()
