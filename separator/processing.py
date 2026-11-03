"""GPU audio graph with optional lyrics/reference review and vocal pitch."""

import json
import subprocess
import sys
import time
from dataclasses import asdict, dataclass, replace
from pathlib import Path

from separator import cache_versions
from separator.artifact_cache import cache_key, cached_bytes, digest
from separator.lyrics import Transcript, TranscriptSection, transcript_from_json
from separator.lyrics_reference import ReferenceMetadata, lookup_reference
from separator.options import SeparationOptions
from separator.pitch import (
    PitchAnalysis,
    PitchTrack,
    pitch_from_json,
    pitch_to_json,
    transform_analysis,
)
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
        replace(
            result.transcript, words=[], reference=None, canonical_word_positions=[]
        )
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


def _analysis_output(
    command: list[str],
    output: Path,
    root: Path,
    key: str,
    deadline: float,
    label: str,
) -> bytes:
    def produce() -> bytes:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError(f"{label} exceeded the processing time limit")
        output.unlink(missing_ok=True)
        try:
            subprocess.run(
                command,
                check=True,
                capture_output=True,
                text=True,
                timeout=remaining,
                cwd=Path(__file__).resolve().parent.parent,
            )
        except subprocess.CalledProcessError as exc:
            raise RuntimeError(f"{label} failed: {exc.stderr.strip()[-400:]}") from exc
        except subprocess.TimeoutExpired as exc:
            raise TimeoutError(f"{label} exceeded the processing time limit") from exc
        data = output.read_bytes()
        # Validate the complete schema before publication, not merely JSON syntax.
        if label == "Lyrics transcription":
            transcript_from_json(data.decode())
        elif label == "Vocal pitch detection":
            if len(pitch_from_json(data.decode()).tracks) != 1:
                raise ValueError("Pitch producer must return one source track")
        else:
            value = json.loads(data)
            for section in value["sections"]:
                TranscriptSection(**section)
            if not isinstance(value["structure_model"], str):
                raise ValueError("Invalid structure provenance")
        return data

    return cached_bytes(root, key, produce)


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
    stems = run_separation(input_path, options, tmp, model_cache, stem_cache)
    root = Path(model_cache) / "analysis-results"
    decoder = cache_versions.binary_revision("ffmpeg")
    transcript = None
    if options.needs_lyrics:
        source = tmp / "lyrics-vocals.mp3"
        source.write_bytes(stems["vocals"].data)
        reference = lookup_reference(
            reference_metadata, Path(model_cache) / "lyrics-references"
        )
        reference_path = tmp / "lyrics-reference.json"
        reference_path.write_text(
            json.dumps(asdict(reference.review), ensure_ascii=False), "utf-8"
        )
        # Fetch time/cache bookkeeping cannot change reference alignment.
        reference_identity = asdict(reference.review)
        for field in ("fetched_at", "cached", "reason"):
            reference_identity.pop(field, None)
        output = tmp / "transcript.json"
        data = _analysis_output(
            [
                asr_python,
                "-m",
                "separator.transcribe",
                str(source),
                str(Path(model_cache) / "qwen-asr"),
                str(output),
                str(reference_path),
            ],
            output,
            root / "lyrics",
            cache_key(
                cache_versions.ASR,
                cache_versions.QWEN_REVISION,
                decoder,
                cache_versions.environment_revisions(
                    asr_python, cache_versions.ASR_PACKAGES
                ),
                cache_versions.environment_revisions(
                    asr_python, cache_versions.ALIGNMENT_PACKAGES
                ),
                cache_versions.ALIGNMENT,
                digest(stems["vocals"].data),
                reference_identity,
            ),
            deadline,
            "Lyrics transcription",
        )
        transcript = transcript_from_json(data.decode())
        structure_output = tmp / "structure.json"
        structure = json.loads(
            _analysis_output(
                [
                    structure_python,
                    "-m",
                    "separator.structure",
                    str(input_path),
                    str(Path(model_cache) / "songformer"),
                    str(structure_output),
                ],
                structure_output,
                root / "structure",
                cache_key(
                    cache_versions.STRUCTURE,
                    cache_versions.STRUCTURE_MODEL,
                    cache_versions.STRUCTURE_REVISION,
                    cache_versions.STRUCTURE_SHA256,
                    decoder,
                    cache_versions.environment_revisions(
                        structure_python, cache_versions.STRUCTURE_PACKAGES
                    ),
                    digest(input_path.read_bytes()),
                ),
                deadline,
                "Musical structure analysis",
            )
        )
        transcript = replace(
            transcript,
            sections=[
                TranscriptSection(**section) for section in structure["sections"]
            ],
            structure_model=structure["structure_model"],
        )
    pitch_json = None
    if options.needs_pitch:
        tracks = []
        duration = 0.0
        for label in options.pitch_labels:
            path = tmp / f"pitch-{label}.mp3"
            path.write_bytes(stems[label].data)
            manifest = tmp / "pitch-sources.json"
            manifest.write_text(json.dumps({label: str(path)}), "utf-8")
            output = tmp / "pitch.json"
            analysis = pitch_from_json(
                _analysis_output(
                    [
                        structure_python,
                        "-m",
                        "separator.detect_pitch",
                        str(manifest),
                        str(output),
                    ],
                    output,
                    root / "pitch",
                    cache_key(
                        cache_versions.PITCH,
                        decoder,
                        cache_versions.environment_revisions(
                            structure_python, cache_versions.PITCH_PACKAGES
                        ),
                        digest(stems[label].data),
                    ),
                    deadline,
                    "Vocal pitch detection",
                ).decode()
            )
            tracks.append(PitchTrack(label, analysis.tracks[0].notes))
            duration = max(duration, analysis.source_duration_s)
        pitch_json = pitch_to_json(
            transform_analysis(
                PitchAnalysis(duration, duration, tracks),
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
