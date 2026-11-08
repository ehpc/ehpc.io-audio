"""Finite synthetic producers for CPU graph/browser tests, never neural inference.

The manifest identifies this fixture's actual configuration/source files and native
FFmpeg. Its clearly synthetic package/model identities must never be presented as
production provenance or used to migrate a real producer cache. Real GPU runtime
verification would reject them. Separation emits measured configurable tones (or
re-encodes the supplied audio); captured words/notes supply the synthetic model
boundary while production code performs assembly, timing transforms and caching.
"""

import hashlib
import io
import json
import math
import subprocess
import sys
import tempfile
import zipfile
from array import array
from collections.abc import Mapping
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, cast

from separator import cache_versions
from separator.inference import OPERATIONS, InferenceRequest
from separator.lyrics import RecognitionChunk, Transcript, TranscriptWord
from separator.pitch import FRAME_SECONDS, PitchAnalysis
from separator.producer_manifest import (
    SEPARATOR_PACKAGES,
    Asset,
    ProducerManifest,
    RuntimeManifest,
    load_manifest,
    save_manifest,
)
from separator.stems import (
    DECROWD_STEMS,
    DECROWD_VOCALS_STEMS,
    DEREVERB_MODEL,
    DRUM_STEMS,
    GENDER_STEMS,
    INSTRUMENTS_STEM,
    LEAD_BACKING_STEMS,
    VOCALS_STEM,
)


@dataclass(frozen=True)
class StemSignal:
    frequency_hz: float
    duration_seconds: float

    def __post_init__(self) -> None:
        if not all(
            math.isfinite(value) and value > 0
            for value in (self.frequency_hz, self.duration_seconds)
        ):
            raise ValueError("Fixture tones require positive finite frequency/duration")


def _json(value: object) -> bytes:
    return json.dumps(
        value, sort_keys=True, ensure_ascii=False, allow_nan=False
    ).encode()


def fixture_manifest(
    root: Path,
    *,
    signals: Mapping[str, StemSignal] | None = None,
    pitch: PitchAnalysis | None = None,
    transcript: Transcript | None = None,
) -> ProducerManifest:
    """Bind a disposable fixture producer to files it actually consumes."""
    root.mkdir(parents=True, exist_ok=True)
    configuration = _json(
        {
            "signals": {
                label: asdict(signal) for label, signal in (signals or {}).items()
            },
            "pitch": asdict(pitch) if pitch is not None else None,
            "transcript": asdict(transcript) if transcript is not None else None,
        }
    )
    source = Path(__file__).read_bytes()
    files = {"cpu-fixture.json": configuration, "cpu-fixture-provider.py": source}
    assets = []
    for name, content in files.items():
        (root / name).write_bytes(content)
        assets.append(Asset(name, hashlib.sha256(content).hexdigest(), len(content)))
    configuration_sha = hashlib.sha256(configuration).hexdigest()
    source_sha = hashlib.sha256(source).hexdigest()
    fixture_revision = hashlib.sha1(configuration, usedforsecurity=False).hexdigest()
    identity = f"cpu-fixture-not-a-neural-runtime:{source_sha}"
    ffmpeg = cache_versions.binary_revision("ffmpeg")

    def packages(names: tuple[str, ...]) -> dict[str, str]:
        # These slots describe the injected substitute, NOT installed Torch/ASR.
        return dict.fromkeys(names, identity)

    stems = [
        VOCALS_STEM,
        INSTRUMENTS_STEM,
        *DECROWD_STEMS,
        *DECROWD_VOCALS_STEMS,
        *GENDER_STEMS,
        *LEAD_BACKING_STEMS,
        DRUM_STEMS,
    ]
    models = dict.fromkeys(
        [*(stem.model for stem in stems), DEREVERB_MODEL], configuration_sha
    )
    versions = dict.fromkeys(
        (
            "STEM",
            "ASR",
            "QWEN_MODEL",
            "ALIGNMENT",
            "ALIGNMENT_MODEL",
            "STRUCTURE",
            "STRUCTURE_MODEL",
            "PITCH",
        ),
        identity,
    )
    versions.update(
        QWEN_REVISION=fixture_revision,
        STRUCTURE_REVISION=fixture_revision,
        STRUCTURE_SHA256=configuration_sha,
    )
    manifest = ProducerManifest(
        image_id=f"synthetic-cpu-fixture:{source_sha}",
        separator=RuntimeManifest(packages(SEPARATOR_PACKAGES), ffmpeg),
        asr=RuntimeManifest(
            packages(cache_versions.ASR_PACKAGES),
            ffmpeg,
            packages(cache_versions.ALIGNMENT_PACKAGES),
        ),
        structure=RuntimeManifest(
            packages(cache_versions.STRUCTURE_PACKAGES),
            ffmpeg,
            pitch_packages=packages(cache_versions.PITCH_PACKAGES),
        ),
        versions={**versions, "ASR_SAMPLE_RATE": cache_versions.ASR_SAMPLE_RATE},
        models=models,
        assets=tuple(assets),
        operation_assets=dict.fromkeys(OPERATIONS, tuple(files)),
        model_assets=dict.fromkeys(
            models, ("cpu-fixture.json", "cpu-fixture-provider.py")
        ),
    )
    save_manifest(root / "fixture-manifest.json", manifest)
    return manifest


def _pcm(source: bytes) -> bytes:
    return subprocess.run(
        [
            "ffmpeg",
            "-nostdin",
            "-v",
            "error",
            "-i",
            "pipe:0",
            "-map",
            "0:a:0",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-f",
            "f32le",
            "pipe:1",
        ],
        input=source,
        capture_output=True,
        check=True,
    ).stdout


def _pcm_identity(pcm: bytes) -> list:
    return [16000, "f", [len(pcm) // 4], hashlib.sha256(pcm).hexdigest()]


def _words(configuration: dict, duration: float) -> list[dict]:
    captured = configuration["transcript"]
    if captured is None:
        return [
            asdict(
                TranscriptWord(
                    duration / 4, duration * 3 / 4, "fixture", alignment_score=0.99
                )
            )
        ]
    return [
        {**word, "alignment_score": 0.99}
        for word in captured["words"]
        if 0 <= word["start_s"] < word["end_s"] <= duration
    ]


def _float_bytes(values: array) -> bytes:
    if sys.byteorder != "little":
        values.byteswap()
    return values.tobytes()


def cpu_inference(request: InferenceRequest, key: str, *, root: Path) -> bytes:
    """Serve one configured synthetic stage; no imports/calls to model runtimes."""
    manifest = load_manifest(root / "fixture-manifest.json")
    parameters = cast(dict[str, Any], request.parameters)
    model = parameters.get("model") if request.operation == "separation" else None
    if model is not None and not isinstance(model, str):
        raise ValueError("Fixture separation model must be a string")
    if request.producer_digest != manifest.digest_for(request.operation, model):
        raise ValueError("Request does not match this synthetic producer")
    configuration_bytes = (root / "cpu-fixture.json").read_bytes()
    if hashlib.sha256(configuration_bytes).hexdigest() != manifest.assets[0].sha256:
        raise ValueError("Fixture configuration changed after manifest capture")
    configuration = json.loads(configuration_bytes)
    if request.operation == "separation":
        stream = io.BytesIO()
        with tempfile.TemporaryDirectory(prefix="cpu-fixture-", dir=root) as directory:
            output = Path(directory) / "output.mp3"
            with zipfile.ZipFile(stream, "w") as archive:
                for item in parameters["outputs"]:
                    label = item["label"]
                    profile = configuration["signals"].get(label)
                    command = ["ffmpeg", "-nostdin", "-v", "error", "-y"]
                    if profile is None:
                        command += ["-i", "pipe:0"]
                    else:
                        command += [
                            "-f",
                            "lavfi",
                            "-i",
                            f"sine=frequency={profile['frequency_hz']}:duration={profile['duration_seconds']}:sample_rate=24000",
                        ]
                    command += [
                        "-ac",
                        "2",
                        "-codec:a",
                        "libmp3lame",
                        "-q:a",
                        "2",
                        str(output),
                    ]
                    subprocess.run(
                        command,
                        input=request.audio_bytes if profile is None else None,
                        capture_output=True,
                        check=True,
                    )
                    archive.writestr(label, output.read_bytes())
        return stream.getvalue()

    pcm = _pcm(request.audio_bytes)
    duration = len(pcm) / 4 / 16000
    if duration <= 0:
        raise ValueError("Fixture inference requires decoded audio")
    words = _words(configuration, duration)
    if request.operation == "recognition":
        chunks = []
        for start in range(0, math.ceil(duration), 25):
            end = min(start + 25, duration)
            text = " ".join(
                word["text"]
                for word in words
                if start <= (word["start_s"] + word["end_s"]) / 2 < end
            )
            chunks.append(
                asdict(RecognitionChunk(start, end, start, end, text, "English"))
            )
        return _json(
            {
                "chunks": chunks,
                "duration_s": duration,
                "pcm_identity": _pcm_identity(pcm),
            }
        )
    if request.operation == "alignment":
        if parameters["mode"] != "recognition":
            raise ValueError(
                "This fixture supplies captured ASR alignment, "
                "not reference acoustic evidence"
            )
        alignments = [
            [
                word
                for word in words
                if chunk["ownership_start_s"]
                <= (word["start_s"] + word["end_s"]) / 2
                < chunk["ownership_end_s"]
            ]
            for chunk in parameters["chunks"]
        ]
        return _json(
            {
                "alignments": alignments,
                "duration_s": duration,
                "pcm_identity": _pcm_identity(pcm),
            }
        )
    if request.operation == "structure":
        return _json(
            {
                "predictions": [{"start": 0, "end": duration, "label": "verse"}],
                "duration_s": duration,
                "structure_model": "synthetic-cpu-fixture",
            }
        )
    if request.operation == "pitch":
        count = len(pcm) // 4 // 160 + 1
        captured = configuration["pitch"]
        frequencies = array("f", [220.0 if captured is None else 0.0]) * count
        periodicities = array("f", [0.99 if captured is None else 0.0]) * count
        if captured is not None:
            tempo = captured["tempo_percent"] / 100
            shift = 2 ** (captured["pitch_shift_semitones"] / 12)
            for note in captured["tracks"][0]["notes"]:
                start = max(0, math.ceil(note["start_s"] * tempo / FRAME_SECONDS))
                end = min(count, math.ceil(note["end_s"] * tempo / FRAME_SECONDS))
                for frame in range(start, end):
                    frequencies[frame] = note["frequency_hz"] / shift
                    periodicities[frame] = note["confidence"]
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, "w") as archive:
            archive.writestr("audio.f32", pcm)
            archive.writestr("pitch.f32", _float_bytes(frequencies))
            archive.writestr("periodicity.f32", _float_bytes(periodicities))
            archive.writestr(
                "metadata.json", _json({"sample_rate": 16000, "duration_s": duration})
            )
        return stream.getvalue()
    raise ValueError(f"Unsupported fixture operation: {request.operation}")
