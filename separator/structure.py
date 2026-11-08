"""Real SongFormer inference on the original mix, in an isolated interpreter.

SongFormer: ASLP-lab, CC-BY-4.0. Its incorporated MuQ pretrained weights are
CC-BY-NC-4.0: this runtime is for noncommercial use only; commercial deployment
requires rights clearance. This module never derives musical labels from lyrics.
"""

# Heavy dependencies are installed only in the dedicated structure interpreter.
# ruff: noqa: PLC0415

import inspect
import os
import subprocess
import sys
import tempfile
import textwrap
from dataclasses import dataclass, replace
from pathlib import Path
from types import MethodType

from separator.cache_versions import STRUCTURE_MODEL as MODEL_ID
from separator.cache_versions import STRUCTURE_REVISION as MODEL_REVISION
from separator.lyrics import SECTION_HEADINGS, TranscriptSection

MODEL_PROVENANCE = f"{MODEL_ID}@{MODEL_REVISION}"


@dataclass(frozen=True)
class MusicalStructure:
    sections: list[TranscriptSection]
    structure_model: str = MODEL_PROVENANCE


def _ensure_loop_progress(model) -> None:
    """Repair only the pinned upstream short-tail guard, without cache edits."""
    original = inspect.unwrap(type(model).forward)
    source = textwrap.dedent(inspect.getsource(original))
    guard = "            if end_idx - start_idx <= 1024:\n                continue"
    if source.count(guard) != 1:
        raise RuntimeError("Unsupported SongFormer short-tail implementation")
    source = source.replace(
        guard,
        "            if end_idx - start_idx <= 1024:\n"
        "                i += hop_size\n"
        "                continue",
    )
    namespace = {}
    exec(
        compile(source, "<SongFormer short-tail progress repair>", "exec"),
        original.__globals__,
        namespace,
    )
    model.forward = MethodType(namespace["forward"], model)


def analyze_structure_raw(source: Path, cache: Path) -> dict:
    """Decode the complete original mix without trims or timestamp offsets."""
    with tempfile.TemporaryDirectory(prefix="lyrics-structure-") as directory:
        decoded = Path(directory) / "original-mix.wav"
        subprocess.run(
            [
                "ffmpeg",
                "-v",
                "error",
                "-y",
                "-i",
                str(source),
                "-ar",
                "24000",
                "-ac",
                "1",
                "-c:a",
                "pcm_f32le",
                str(decoded),
            ],
            check=True,
            capture_output=True,
        )
        return _predict_decoded(decoded, cache)


def _predict_decoded(source: Path, cache: Path) -> dict:
    """Return full-context predictions without source-clock section assembly."""
    # Heavy dependencies must never be imported by the web process or separator.
    os.environ["HF_HOME"] = str(cache / "huggingface")
    import soundfile as sf  # ty: ignore[unresolved-import]
    from huggingface_hub import snapshot_download  # ty: ignore[unresolved-import]
    from transformers import AutoModel  # ty: ignore[unresolved-import]

    snapshot = Path(
        snapshot_download(
            MODEL_ID,
            revision=MODEL_REVISION,
            allow_patterns=["*.py", "*.json", "model.safetensors", "musicfm/LICENSE"],
            local_files_only=True,
        )
    )
    # Provisioning verifies the pinned checkpoint before this read-only runtime.
    sys.path.insert(0, str(snapshot))
    os.environ["SONGFORMER_LOCAL_DIR"] = str(snapshot)
    model = (
        AutoModel.from_pretrained(
            str(snapshot),
            trust_remote_code=True,
            low_cpu_mem_usage=False,
            local_files_only=True,
        )
        .to("cuda")
        .eval()
    )
    label_names = sys.modules["dataset.label2id"].ID_TO_LABEL
    predicted_labels = {
        label_names[index]
        for index, excluded in enumerate(model.dataset_id2label_mask[5])
        if not excluded
    }
    if predicted_labels != SECTION_HEADINGS.keys():
        raise ValueError("SongFormer checkpoint does not support the required labels")
    _ensure_loop_progress(model)
    # The published model reads the complete original mix at 24 kHz. No stem,
    # pitch/tempo transform, text, or shifted source clock is supplied here.
    predictions = model(str(source))
    duration = sf.info(source).duration
    return {
        "predictions": predictions,
        "duration_s": duration,
        "structure_model": MODEL_PROVENANCE,
    }


def assemble_structure(
    predictions: list[dict], duration_s: float, structure_model: str
) -> MusicalStructure:
    """Validate and assemble model intervals on the VPS's source clock."""
    sections = []
    for prediction in predictions:
        if prediction["label"] not in SECTION_HEADINGS:
            raise ValueError(f"Unsupported SongFormer label: {prediction['label']}")
        sections.append(
            TranscriptSection(
                start_s=prediction["start"],
                end_s=min(prediction["end"], duration_s),
                label=prediction["label"],
            )
        )
    if not sections:
        raise ValueError("SongFormer returned no musical sections")
    # Decoder frames quantize the last endpoint; the same predicted final
    # interval extends to the real source boundary, including a sub-frame tail.
    sections[-1] = replace(sections[-1], end_s=duration_s)
    return MusicalStructure(sections, structure_model)
