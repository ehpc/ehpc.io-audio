"""CPU-only cache proof module, portable across client/worker Python versions."""

import asyncio
import io
import json
import os
import subprocess
import tempfile
import wave
from contextlib import suppress
from pathlib import Path

from separator.artifact_cache import async_locked, cached_bytes, digest


def isolated_cache(volume, source: bytes, version: str, prohibit: bool):
    root = Path("/private-cache")
    volume.reload()
    trace = root / "producer-count"

    def produce():
        if prohibit:
            raise AssertionError("valid persistent hit invoked FFmpeg")
        with tempfile.TemporaryDirectory() as directory:
            source_path = Path(directory) / "source.wav"
            output_path = Path(directory) / "decoded.wav"
            source_path.write_bytes(source)
            subprocess.run(
                [
                    "ffmpeg",
                    "-nostdin",
                    "-v",
                    "error",
                    "-i",
                    str(source_path),
                    "-ar",
                    "11025",
                    "-ac",
                    "1",
                    str(output_path),
                ],
                check=True,
            )
            output = output_path.read_bytes()
        count = int(trace.read_text()) if trace.exists() else 0
        trace.write_text(str(count + 1))
        return output

    async def cancellation():
        async with async_locked(root / "cancellation.lock"):

            async def waiter():
                async with async_locked(root / "cancellation.lock"):
                    raise AssertionError("waiter entered occupied lock")

            pending = asyncio.create_task(waiter())
            await asyncio.sleep(0.05)
            pending.cancel()
            with suppress(asyncio.CancelledError):
                await asyncio.wait_for(pending, 0.5)
        async with async_locked(root / "cancellation.lock"):
            pass

    asyncio.run(cancellation())
    result = cached_bytes(
        root / "audio", digest((version + digest(source)).encode()), produce
    )
    with wave.open(io.BytesIO(source)) as original:
        source_duration = original.getnframes() / original.getframerate()
    with wave.open(io.BytesIO(result)) as decoded:
        assert decoded.getframerate() == 11025
        duration = decoded.getnframes() / decoded.getframerate()
        error_samples = abs(duration - source_duration) * decoded.getframerate()
        assert error_samples <= 1
    evidence = {
        "container": os.environ["MODAL_TASK_ID"],
        "producer_count": int(trace.read_text()),
        "sha256": digest(result),
        "bytes": len(result),
        "source_duration_s": source_duration,
        "duration_s": duration,
        "duration_error_samples": error_samples,
        "cancelled_waiter_released": True,
    }
    volume.commit()
    return json.dumps(evidence)
