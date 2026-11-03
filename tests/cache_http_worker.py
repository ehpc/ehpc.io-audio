"""Owned HTTP proof: real native audio; synthetic stereo channel separation, no NN."""

import json
import os
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from unittest.mock import patch

import uvicorn
from fastapi.responses import FileResponse

from backend import config, modal_client
from backend.main import app
from separator import audio, cache_versions, stems
from separator.stems import StemResult

ROOT = Path(os.environ["DATA_DIR"])
TRACE = ROOT / "producer-trace.jsonl"


def observed(name, producer):
    def call(*args, **kwargs):
        prohibited = os.environ.get("CACHE_FORBID", "").split(",")
        if name in prohibited:
            raise AssertionError(f"persistent hit recomputed {name}")
        with TRACE.open("a") as handle:
            handle.write(json.dumps(name) + "\n")
        return producer(*args, **kwargs)

    return call


# This private producer is genuinely a CPU algorithm: each known synthetic
# stereo channel is an independent component. Its explicit version/model bytes
# prevent these test artifacts ever masquerading as neural separator output.
def channel_separation(source, stem, out_dir, model_cache):
    out_dir.mkdir(parents=True, exist_ok=True)
    result = {}
    for output in stem.outputs:
        path = out_dir / f"{output.label}.mp3"
        channel = 0 if output.label == "vocals" else 1
        subprocess.run(
            [
                "ffmpeg",
                "-nostdin",
                "-v",
                "error",
                "-y",
                "-i",
                str(source),
                "-af",
                f"pan=mono|c0=c{channel}",
                "-q:a",
                "0",
                str(path),
            ],
            check=True,
        )
        result[output.label] = StemResult(path.read_bytes(), 0.1), path
    return result


patch.object(cache_versions, "STEM", "owned-synthetic-channel-separation-v1").start()
if os.environ.get("CACHE_KEY_VERSION"):
    patch.object(cache_versions, "KEY", os.environ["CACHE_KEY_VERSION"]).start()
for symbol, name in (
    ("_decode_key_audio", "decode"),
    ("_detect_decoded_key", "key"),
    ("_transform_audio", "transform"),
):
    setattr(audio, symbol, observed(name, getattr(audio, symbol)))
stems._run_separator = observed("stem", channel_separation)
stems.mix_audio = observed("mix", stems.mix_audio)
# Both import sites must retain the same real yt-dlp observer.
from backend import queue  # noqa: E402
from backend.routes import key_analysis  # noqa: E402

queue.download_mp3 = observed("download", queue.download_mp3)
key_analysis.download_mp3 = queue.download_mp3


@dataclass
class Call:
    result: dict
    object_id: str = "owned-native-cache-proof"


def spawn(data, filename, options):
    models = ROOT / "models"
    models.mkdir(exist_ok=True)
    for stem in (stems.VOCALS_STEM, stems.INSTRUMENTS_STEM):
        model = models / stem.model
        if not model.exists():
            model.write_bytes(b"owned deterministic stereo-channel decomposition")
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        source = root / "source.mp3"
        source.write_bytes(data)
        return Call(
            stems.run_separation(
                source, options, root, str(models), str(ROOT / "stems")
            )
        )


patch.object(modal_client, "spawn", spawn).start()
patch.object(modal_client, "poll", lambda call, timeout: call.result).start()
config.QUEUE_POLL_INTERVAL_S = 0.02


@app.get("/owned-source.wav")
def owned_source():
    return FileResponse(ROOT / "source.wav")


# The production SPA fallback is deliberately last; the owned proof source must
# precede it too, without modifying any production route.
app.router.routes.insert(0, app.router.routes.pop())


if __name__ == "__main__":
    uvicorn.run(
        app, host="127.0.0.1", port=int(os.environ["CACHE_PORT"]), log_level="error"
    )
