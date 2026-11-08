"""Finite, source-clock producers for an isolated, preprovisioned GPU runtime."""

# Neural dependencies belong only to the selected producer's interpreter.
# ruff: noqa: PLC0415
from __future__ import annotations

import hashlib
import io
import json
import math
import os
import sys
import zipfile
from dataclasses import asdict
from pathlib import Path

from separator.inference import OPERATIONS, InferenceRequest


def _json(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8")


def _require_parameters(parameters: dict, *names: str) -> None:
    if not isinstance(parameters, dict) or parameters.keys() != set(names):
        raise ValueError(f"Expected inference parameters: {', '.join(names) or 'none'}")


def _separation(source: Path, parameters: dict, tmp: Path, model_cache: Path) -> bytes:
    from separator.options import VOCAL_STEM_LABELS
    from separator.stems import (
        DECROWD_STEMS,
        DECROWD_VOCALS_STEMS,
        DEREVERB_MODEL,
        DRUM_STEMS,
        GENDER_STEMS,
        INSTRUMENTS_STEM,
        LEAD_BACKING_STEMS,
        VOCALS_STEM,
        Stem,
        StemOutput,
        _run_separator,
    )

    _require_parameters(parameters, "model", "outputs")
    if not isinstance(parameters["model"], str) or not isinstance(
        parameters["outputs"], list
    ):
        raise ValueError("Separation requires a configured model and output list")
    outputs = []
    for output in parameters["outputs"]:
        _require_parameters(output, "label", "keep_pattern")
        if not all(isinstance(value, str) for value in output.values()):
            raise ValueError("Separation output labels and patterns must be strings")
        outputs.append(StemOutput(**output))
    stem = Stem(parameters["model"], outputs)
    configured = [
        VOCALS_STEM,
        INSTRUMENTS_STEM,
        *DECROWD_STEMS,
        *DECROWD_VOCALS_STEMS,
        *GENDER_STEMS,
        *LEAD_BACKING_STEMS,
        DRUM_STEMS,
        *(
            Stem(DEREVERB_MODEL, [StemOutput(f"{label}-dry", "noreverb")])
            for label in VOCAL_STEM_LABELS
        ),
    ]
    if stem not in configured:
        raise ValueError("Unsupported separation model/output configuration")
    if not (model_cache / stem.model).is_file():
        raise FileNotFoundError(f"Separation model must be prepared: {stem.model}")
    result = _run_separator(source, stem, tmp / "separated", str(model_cache))
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w") as archive:
        for label, (audio, _) in result.items():
            if not audio.data:
                raise RuntimeError("Separator produced an empty stem")
            archive.writestr(label, audio.data)
    return stream.getvalue()


def _audio(source: Path):
    from separator.transcribe import _load_audio

    audio, sample_rate = _load_audio(source)
    duration_s = len(audio) / sample_rate
    if not math.isfinite(duration_s) or duration_s <= 0:
        raise ValueError("Lyrics extraction requires audio with a finite duration")
    return audio, sample_rate, duration_s


def _recognition(source: Path, parameters: dict) -> bytes:
    from separator.transcribe import _recognize_windows, _windows

    _require_parameters(parameters)
    audio, sample_rate, duration_s = _audio(source)
    chunks = _recognize_windows(audio, sample_rate, _windows(audio))
    pcm = memoryview(audio)
    shape = pcm.shape
    assert shape is not None
    return _json(
        {
            "chunks": [asdict(chunk) for chunk in chunks],
            "duration_s": duration_s,
            "pcm_identity": [
                sample_rate,
                pcm.format,
                list(shape),
                hashlib.sha256(pcm).hexdigest(),
            ],
        }
    )


def _aligner(model_cache: Path):
    import torchaudio  # ty: ignore[unresolved-import]

    from separator.transcribe import _load_aligner

    # Torchaudio's loader otherwise downloads missing weights independently of
    # Hugging Face's offline switches. The pinned bundle defines this filename.
    checkpoint = Path(torchaudio.pipelines.MMS_FA._path).name
    if not (model_cache / "torch" / "checkpoints" / checkpoint).is_file():
        raise FileNotFoundError(f"Alignment model must be prepared: {checkpoint}")
    return _load_aligner(model_cache)


def _alignment(source: Path, parameters: dict, model_cache: Path) -> bytes:
    from separator.lyrics import RecognitionChunk
    from separator.lyrics_reference import ReferencePhrase, reference_review_from_dict
    from separator.transcribe import (
        _windows,
        align_reference_acoustics,
    )

    mode = parameters.get("mode")
    if mode == "recognition":
        _require_parameters(parameters, "mode", "chunks")
        if not isinstance(parameters["chunks"], list):
            raise ValueError("Recognition alignment requires a chunk list")
        chunks = [RecognitionChunk(**chunk) for chunk in parameters["chunks"]]
    elif mode == "reference":
        _require_parameters(parameters, "mode", "review", "phrases")
        if not isinstance(parameters["review"], dict) or not isinstance(
            parameters["phrases"], list
        ):
            raise ValueError("Reference alignment requires a review and phrase list")
        review = reference_review_from_dict(parameters["review"])
        phrases = [ReferencePhrase(**phrase) for phrase in parameters["phrases"]]
    else:
        raise ValueError("Unsupported alignment mode")
    audio, sample_rate, duration_s = _audio(source)
    if mode == "reference":
        aligned_lines, acoustic_evidence = align_reference_acoustics(
            audio, _aligner(model_cache), review, phrases
        )
        return _json(
            {
                "aligned_lines": {
                    str(index): [asdict(word) for word in words]
                    for index, words in aligned_lines.items()
                },
                "acoustic_evidence": {
                    str(index): asdict(evidence)
                    for index, evidence in acoustic_evidence.items()
                },
            }
        )
    alignments = []
    aligner = None
    for (start, end), chunk in zip(_windows(audio), chunks, strict=True):
        if chunk.text.strip():
            if aligner is None:
                aligner = _aligner(model_cache)
            emission, frame_s = aligner.emissions(audio[start:end])
            alignments.append(
                aligner.align(emission, frame_s, chunk.text, start / sample_rate)
            )
        else:
            alignments.append([])
    pcm = memoryview(audio)
    shape = pcm.shape
    assert shape is not None
    return _json(
        {
            "alignments": [
                [asdict(word) for word in alignment] for alignment in alignments
            ],
            "duration_s": duration_s,
            "pcm_identity": [
                sample_rate,
                pcm.format,
                list(shape),
                hashlib.sha256(pcm).hexdigest(),
            ],
        }
    )


def run_inference(request: InferenceRequest, tmp: Path, model_cache: Path) -> bytes:
    """Run exactly one real producer; never consult result caches or plan a DAG."""
    # Unpickling does not run dataclass validation; revalidate before filesystem I/O.
    request = InferenceRequest(
        operation=request.operation,
        audio_bytes=request.audio_bytes,
        filename=request.filename,
        producer_digest=request.producer_digest,
        parameters=request.parameters,
    )
    if request.operation not in OPERATIONS:
        raise ValueError("Unsupported inference operation")
    if not isinstance(request.parameters, dict):
        raise ValueError("Inference parameters must be an object")
    os.environ["HF_HOME"] = str(model_cache / "huggingface")
    # Dynamic Transformers code is copied into a private writable module cache;
    # immutable model snapshots themselves remain on the read-only volume.
    os.environ["HF_MODULES_CACHE"] = str(tmp / "hf-modules")
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    inputs = tmp / "input"
    inputs.mkdir(parents=True, exist_ok=True)
    source = inputs / request.filename
    source.write_bytes(request.audio_bytes)
    if request.operation == "separation":
        return _separation(source, request.parameters, tmp, model_cache)
    if request.operation == "recognition":
        return _recognition(source, request.parameters)
    if request.operation == "alignment":
        return _alignment(source, request.parameters, model_cache)
    _require_parameters(request.parameters)
    if request.operation == "pitch":
        from separator.detect_pitch import predict_pitch

        return predict_pitch(source)
    if request.operation == "structure":
        from separator.structure import analyze_structure_raw

        return _json(analyze_structure_raw(source, model_cache))
    raise ValueError("Unsupported inference operation")


def main() -> None:
    import tempfile

    if len(sys.argv) != 5:
        raise SystemExit(
            "Usage: python -m separator.inference_runtime "
            "REQUEST_JSON INPUT_PATH OUTPUT_PATH MODEL_CACHE"
        )
    request_path, input_path, output_path, model_cache = map(Path, sys.argv[1:])
    metadata = json.loads(request_path.read_text("utf-8"))
    _require_parameters(
        metadata, "operation", "filename", "producer_digest", "parameters"
    )
    request = InferenceRequest(audio_bytes=input_path.read_bytes(), **metadata)
    with tempfile.TemporaryDirectory(prefix="inference-") as directory:
        result = run_inference(request, Path(directory), model_cache)
    output_path.write_bytes(result)


if __name__ == "__main__":
    main()
