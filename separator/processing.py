"""GPU audio graph and optional ASR, with distinct result types."""

import json
import subprocess
import sys
import time
from dataclasses import dataclass, replace
from pathlib import Path

from separator.lyrics import Transcript, TranscriptSection, transcript_from_json
from separator.options import SeparationOptions
from separator.stems import SeparationResult, run_separation


@dataclass
class ProcessingResult:
    audio: SeparationResult
    transcript: Transcript | None = None


def run_processing(
    input_path: Path,
    options: SeparationOptions,
    tmp: Path,
    model_cache: str,
    stem_cache: str,
    timeout_s: float,
    asr_python: str = sys.executable,
    structure_python: str = sys.executable,
) -> ProcessingResult:
    deadline = time.monotonic() + timeout_s
    # Raw vocal prerequisites share the existing graph/cache pass without
    # pretending they are selected audio outputs (which could add dry passes).
    stems = run_separation(input_path, options, tmp, model_cache, stem_cache)
    transcript = None
    if options.extract_lyrics:
        source = tmp / "lyrics-vocals.mp3"
        source.write_bytes(stems["vocals"].data)
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
                    str(Path(model_cache) / "whisper"),
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
    return ProcessingResult(
        audio={label: stems[label] for label in options.output_labels},
        transcript=transcript,
    )
