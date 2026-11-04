"""Bump only the affected producer when its algorithm or pinned dependencies change.

These are artifact identities, not release versions. Presentation changes never
invalidate audio or inference. Pre-versioned artifacts are deliberately not read.
"""

import hashlib
import json
import shutil
from functools import cache
from importlib.metadata import PackageNotFoundError, distributions, version
from pathlib import Path
from subprocess import run


def binary_revision(name: str) -> str:
    executable = shutil.which(name)
    if executable is None:
        raise RuntimeError(f"Required audio tool not found: {name}")
    paths = _binary_dependencies(executable)
    return hashlib.sha256(
        json.dumps(
            [file_revision(Path(path)) for path in paths],
        ).encode()
    ).hexdigest()


@cache
def _binary_dependencies(executable: str) -> tuple[str, ...]:
    # Runtime shared-library updates matter even when the small CLI launcher
    # has not changed. ldd does not run an audio/model producer.
    result = run(["ldd", executable], capture_output=True, text=True)
    libraries = []
    for line in result.stdout.splitlines():
        value = line.split("=>", 1)[-1].strip().split(" ", 1)[0]
        if value.startswith("/") and Path(value).is_file():
            libraries.append(value)
    return (executable, *sorted(set(libraries)))


def package_revision(name: str) -> str:
    try:
        return version(name)
    except PackageNotFoundError:
        return "uninstalled"


@cache
def _file_revision(path: str, size: int, mtime_ns: int) -> str:
    with Path(path).open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def file_revision(path: Path) -> str:
    stat = path.stat()
    return _file_revision(str(path.resolve()), stat.st_size, stat.st_mtime_ns)


@cache
def environment_revisions(
    python: str | None,
    packages: tuple[str, ...],
) -> dict[str, str]:
    if python is None:
        return {name: package_revision(name) for name in packages}
    root = Path(python).parent.parent
    paths = [str(path) for path in root.glob("lib/python*/site-packages")]
    installed = {
        dist.metadata["Name"].lower().replace("_", "-"): dist.version
        for dist in distributions(path=paths)
    }
    return {name: installed.get(name, "uninstalled") for name in packages}


DOWNLOAD = "yt-dlp-mp3-best-q0-v1"
DECODE = "ffmpeg-first-audio-mono11025-s16le-v1"
KEY = "libkeyfinder-standard-v1"
STEM = "audio-separator-0.44.1-mp3-defaults-v1"
MIX = "ffmpeg-stereo48k-amix-unity-limit089-v1"
TRANSFORM = "rubberband-r3-formant-mp3-q0-v1"
ASR = "qwen3-asr-bf16-window25-batch2-tokens512-v1"
QWEN_MODEL = "Qwen/Qwen3-ASR-1.7B"
QWEN_REVISION = "7278e1e70fe206f11671096ffdd38061171dd6e5"
ALIGNMENT = "torchaudio-MMS_FA-qwen-reference-ctc-canonical-positions-v1"
ALIGNMENT_MODEL = "torchaudio/MMS_FA"
ASR_SAMPLE_RATE = 16000
STRUCTURE = "songformer-short-tail-v1"
STRUCTURE_MODEL = "ASLP-lab/SongFormer"
STRUCTURE_REVISION = "a75880ed1b7375ac71860ec6c4fc9c899cf99515"
STRUCTURE_SHA256 = "8dcabf4ea19973edd51b9e5794004775fa7e8de3ecfa07eb1dbce00f516ce7f7"
PITCH = "torchcrepe-0.0.24-full-weighted-argmax-rms-gating-v1"
ASR_PACKAGES = ("qwen-asr", "torch", "transformers", "librosa", "numpy", "soundfile")
ALIGNMENT_PACKAGES = ("torch", "torchaudio", "uroman")
STRUCTURE_PACKAGES = ("torch", "torchaudio", "transformers", "muq", "librosa", "numpy")
PITCH_PACKAGES = ("torch", "torchcrepe", "numpy", "scipy")

# Independent discovery producer; never invalidates audio/ASR artifacts.
SONG_SEARCH = "qwen3-4b-2507-torch2.8-transformers4.57.6-greedy256-grounded-v2"
SONG_MODEL = "Qwen/Qwen3-4B-Instruct-2507"
SONG_MODEL_REVISION = "cdbee75f17c01a7cc42f958dc650907174af0554"
