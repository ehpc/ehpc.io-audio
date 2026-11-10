"""Source-clock orchestration and persistent artifact lookup on the VPS."""

import io
import json
import math
import time
import zipfile
from collections.abc import Callable
from dataclasses import asdict, dataclass, replace
from pathlib import Path
from typing import cast

from separator import cache_versions
from separator.artifact_cache import (
    atomic_write,
    cache_key,
    cached_bytes,
    digest,
    locked,
    sync_file,
)
from separator.inference import InferenceRequest, JSONValue, Operation
from separator.lyrics import (
    RecognitionChunk,
    Transcript,
    TranscriptSection,
    TranscriptWord,
    recognition_transcript,
    transcript_from_json,
)
from separator.lyrics_reference import (
    AcousticEvidence,
    ReferenceMetadata,
    apply_reference,
    lookup_reference,
    plan_reference,
    reuse_exact_asr_candidates,
)
from separator.options import SeparationOptions
from separator.pitch import (
    PitchAnalysis,
    PitchTrack,
    assemble_pitch_prediction,
    pitch_from_json,
    pitch_to_json,
    transform_analysis,
)
from separator.producer_manifest import ProducerManifest, load_manifest
from separator.stems import (
    VOCALS_STEM,
    SeparationResult,
    Stem,
    StemResult,
    run_separation,
)
from separator.structure import assemble_structure


@dataclass
class ProcessingResult:
    audio: SeparationResult
    transcript: Transcript | None = None
    pitch_json: str | None = None
    pitch_vocals: bytes | None = None


InferenceProducer = Callable[[InferenceRequest, str], bytes]


def _json(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, allow_nan=False).encode()


def _parameters(value: object) -> dict[str, JSONValue]:
    return cast(dict[str, JSONValue], json.loads(_json(value)))


def _stem_archive(data: bytes, stem: Stem) -> dict[str, bytes]:
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        expected = {output.label for output in stem.outputs}
        if set(archive.namelist()) != expected:
            raise ValueError("Inference returned unexpected stem outputs")
        result = {label: archive.read(label) for label in expected}
    if not all(result.values()):
        raise ValueError("Inference returned an empty stem")
    return result


def legacy_stem_key(manifest: ProducerManifest, source: bytes, stem: Stem) -> str:
    runtime = manifest.separator
    manifest.operation_identity("separation", stem.model)
    return cache_key(
        manifest.versions["STEM"],
        runtime.packages["audio-separator"],
        {
            name: runtime.packages[name]
            for name in ("torch", "onnxruntime-gpu", "librosa")
        },
        runtime.ffmpeg,
        stem.model,
        stem.outputs,
        digest(source),
        manifest.models[stem.model],
    )


def _legacy_path(
    root: Path,
    manifest: ProducerManifest,
    operation: Operation,
    path: Path,
    model: str | None = None,
) -> Path | None:
    if not path.is_file():
        return None
    provenance = root / "legacy-producer-manifest.json"
    if not provenance.is_file():
        raise RuntimeError("Legacy artifacts require their verified producer manifest")
    previous = load_manifest(provenance)
    if previous.operation_identity(operation, model) != manifest.operation_identity(
        operation, model
    ):
        return None
    return path


@dataclass
class ProcessingContext:
    root: Path
    manifest: ProducerManifest
    infer: InferenceProducer
    on_committed: Callable[[str, Path], None] | None = None

    def key(
        self, operation: Operation, identity: object, model: str | None = None
    ) -> str:
        return cache_key(
            operation, self.manifest.operation_identity(operation, model), identity
        )

    def stage[T](
        self,
        operation: Operation,
        source: bytes,
        filename: str,
        parameters: dict[str, JSONValue],
        identity: object,
        validate: Callable[[bytes], T],
        *,
        model: str | None = None,
        legacy: Path | None = None,
    ) -> T:
        key = self.key(operation, identity, model)
        request = InferenceRequest(
            operation,
            source,
            filename,
            self.manifest.digest_for(operation, model),
            parameters,
        )

        value: T | None = None
        produced = False

        def produce() -> bytes:
            nonlocal value, produced
            candidate = (
                _legacy_path(self.root, self.manifest, operation, legacy, model)
                if legacy is not None
                else None
            )
            data = (
                candidate.read_bytes()
                if candidate is not None
                else self.infer(request, key)
            )
            value = validate(data)
            produced = True
            return data

        data = cached_bytes(self.root / "inference", key, produce)
        result = cast(T, value) if produced else validate(data)
        if self.on_committed is not None:
            artifact = self.root / "inference" / f"{key}.bin"
            sync_file(artifact)
            self.on_committed(key, artifact)
        return result

    def separate(
        self, source: Path, stem: Stem, directory: Path
    ) -> dict[str, tuple[StemResult, Path]]:
        data = source.read_bytes()
        parameters = _parameters(
            {
                "model": stem.model,
                "outputs": [asdict_output(output) for output in stem.outputs],
            }
        )
        started = time.monotonic()
        archive = self.stage(
            "separation",
            data,
            source.name,
            parameters,
            [digest(data), parameters],
            lambda value: _stem_archive(value, stem),
            model=stem.model,
            legacy=self.root
            / "stems"
            / "versioned"
            / "outputs"
            / f"{legacy_stem_key(self.manifest, data, stem)}.bin",
        )
        elapsed = time.monotonic() - started
        directory.mkdir(parents=True, exist_ok=True)
        result = {}
        for label, audio in archive.items():
            path = directory / f"{label}.mp3"
            path.write_bytes(audio)
            result[label] = StemResult(audio, elapsed), path
        return result


def asdict_output(output) -> dict[str, str]:
    return {"label": output.label, "keep_pattern": output.keep_pattern}


def cached_pitch_vocals(
    source: bytes, root: Path, manifest: ProducerManifest
) -> bytes | None:
    """Read exact private artifacts only: never allocate a GPU or run a model."""
    parameters = {
        "model": VOCALS_STEM.model,
        "outputs": [asdict_output(output) for output in VOCALS_STEM.outputs],
    }
    key = cache_key(
        "separation",
        manifest.operation_identity("separation", VOCALS_STEM.model),
        [digest(source), parameters],
    )
    current = root / "inference" / f"{key}.bin"
    if current.is_file():
        return _stem_archive(current.read_bytes(), VOCALS_STEM)["vocals"]
    legacy = _legacy_path(
        root,
        manifest,
        "separation",
        root
        / "stems"
        / "versioned"
        / "outputs"
        / f"{legacy_stem_key(manifest, source, VOCALS_STEM)}.bin",
        VOCALS_STEM.model,
    )
    return (
        _stem_archive(legacy.read_bytes(), VOCALS_STEM)["vocals"]
        if legacy is not None
        else None
    )


def _recognition_result(data: bytes) -> dict:
    value = json.loads(data)
    chunks = value["chunks"]
    pcm = value["pcm_identity"]
    duration = value["duration_s"]
    if not isinstance(chunks, list) or not math.isfinite(duration) or duration <= 0:
        raise ValueError("Invalid recognition result")
    if (
        not isinstance(pcm, list)
        or len(pcm) != 4
        or pcm[0] != cache_versions.ASR_SAMPLE_RATE
        or pcm[1] != "f"
        or not isinstance(pcm[2], list)
        or len(pcm[2]) != 1
        or type(pcm[2][0]) is not int
        or pcm[2][0] <= 0
        or not isinstance(pcm[3], str)
        or len(pcm[3]) != 64
        or any(character not in "0123456789abcdef" for character in pcm[3])
        or not math.isclose(pcm[2][0] / pcm[0], duration, rel_tol=0, abs_tol=1 / pcm[0])
    ):
        raise ValueError("Invalid decoded source provenance")
    for item in chunks:
        chunk = RecognitionChunk(**item)
        times = (
            chunk.input_start_s,
            chunk.input_end_s,
            chunk.ownership_start_s,
            chunk.ownership_end_s,
        )
        if (
            not all(math.isfinite(time) for time in times)
            or not 0 <= chunk.input_start_s < chunk.input_end_s <= duration
            or not chunk.input_start_s
            <= chunk.ownership_start_s
            < chunk.ownership_end_s
            <= chunk.input_end_s
            or not isinstance(chunk.text, str)
            or not isinstance(chunk.language, str)
        ):
            raise ValueError("Invalid recognition window")
    return value


def _baseline_result(data: bytes, pcm: list, chunk_count: int) -> dict:
    value = json.loads(data)
    if "transcript" in value:
        transcript_from_json(json.dumps(value["transcript"]))
        for word in value["evidence"]:
            TranscriptWord(**word)
        return value
    if value["pcm_identity"] != pcm or len(value["alignments"]) != chunk_count:
        raise ValueError("Alignment does not match the decoded recognition context")
    for alignment in value["alignments"]:
        for word in alignment:
            TranscriptWord(**word)
    return value


def _legacy_recognition_info(
    source: bytes,
    raw: bytes,
    raw_key: str,
    context: ProcessingContext,
) -> dict:
    """Verify decoded PCM against the original baseline key before migration."""
    path = context.root / "recognition-info" / f"{raw_key}.json"
    with locked(path.with_suffix(".lock")):
        if path.is_file():
            return json.loads(path.read_bytes())
        # These CPU-only dependencies reproduce librosa's soundfile/soxr
        # 16-kHz mono decoding. A different result cannot pass the legacy key.
        import numpy as np  # noqa: PLC0415
        import soundfile as sf  # noqa: PLC0415
        import soxr  # noqa: PLC0415

        audio, sample_rate = sf.read(io.BytesIO(source), dtype="float32")
        if audio.ndim == 2:
            audio = np.mean(audio, axis=1, dtype=np.float32)
        if sample_rate != cache_versions.ASR_SAMPLE_RATE:
            sample_count = math.ceil(
                len(audio) * cache_versions.ASR_SAMPLE_RATE / sample_rate
            )
            audio = soxr.resample(
                audio, sample_rate, cache_versions.ASR_SAMPLE_RATE, quality="HQ"
            )
            if len(audio) < sample_count:
                audio = np.pad(audio, (0, sample_count - len(audio)))
            audio = audio[:sample_count]
        pcm = memoryview(audio)
        identity = [
            cache_versions.ASR_SAMPLE_RATE,
            pcm.format,
            [len(audio)],
            digest(pcm),
        ]
        chunks = json.loads(raw)
        info = {
            "duration_s": len(audio) / cache_versions.ASR_SAMPLE_RATE,
            "pcm_identity": identity,
        }
        _recognition_result(_json({**info, "chunks": chunks}))
        manifest = context.manifest
        baseline_key = cache_key(
            manifest.versions["ALIGNMENT"],
            manifest.versions["ALIGNMENT_MODEL"],
            identity,
            digest(json.dumps(chunks).encode()),
            dict(manifest.asr.alignment_packages),
        )
        baseline = _legacy_path(
            context.root,
            manifest,
            "alignment",
            context.root
            / "qwen-asr"
            / "results"
            / "recognition-alignment"
            / f"{baseline_key}.bin",
        )
        if baseline is None:
            raise RuntimeError(
                "Legacy recognition PCM does not match a verified cached baseline"
            )
        value = _baseline_result(baseline.read_bytes(), identity, len(chunks))
        if "transcript" in value:
            baseline_transcript = transcript_from_json(json.dumps(value["transcript"]))
            if [
                asdict(chunk) for chunk in baseline_transcript.recognition_chunks
            ] != chunks:
                raise ValueError(
                    "Legacy baseline recognition does not match its source"
                )
        atomic_write(path, _json(info))
        return info


def _reference_result(data: bytes) -> dict:
    value = json.loads(data)
    for words in value["aligned_lines"].values():
        for word in words:
            TranscriptWord(**word)
    for evidence in value["acoustic_evidence"].values():
        AcousticEvidence(**evidence)
    return value


def _structure_result(data: bytes) -> dict:
    value = json.loads(data)
    if "predictions" in value:
        return asdict(assemble_structure(**value))
    if not value["sections"] or not isinstance(value["structure_model"], str):
        raise ValueError("Invalid musical structure result")
    for section in value["sections"]:
        TranscriptSection(**section)
    return value


def _pitch_result(data: bytes) -> PitchAnalysis:
    value = (
        assemble_pitch_prediction(data)
        if data.startswith(b"PK")
        else pitch_from_json(data.decode())
    )
    if len(value.tracks) != 1:
        raise ValueError("Pitch producer must return one source track")
    return value


def transcribe_source(
    source: bytes,
    context: ProcessingContext,
    reference_metadata: ReferenceMetadata | None,
) -> Transcript:
    review = lookup_reference(
        reference_metadata, context.root / "lyrics-references"
    ).review
    reference_identity = asdict(review)
    for field in ("fetched_at", "cached", "reason"):
        reference_identity.pop(field, None)
    key = cache_key(
        context.manifest.operation_identity("recognition"),
        context.manifest.operation_identity("alignment"),
        digest(source),
        reference_identity,
        *([cache_versions.REFERENCE_POLICY] if review.lines else []),
    )
    data = cached_bytes(
        context.root / "transcripts",
        key,
        lambda: _json(
            asdict(_transcribe_source(source, context, review, reference_identity))
        ),
    )
    return transcript_from_json(data.decode())


def _transcribe_source(
    source: bytes, context: ProcessingContext, review, reference_identity: dict
) -> Transcript:
    manifest = context.manifest
    legacy_key = cache_key(
        manifest.versions["ASR"],
        manifest.versions["QWEN_REVISION"],
        manifest.asr.ffmpeg,
        dict(manifest.asr.packages),
        dict(manifest.asr.alignment_packages),
        manifest.versions["ALIGNMENT"],
        digest(source),
        reference_identity,
    )
    legacy = context.root / "analysis-results" / "lyrics" / f"{legacy_key}.bin"
    if (
        not review.lines
        and _legacy_path(context.root, manifest, "recognition", legacy) is not None
        and _legacy_path(context.root, manifest, "alignment", legacy) is not None
    ):
        return transcript_from_json(legacy.read_text())
    raw_key = cache_key(
        manifest.versions["ASR"],
        manifest.versions["QWEN_REVISION"],
        digest(source),
        manifest.asr.ffmpeg,
        dict(manifest.asr.packages),
    )
    old_raw = context.root / "qwen-asr" / "results" / "recognition" / f"{raw_key}.bin"
    if _legacy_path(context.root, manifest, "recognition", old_raw) is not None:
        raw = old_raw.read_bytes()
        info = _legacy_recognition_info(source, raw, raw_key, context)
        recognition = _recognition_result(_json({**info, "chunks": json.loads(raw)}))
    else:
        recognition = context.stage(
            "recognition", source, "vocals.mp3", {}, digest(source), _recognition_result
        )
    chunks = recognition["chunks"]
    raw = json.dumps(chunks).encode()
    pcm = recognition["pcm_identity"]
    baseline_key = cache_key(
        manifest.versions["ALIGNMENT"],
        manifest.versions["ALIGNMENT_MODEL"],
        pcm,
        digest(raw),
        dict(manifest.asr.alignment_packages),
    )
    baseline = context.stage(
        "alignment",
        source,
        "vocals.mp3",
        _parameters({"mode": "recognition", "chunks": chunks}),
        ["recognition", pcm, digest(raw)],
        lambda data: _baseline_result(data, pcm, len(chunks)),
        legacy=context.root
        / "qwen-asr"
        / "results"
        / "recognition-alignment"
        / f"{baseline_key}.bin",
    )
    if "transcript" in baseline:
        transcript = transcript_from_json(json.dumps(baseline["transcript"]))
        evidence = [TranscriptWord(**word) for word in baseline["evidence"]]
    else:
        recognized = [RecognitionChunk(**chunk) for chunk in chunks]
        alignments = [
            [TranscriptWord(**word) for word in alignment]
            for alignment in baseline["alignments"]
        ]
        transcript = recognition_transcript(
            recognized,
            alignments,
            str(manifest.versions["QWEN_MODEL"]),
            str(manifest.versions["ALIGNMENT_MODEL"]),
            0.03,
        )
        evidence = [
            word
            for chunk, alignment in zip(recognized, alignments, strict=True)
            for word in alignment
            if chunk.ownership_start_s
            <= (word.start_s + word.end_s) / 2
            < chunk.ownership_end_s
        ]
    review = replace(
        review,
        original_segments=transcript.segments,
        original_words=transcript.words,
        original_untimed=transcript.untimed,
    )
    if not review.lines:
        return replace(transcript, reference=review)
    review, phrases = plan_reference(
        transcript, review, recognition["duration_s"], evidence
    )
    request_review = asdict(
        replace(
            review,
            reason="",
            fetched_at=None,
            cached=False,
            original_segments=[],
            original_words=[],
            original_untimed=[],
        )
    )
    parameters = _parameters(
        {
            "mode": "reference",
            "review": request_review,
            "phrases": [asdict(phrase) for phrase in phrases],
        }
    )
    if phrases:
        aligned = context.stage(
            "alignment",
            source,
            "vocals.mp3",
            parameters,
            [pcm, parameters],
            _reference_result,
        )
        candidates = {
            int(index): [TranscriptWord(**word) for word in words]
            for index, words in aligned["aligned_lines"].items()
        }
        acoustic_evidence = {
            int(index): AcousticEvidence(**value)
            for index, value in aligned["acoustic_evidence"].items()
        }
    else:
        candidates = {}
        acoustic_evidence = {}
    candidates, reused = reuse_exact_asr_candidates(
        transcript, review, candidates, evidence
    )
    return apply_reference(
        transcript, review, candidates, acoustic_evidence, asr_reused=reused
    )


def run_processing(
    input_path: Path,
    options: SeparationOptions,
    tmp: Path,
    context: ProcessingContext,
    reference_metadata: ReferenceMetadata | None = None,
) -> ProcessingResult:
    stems = run_separation(
        input_path, options, tmp, context.root / "stems", context.separate
    )
    manifest = context.manifest
    transcript = None
    if options.needs_lyrics:
        transcript = transcribe_source(
            stems["vocals"].data, context, reference_metadata
        )
        source = input_path.read_bytes()
        structure_key = cache_key(
            manifest.versions["STRUCTURE"],
            manifest.versions["STRUCTURE_MODEL"],
            manifest.versions["STRUCTURE_REVISION"],
            manifest.versions["STRUCTURE_SHA256"],
            manifest.structure.ffmpeg,
            dict(manifest.structure.packages),
            digest(source),
        )
        structure = context.stage(
            "structure",
            source,
            input_path.name,
            {},
            digest(source),
            _structure_result,
            legacy=context.root
            / "analysis-results"
            / "structure"
            / f"{structure_key}.bin",
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
            source = stems[label].data
            pitch_key = cache_key(
                manifest.versions["PITCH"],
                manifest.structure.ffmpeg,
                dict(manifest.structure.pitch_packages),
                digest(source),
            )
            analysis = context.stage(
                "pitch",
                source,
                "vocals.mp3",
                {},
                digest(source),
                _pitch_result,
                legacy=context.root / "analysis-results" / "pitch" / f"{pitch_key}.bin",
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
        pitch_vocals=stems["vocals"].data
        if options.detect_pitch and "vocals" not in options.output_labels
        else None,
    )
