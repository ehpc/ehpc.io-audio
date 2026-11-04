"""
Modal app definition for GPU-accelerated vocal/instrument separation.

Deploy with `modal deploy separator/modal_app.py`; the backend looks up the
deployed `separate` function by name (see backend/modal_client.py) rather
than importing this module directly.
"""

import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import modal

from separator.lyrics_reference import ReferenceMetadata
from separator.options import OPTIONS_SCHEMA_VERSION, SeparationOptions
from separator.processing import ProcessingResult, analysis_transport, run_processing
from separator.stems import SeparationResult, run_separation

app = modal.App("audio-separator-v2")

model_volume = modal.Volume.from_name("audio-separator-models", create_if_missing=True)
MODEL_CACHE = "/model-cache"
# Per-stem output cache, keyed by sha256(input) + model filename. audio-separator is
# deterministic given input + model, so cached output directories can be reused
# verbatim.
STEM_CACHE = f"{MODEL_CACHE}/stems"
TIMEOUT = 1200  # 20 minutes — up to nine sequential separator passes on L40S
# Benchmarked on one 6.8 MB song (2 stems); times include model load.
# GPU    time   $/song  rel cost  rel speed  $/min faster than T4
# T4     231s   $0.038  x1.0      x1.0       — (dominated by L4)
# L4     157s   $0.035  x0.9      x1.5       cheaper AND faster
# A10G   125s   $0.038  x1.0      x1.8       ~$0.00  (essentially free)
# L40S    86s   $0.046  x1.2      x2.7       $0.003  ← sweet spot
# H100    75s   $0.082  x2.2      x3.1       $0.017
# B200    69s   $0.119  x3.1      x3.4       $0.030
GPU = "L40S"
ASR_PYTHON = "/opt/lyrics-reference/bin/python"
STRUCTURE_PYTHON = "/opt/lyrics-structure/bin/python"

image = (
    # onnxruntime-gpu needs CUDA 12 + cuDNN 9 system libraries.
    modal.Image.from_registry(
        # Ubuntu 24.04 supplies FFmpeg 6+ with latency-compensated alimiter.
        "nvidia/cuda:12.6.3-cudnn-runtime-ubuntu24.04",
        # Separate from the Python 3.15 client: torch/torchaudio/onnxruntime-gpu
        # do not yet publish cp315 wheels for this GPU dependency environment.
        add_python="3.13",
    )
    # clang is needed to build diffq's C extension (transitive dep of audio-separator).
    .apt_install("ffmpeg", "clang", "python3.12-venv")
    .pip_install(
        "audio-separator[gpu]==0.44.1",
        # librosa 1 removed audioread, which this separator version imports.
        "librosa==0.11.0",
        extra_index_url="https://download.pytorch.org/whl/cu124",
    )
    # SongFormer incorporates CC-BY-NC-4.0 MuQ weights. Noncommercial use only;
    # commercial deployment needs separate rights clearance. Never install this
    # dependency tree over the separator's ONNX GPU or singing-ASR environments.
    .run_commands(
        "python3.12 -m venv /opt/lyrics-structure",
        "/opt/lyrics-structure/bin/pip install "
        "torch==2.4.0 torchaudio==2.4.0 torchvision==0.19.0 "
        "--index-url https://download.pytorch.org/whl/cu124",
        "/opt/lyrics-structure/bin/pip install "
        "torch==2.4.0 torchaudio==2.4.0 torchvision==0.19.0 "
        "numpy==1.26.4 scipy==1.15.2 transformers==4.51.1 "
        "huggingface-hub==0.33.5 safetensors==0.5.3 accelerate==1.5.2 "
        "librosa==0.11.0 muq==0.1.0 nnAudio==0.3.3 easydict==1.13 x-clip==0.14.4 "
        "omegaconf==2.3.0 ema-pytorch==0.7.7 x-transformers==2.4.14 "
        "msaf==0.1.80 loguru==0.7.3",
        "/opt/lyrics-structure/bin/pip install torchcrepe==0.0.24",
    )
    # Qwen ASR (Apache-2.0) requires transformers 4.57.6. MMS_FA alignment
    # weights are CC-BY-NC-4.0, like MuQ above: noncommercial use only.
    # Keep these dependencies isolated from SongFormer and ONNX.
    .run_commands(
        "python3.12 -m venv /opt/lyrics-reference",
        "/opt/lyrics-reference/bin/pip install "
        "torch==2.8.0 torchaudio==2.8.0 "
        "--index-url https://download.pytorch.org/whl/cu128",
        "/opt/lyrics-reference/bin/pip install qwen-asr==0.0.6 uroman==1.3.1.1",
    )
    # This module lives inside the `separator` package and imports its siblings
    # (separator.options / separator.stems). Modal only auto-includes the entrypoint
    # file itself, so the package must be added explicitly or the container
    # crash-loops with `ModuleNotFoundError: No module named 'separator'`.
    .add_local_python_source("separator")
)

# Text discovery has no audio dependencies and never runs in the web container.
song_search_image = (
    modal.Image.debian_slim(python_version="3.13")
    .pip_install(
        "torch==2.8.0",
        "transformers==4.57.6",
        "ytmusicapi==1.11.5",
    )
    .add_local_python_source("separator")
)
song_search_volume = modal.Volume.from_name(
    "audio-song-discovery", create_if_missing=True
)


@app.function(
    image=song_search_image,
    gpu="L4",
    volumes={"/song-search-cache": song_search_volume},
    timeout=600,
    max_containers=1,
)
def search_song(query: str) -> dict:
    from separator.song_search import run_search  # noqa: PLC0415

    song_search_volume.reload()
    try:
        return run_search(query, "/song-search-cache")
    finally:
        song_search_volume.commit()


@app.function(image=image)
def healthcheck() -> str:
    # CPU-only, no models. Reaching the function body at all proves the container
    # started, which requires this module's top-level `from separator...` imports
    # to succeed inside the deployed image — the exact thing that crash-loops if
    # the image omits the package. The opt-in smoke test spawns this.
    return "ok"


@contextmanager
def _source_audio(audio_bytes: bytes, filename: str) -> Iterator[tuple[Path, Path]]:
    with tempfile.TemporaryDirectory() as tmpdir:
        tmp = Path(tmpdir)
        input_path = tmp / filename
        input_path.write_bytes(audio_bytes)
        yield tmp, input_path


@app.function(
    image=image,
    gpu=GPU,
    volumes={MODEL_CACHE: model_volume},
    timeout=TIMEOUT,
)
def separate(
    audio_bytes: bytes,
    filename: str,
    options: SeparationOptions,
    *,
    options_schema: int,
) -> SeparationResult:
    """Core audio RPC: keep its dictionary result usable by audio-only clients."""
    if options_schema != OPTIONS_SCHEMA_VERSION:
        raise ValueError("incompatible separation options schema")
    model_volume.reload()
    with _source_audio(audio_bytes, filename) as (tmp, input_path):
        try:
            return run_separation(input_path, options, tmp, MODEL_CACHE, STEM_CACHE)
        finally:
            # A later stage failing must not discard earlier validated work.
            model_volume.commit()


@app.function(
    image=image,
    gpu=GPU,
    volumes={MODEL_CACHE: model_volume},
    timeout=TIMEOUT,
)
def separate_with_lyrics(
    audio_bytes: bytes,
    filename: str,
    options: SeparationOptions,
    reference_metadata: ReferenceMetadata | None = None,
    *,
    analysis_schema: int = 1,
    options_schema: int,
) -> ProcessingResult:
    """Optional lyrics/pitch RPC; audio-only clients retain their dict RPC."""
    if options_schema != OPTIONS_SCHEMA_VERSION:
        raise ValueError("incompatible separation options schema")
    model_volume.reload()
    with _source_audio(audio_bytes, filename) as (tmp, input_path):
        try:
            results = run_processing(
                input_path,
                options,
                tmp,
                MODEL_CACHE,
                STEM_CACHE,
                TIMEOUT,
                ASR_PYTHON,
                STRUCTURE_PYTHON,
                reference_metadata,
            )
            return analysis_transport(results, analysis_schema)
        finally:
            model_volume.commit()
