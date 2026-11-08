"""Explicit, operator-invoked producer dependency build; never a deployment import.

Run intentionally with an existing Modal app as build context::

    python -m separator.build_image --app audio-separator-v2 --environment ehpc-audio

This invokes a real Modal image build and may incur charges. Importing this module
never builds or resolves an image. Normal deployments must use the captured
manifest's immutable image_id and attach current application source separately.

The recipe preserves the producer's existing dependency pins. Resolving its
remaining transitive dependencies is an intentional producer update, not proof
of reproducing an old runtime. After building, explicitly capture a NEW producer
manifest inside that exact image, including its actual packages, decoder, and
prepared/image-bundled asset hashes, before selecting it for deployment. Do not
invent old provenance or bump audio cache identities for UI-only changes.
"""

import argparse

import modal


def build_producer_image(app: modal.App) -> modal.Image:
    """Explicitly build the producer base using an already initialized app.

    No functions/services are deployed, models downloaded, or inference invoked.
    The returned image's object_id is provenance for subsequent exact-runtime
    capture, not a cache identity. Application source is deliberately not attached.
    """
    image = (
        # onnxruntime-gpu needs CUDA 12 + cuDNN 9 system libraries.
        modal.Image.from_registry(
            # Ubuntu 24.04 supplies FFmpeg 6+ with latency-compensated alimiter.
            "nvidia/cuda:12.6.3-cudnn-runtime-ubuntu24.04",
            # Separate from the Python 3.15 client: torch/torchaudio/onnxruntime-gpu
            # do not yet publish cp315 wheels for this GPU dependency environment.
            add_python="3.13",
        )
        # clang builds diffq's C extension (an audio-separator dependency).
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
    )
    return image.build(app)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--app", required=True, help="Existing app used only as image-build context"
    )
    parser.add_argument(
        "--environment",
        required=True,
        help="Explicit Modal environment containing the app",
    )
    arguments = parser.parse_args()
    # Never create or deploy a standalone service/App as a side effect of a build.
    app = modal.App.lookup(
        arguments.app, environment_name=arguments.environment, create_if_missing=False
    )
    with modal.enable_output():
        image = build_producer_image(app)
    print(image.object_id)


if __name__ == "__main__":
    main()
