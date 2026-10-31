"""GPU audio graph with optional lyrics/reference review and vocal pitch."""

import json
import subprocess
import sys
import time
from dataclasses import asdict, dataclass, replace
from pathlib import Path

from separator.lyrics import Transcript, TranscriptSection, transcript_from_json
from separator.lyrics_reference import ReferenceMetadata, lookup_reference
from separator.options import SeparationOptions
from separator.pitch import pitch_from_json, pitch_to_json, transform_analysis
from separator.stems import SeparationResult, run_separation


@dataclass
class ProcessingResult:
    audio: SeparationResult
    transcript: Transcript | None = None
    # Primitives-only transport: old web workers can unpickle ProcessingResult
    # during GPU-first promotion without importing new nested analysis classes.
    pitch_json: str | None = None


ANALYSIS_SCHEMA_VERSION = 2


def analysis_transport(
    result: ProcessingResult, schema_version: int
) -> ProcessingResult:
    """One rollout boundary: old web decoders cannot read nullable word scores.

    New clients explicitly request the canonical schema. During GPU-first
    promotion, pre-versioned callers get truthful readable text, without new
    provenance/status enums or unsupported word links. No lyric algorithm differs.
    """
    if schema_version == ANALYSIS_SCHEMA_VERSION:
        return result
    if schema_version != 1:
        raise ValueError("Unsupported analysis RPC schema version")
    transcript = (
        replace(result.transcript, words=[], reference=None)
        if result.transcript is not None
        else None
    )
    pitch_json = result.pitch_json
    if pitch_json is not None:
        pitch = pitch_from_json(pitch_json)
        pitch_json = pitch_to_json(
            replace(
                pitch,
                words=[],
                word_alignment=None,
                tracks=[
                    replace(
                        track,
                        notes=[replace(note, word_indices=[]) for note in track.notes],
                    )
                    for track in pitch.tracks
                ],
            )
        )
    return replace(result, transcript=transcript, pitch_json=pitch_json)


def run_processing(
    input_path: Path,
    options: SeparationOptions,
    tmp: Path,
    model_cache: str,
    stem_cache: str,
    timeout_s: float,
    asr_python: str = sys.executable,
    structure_python: str = sys.executable,
    reference_metadata: ReferenceMetadata | None = None,
) -> ProcessingResult:
    deadline = time.monotonic() + timeout_s
    # Raw vocal prerequisites share the existing graph/cache pass without
    # pretending they are selected audio outputs (which could add dry passes).
    stems = run_separation(input_path, options, tmp, model_cache, stem_cache)
    transcript = None
    if options.extract_lyrics:
        source = tmp / "lyrics-vocals.mp3"
        source.write_bytes(stems["vocals"].data)
        # Resolve an exact-version reference before unprompted recognition.
        # Only public provider records are cached; never source audio or ASR.
        reference = lookup_reference(
            reference_metadata, Path(model_cache) / "lyrics-references"
        )
        reference_path = tmp / "lyrics-reference.json"
        reference_path.write_text(
            json.dumps(asdict(reference.review), ensure_ascii=False), "utf-8"
        )
        output = tmp / "transcript.json"
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("Lyrics extraction exceeded the processing time limit")
        # Separator runs in its own subprocess too. Its GPU allocations are gone
        # before ASR loads; this child exits after ASR, releasing its model as well.
        try:
            subprocess.run(
                [
                    asr_python,
                    "-m",
                    "separator.transcribe",
                    str(source),
                    str(Path(model_cache) / "qwen-asr"),
                    str(output),
                    str(reference_path),
                ],
                check=True,
                capture_output=True,
                text=True,
                timeout=remaining,
                cwd=Path(__file__).resolve().parent.parent,
            )
        except subprocess.CalledProcessError as exc:
            detail = exc.stderr.strip()[-400:]
            raise RuntimeError(f"Lyrics transcription failed: {detail}") from exc
        except subprocess.TimeoutExpired as exc:
            raise TimeoutError(
                "Lyrics extraction exceeded the processing time limit"
            ) from exc
        transcript = transcript_from_json(output.read_text("utf-8"))
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("Lyrics extraction exceeded the processing time limit")
        structure_output = tmp / "structure.json"
        try:
            subprocess.run(
                [
                    structure_python,
                    "-m",
                    "separator.structure",
                    str(input_path),
                    str(Path(model_cache) / "songformer"),
                    str(structure_output),
                ],
                check=True,
                capture_output=True,
                text=True,
                timeout=remaining,
                cwd=Path(__file__).resolve().parent.parent,
            )
        except subprocess.CalledProcessError as exc:
            detail = exc.stderr.strip()[-400:]
            raise RuntimeError(f"Musical structure analysis failed: {detail}") from exc
        except subprocess.TimeoutExpired as exc:
            raise TimeoutError(
                "Lyrics extraction exceeded the processing time limit"
            ) from exc
        structure = json.loads(structure_output.read_text("utf-8"))
        transcript = replace(
            transcript,
            sections=[
                TranscriptSection(**section) for section in structure["sections"]
            ],
            structure_model=structure["structure_model"],
        )
    pitch_json = None
    if options.detect_pitch:
        sources = {}
        for label in options.pitch_labels:
            path = tmp / f"pitch-{label}.mp3"
            path.write_bytes(stems[label].data)
            sources[label] = str(path)
        manifest = tmp / "pitch-sources.json"
        manifest.write_text(json.dumps(sources), "utf-8")
        output = tmp / "pitch.json"
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("Pitch detection exceeded the processing time limit")
        try:
            subprocess.run(
                [
                    structure_python,
                    "-m",
                    "separator.detect_pitch",
                    str(manifest),
                    str(output),
                ],
                check=True,
                capture_output=True,
                text=True,
                timeout=remaining,
                cwd=Path(__file__).resolve().parent.parent,
            )
        except subprocess.CalledProcessError as exc:
            detail = exc.stderr.strip()[-400:]
            raise RuntimeError(f"Vocal pitch detection failed: {detail}") from exc
        except subprocess.TimeoutExpired as exc:
            raise TimeoutError(
                "Pitch detection exceeded the processing time limit"
            ) from exc
        pitch_json = pitch_to_json(
            transform_analysis(
                pitch_from_json(output.read_text("utf-8")),
                options.pitch_semitones,
                options.tempo_percent,
                transcript.words if transcript is not None else None,
                transcript.word_alignment if transcript is not None else None,
            )
        )
    return ProcessingResult(
        audio={label: stems[label] for label in options.output_labels},
        transcript=transcript,
        pitch_json=pitch_json,
    )
