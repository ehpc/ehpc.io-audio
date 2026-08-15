"""
Modal app definition for GPU-accelerated vocal/instrument separation.

Deploy with `modal deploy separator/modal_app.py`; the backend looks up the
deployed `separate` function by name (see backend/modal_client.py) rather
than importing this module directly.
"""

import tempfile
from pathlib import Path

import modal

from separator.options import SeparationOptions
from separator.stems import SeparationResult, run_separation

app = modal.App("audio-separator")

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

image = (
    # onnxruntime-gpu needs CUDA 12 + cuDNN 9 system libs (libcublasLt.so.12 etc.);
    # debian_slim has none, so use NVIDIA's CUDA image and pin Torch to a matching
    # wheel.
    modal.Image.from_registry(
        "nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04",
        add_python="3.13",
    )
    # clang is needed to build diffq's C extension (transitive dep of audio-separator).
    .apt_install("ffmpeg", "clang")
    .pip_install(
        "audio-separator[gpu]",
        extra_index_url="https://download.pytorch.org/whl/cu124",
    )
    # This module lives inside the `separator` package and imports its siblings
    # (separator.options / separator.stems). Modal only auto-includes the entrypoint
    # file itself, so the package must be added explicitly or the container
    # crash-loops with `ModuleNotFoundError: No module named 'separator'`.
    .add_local_python_source("separator")
)


@app.function(image=image)
def healthcheck() -> str:
    # CPU-only, no models. Reaching the function body at all proves the container
    # started, which requires this module's top-level `from separator...` imports
    # to succeed inside the deployed image — the exact thing that crash-loops if
    # the image omits the package. The opt-in smoke test spawns this.
    return "ok"


@app.function(
    image=image,
    gpu=GPU,
    volumes={MODEL_CACHE: model_volume},
    timeout=TIMEOUT,
)
def separate(
    audio_bytes: bytes, filename: str, options: SeparationOptions
) -> SeparationResult:
    with tempfile.TemporaryDirectory() as tmpdir:
        tmp = Path(tmpdir)
        input_path = tmp / filename
        input_path.write_bytes(audio_bytes)
        results = run_separation(input_path, options, tmp, MODEL_CACHE, STEM_CACHE)
        model_volume.commit()
        return results
