#!/usr/bin/env python3
"""
Downloads a URL as MP3, runs audio-separator with GPU on Modal,
saves to ./modal-output/: the original MP3, vocals, instruments, plus
optional decrowded instruments, dereverbed vocals, male/female chorus
splits (chorus is taken from the dereverbed vocals when dereverb is on),
and a lead/backing vocalist split (run on the raw vocals; lead and
backing are then dereverbed too when dereverb is on).

Usage:
    modal run modal_separate.py --url "https://..."
    modal run modal_separate.py --url "https://..." --decrowd --dereverb --chorus --vocalists
"""

import hashlib
import logging
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import NamedTuple

import modal

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
log = logging.getLogger(__name__)

app = modal.App("audio-separator")

model_volume = modal.Volume.from_name("audio-separator-models", create_if_missing=True)
MODEL_CACHE = "/model-cache"
# Per-stem output cache, keyed by sha256(input) + model filename. audio-separator is
# deterministic given input + model, so cached output directories can be reused verbatim.
STEM_CACHE = f"{MODEL_CACHE}/stems"
TIMEOUT = 1200 # 20 minutes — up to nine sequential separator passes on L40S
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
    # debian_slim has none, so use NVIDIA's CUDA image and pin Torch to a matching wheel.
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
)


class StemOutput(NamedTuple):
    label: str
    # Case-insensitive exact match against the LAST `_(name)_` group in the output filename
    # (audio-separator appends the input basename, so the input may carry earlier `_(name)_`
    # markers from prior passes — only the trailing one identifies the current stem).
    # Substring matching is unsafe here: e.g. "male" is a substring of "female". Empty
    # string acts as a wildcard that claims any leftover output not yet matched.
    keep_pattern: str


class Stem(NamedTuple):
    model: str
    outputs: list[StemOutput]  # one or more labeled outputs to keep from a single run


PRIMARY_STEMS = [
    Stem("vocals_mel_band_roformer.ckpt", [StemOutput("vocals", "Vocals")]),
    Stem("melband_roformer_inst_v2.ckpt", [StemOutput("instruments", "Instrumental")]),
]

# Run on the extracted instruments to strip crowd noise.
DECROWD_STEMS = [
    Stem(
        "mel_band_roformer_crowd_aufr33_viperx_sdr_8.7144.ckpt",
        [StemOutput("instruments-decrowded", "Other")],
    ),
]

# Run on the extracted vocals to strip reverb; keep the dry stem.
DEREVERB_STEMS = [
    Stem(
        "dereverb_mel_band_roformer_anvuew_sdr_19.1729.ckpt",
        [StemOutput("vocals-dry", "noreverb")],
    ),
]

# Run on the (dereverbed, if available) vocals to split male/female; keep both stems.
CHORUS_STEMS = [
    Stem(
        "model_chorus_bs_roformer_ep_267_sdr_24.1275.ckpt",
        [
            StemOutput("vocals-male", "Male"),
            StemOutput("vocals-female", "Female"),
        ],
    ),
]

# Split raw vocals into lead + backing using the gabox v2 karaoke model.
VOCALIST_STEMS = [
    Stem(
        "mel_band_roformer_karaoke_gabox_v2.ckpt",
        [
            StemOutput("lead", "Vocals"),
            StemOutput("backing", ""),
        ],
    ),
]

# Run on the instruments track. Vocals output is discarded (near-silent bleed).
DRUM_STEMS = Stem(
    "htdemucs_ft.yaml",
    [
        StemOutput("drums", "Drums"),
        StemOutput("bass", "Bass"),
        StemOutput("other", "Other"),
    ],
)


class StemResult(NamedTuple):
    data: bytes
    duration_s: float


SeparationResult = dict[str, StemResult]  # keyed by StemOutput.label


def _last_stem_name(filename: str) -> str | None:
    """Extract the LAST `_(StemName)_` group from an audio-separator output filename."""
    name = filename.removesuffix(".mp3")
    open_idx = name.rfind("_(")
    if open_idx == -1:
        return None
    close_idx = name.find(")_", open_idx)
    if close_idx == -1:
        return None
    return name[open_idx + 2 : close_idx]


def run_separator(
    input_path: Path,
    stem: Stem,
    out_dir: Path,
    use_cache: bool = True,
) -> dict[str, tuple[StemResult, Path]]:
    out_dir.mkdir(parents=True)
    cache_dir = Path(STEM_CACHE) / hashlib.sha256(input_path.read_bytes()).hexdigest() / stem.model

    if use_cache and cache_dir.is_dir():
        log.info("cache hit %s on %s", stem.model, input_path.name)
        for src in cache_dir.glob("*.mp3"):
            shutil.copy(src, out_dir / src.name)
        duration = 0.0
    else:
        start = time.monotonic()
        subprocess.run(
            [
                "audio-separator",
                str(input_path),
                "--model_filename", stem.model,
                "--output_format", "MP3",
                "--output_dir", str(out_dir),
                "--model_file_dir", MODEL_CACHE,
            ],
            check=True,
        )
        duration = time.monotonic() - start
        if use_cache:
            # Stage into a sibling dir and rename so a crash mid-write never leaves
            # a half-populated cache entry that a later run would treat as a hit.
            staging = cache_dir.parent / f".{cache_dir.name}.tmp"
            if staging.exists():
                shutil.rmtree(staging)
            staging.mkdir(parents=True)
            for src in out_dir.glob("*.mp3"):
                shutil.copy(src, staging / src.name)
            if cache_dir.exists():
                shutil.rmtree(cache_dir)
            staging.rename(cache_dir)

    candidates = list(out_dir.glob("*.mp3"))
    used: set[Path] = set()
    matched: dict[str, tuple[StemResult, Path]] = {}
    for output in stem.outputs:
        for path in candidates:
            if path in used:
                continue
            last = _last_stem_name(path.name)
            if last is None:
                continue
            if output.keep_pattern == "" or output.keep_pattern.lower() == last.lower():
                matched[output.label] = StemResult(data=path.read_bytes(), duration_s=duration), path
                used.add(path)
                break
        else:
            raise RuntimeError(f"no output matching {output.keep_pattern!r} in {out_dir}")
    return matched


@app.function(
    image=image,
    gpu=GPU,
    volumes={MODEL_CACHE: model_volume},
    timeout=TIMEOUT,
)
def separate(
    audio_bytes: bytes,
    filename: str,
    decrowd: bool = False,
    dereverb: bool = False,
    chorus: bool = False,
    vocalists: bool = False,
    drums: bool = False,
    no_cache: bool = False,
) -> SeparationResult:
    with tempfile.TemporaryDirectory() as tmpdir:
        tmp = Path(tmpdir)
        input_path = tmp / filename
        input_path.write_bytes(audio_bytes)

        results: SeparationResult = {}
        paths: dict[str, Path] = {}
        use_cache = not no_cache

        def run(stems: list[Stem], source: Path, suffix: str = "") -> None:
            for stem in stems:
                out_dir = tmp / f"{stem.model}{suffix}"
                for label, (result, path) in run_separator(source, stem, out_dir, use_cache=use_cache).items():
                    results[label] = result
                    paths[label] = path

        run(PRIMARY_STEMS, input_path)
        if decrowd:
            run(DECROWD_STEMS, paths["instruments"])

        chorus_source = paths["vocals"]
        if dereverb:
            run(DEREVERB_STEMS, paths["vocals"])
            chorus_source = paths["vocals-dry"]
        if chorus:
            run(CHORUS_STEMS, chorus_source)
        if vocalists:
            run(VOCALIST_STEMS, paths["vocals"])
            if dereverb:
                for src in ("lead", "backing"):
                    stem = Stem(
                        DEREVERB_STEMS[0].model,
                        [StemOutput(f"{src}-dry", "noreverb")],
                    )
                    run([stem], paths[src], suffix=f"-{src}")
        if drums:
            out_dir = tmp / DRUM_STEMS.model
            for label, (result, path) in run_separator(paths["instruments"], DRUM_STEMS, out_dir, use_cache=use_cache).items():
                results[label] = result
                paths[label] = path

        model_volume.commit()
        return results


def download_mp3(url: str, dest_dir: str) -> tuple[bytes, str]:
    subprocess.run(
        [
            "yt-dlp",
            "-f", "bestaudio/best",
            "-x",
            "--audio-format", "mp3",
            "--audio-quality", "0",
            "--no-playlist",
            "-o", str(Path(dest_dir) / "%(title)s.%(ext)s"),
            url,
        ],
        check=True,
    )
    mp3_files = list(Path(dest_dir).glob("*.mp3"))
    if not mp3_files:
        raise RuntimeError("yt-dlp produced no MP3 file")
    path = mp3_files[0]
    return path.read_bytes(), path.name


def save_stems(results: SeparationResult, output_dir: Path, base_name: str) -> None:
    for label, stem_result in results.items():
        out_path = output_dir / f"{base_name}_{label}.mp3"
        out_path.write_bytes(stem_result.data)
        log.info("saved %s (%.1f MB)", out_path, len(stem_result.data) / 1024 / 1024)


@app.local_entrypoint()
def main(
    url: str = "",
    path: str = "",
    decrowd: bool = False,
    dereverb: bool = False,
    chorus: bool = False,
    vocalists: bool = False,
    drums: bool = False,
    no_cache: bool = False,
):
    if not url and not path:
        log.error("provide --url or --path")
        sys.exit(1)
    if url and path:
        log.error("provide --url or --path, not both")
        sys.exit(1)

    if path:
        p = Path(path)
        audio_bytes = p.read_bytes()
        filename = p.name
        size_mb = len(audio_bytes) / 1024 / 1024
        log.info("loaded %s (%.1f MB)", filename, size_mb)
    else:
        with tempfile.TemporaryDirectory() as tmpdir:
            log.info("downloading %s", url)
            audio_bytes, filename = download_mp3(url, tmpdir)
            size_mb = len(audio_bytes) / 1024 / 1024
            log.info("downloaded %s (%.1f MB)", filename, size_mb)

    log.info(
        "running audio-separator on Modal (gpu=%s, decrowd=%s, dereverb=%s, chorus=%s, vocalists=%s, drums=%s, no_cache=%s)...",
        GPU, decrowd, dereverb, chorus, vocalists, drums, no_cache,
    )
    start = time.monotonic()
    results = separate.remote(
        audio_bytes, filename,
        decrowd=decrowd, dereverb=dereverb, chorus=chorus, vocalists=vocalists,
        drums=drums, no_cache=no_cache,
    )
    total_s = time.monotonic() - start

    if not results:
        log.error("no stems returned")
        sys.exit(1)

    output_dir = Path("modal-output")
    output_dir.mkdir(exist_ok=True)
    base_name = Path(filename).stem
    original_path = output_dir / f"{base_name}_original.mp3"
    original_path.write_bytes(audio_bytes)
    log.info("saved %s (%.1f MB)", original_path, size_mb)
    save_stems(results, output_dir, base_name)

    stem_times = "  ".join(f"{label}={r.duration_s:.1f}s" for label, r in results.items())
    log.info("done  gpu=%s  %s  total=%.1fs", GPU, stem_times, total_s)
