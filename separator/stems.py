import io
import subprocess
import time
import zipfile
from pathlib import Path
from typing import NamedTuple

from separator import cache_versions
from separator.artifact_cache import cache_key, cached_bytes, digest, locked
from separator.audio import mix_audio
from separator.options import VOCAL_STEM_LABELS, SeparationOptions


class StemOutput(NamedTuple):
    label: str
    # Case-insensitive exact match against the LAST `_(name)_` group in the output
    # filename (audio-separator appends the input basename, so the input may carry
    # earlier `_(name)_` markers from prior passes — only the trailing one identifies
    # the current stem). Substring matching is unsafe here: e.g. "male" is a substring
    # of "female". Empty string acts as a wildcard that claims any leftover output not
    # yet matched.
    keep_pattern: str


class Stem(NamedTuple):
    model: str
    outputs: list[StemOutput]  # one or more labeled outputs to keep from a single run


VOCALS_STEM = Stem("vocals_mel_band_roformer.ckpt", [StemOutput("vocals", "Vocals")])
INSTRUMENTS_STEM = Stem(
    "melband_roformer_inst_v2.ckpt", [StemOutput("instruments", "Instrumental")]
)

# The crowd model keeps the non-crowd part ("Other"). Run it on the extracted
# instruments or vocals to strip crowd noise from either.
_CROWD_MODEL = "mel_band_roformer_crowd_aufr33_viperx_sdr_8.7144.ckpt"

DECROWD_STEMS = [Stem(_CROWD_MODEL, [StemOutput("instruments-decrowded", "Other")])]

DECROWD_VOCALS_STEMS = [Stem(_CROWD_MODEL, [StemOutput("vocals-decrowded", "Other")])]

# Dereverb requested vocal outputs and mix vocal prerequisites, never separation inputs.
DEREVERB_MODEL = "dereverb_mel_band_roformer_anvuew_sdr_19.1729.ckpt"

# Run on the raw vocals to split male/female; keep both stems.
GENDER_STEMS = [
    Stem(
        "model_chorus_bs_roformer_ep_267_sdr_24.1275.ckpt",
        [
            StemOutput("vocals-male", "Male"),
            StemOutput("vocals-female", "Female"),
        ],
    ),
]

# Split raw vocals into lead + backing using the gabox v2 karaoke model.
LEAD_BACKING_STEMS = [
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
        StemOutput("other-instruments", "Other"),
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


def _stem_identity(source_digest: str, stem: Stem) -> tuple[object, ...]:
    return (
        cache_versions.STEM,
        cache_versions.package_revision("audio-separator"),
        cache_versions.environment_revisions(
            None, ("torch", "onnxruntime-gpu", "librosa")
        ),
        cache_versions.binary_revision("ffmpeg"),
        stem.model,
        stem.outputs,
        source_digest,
    )


def cached_pitch_vocals(
    audio_bytes: bytes, model_cache: str, stem_cache: str
) -> bytes | None:
    """Read the exact validated full-vocal cache only; never run a producer."""
    model_path = Path(model_cache) / VOCALS_STEM.model
    if not model_path.is_file():
        return None
    key = cache_key(
        *_stem_identity(digest(audio_bytes), VOCALS_STEM),
        cache_versions.file_revision(model_path),
    )
    path = Path(stem_cache) / "versioned" / "outputs" / f"{key}.bin"
    if not path.is_file():
        return None
    with zipfile.ZipFile(path) as archive:
        vocals = archive.read("vocals")
    if not vocals:
        raise ValueError("Cached full vocals are empty")
    return vocals


def run_separator(
    input_path: Path,
    stem: Stem,
    out_dir: Path,
    model_cache: str,
    stem_cache: str,
) -> dict[str, tuple[StemResult, Path]]:
    root = Path(stem_cache) / "versioned"
    model_path = Path(model_cache) / stem.model
    identity = _stem_identity(digest(input_path.read_bytes()), stem)
    # Serializing by source/model also covers the first model download. Old
    # unversioned directories are not trusted as current algorithm results.
    duration = 0.0
    with locked(root / f"{cache_key(*identity)}.lock"):

        def produce() -> bytes:
            nonlocal duration
            result = _run_separator(input_path, stem, out_dir, model_cache)
            duration = next(iter(result.values()))[0].duration_s
            stream = io.BytesIO()
            with zipfile.ZipFile(stream, "w") as archive:
                for label, (audio, _) in result.items():
                    if not audio.data:
                        raise RuntimeError("Separator produced an empty stem")
                    archive.writestr(label, audio.data)
            return stream.getvalue()

        def model_key() -> str:
            return cache_key(*identity, cache_versions.file_revision(model_path))

        if model_path.is_file():
            data = cached_bytes(root / "outputs", model_key(), produce)
        else:
            data = produce()
            if model_path.is_file():
                data = cached_bytes(root / "outputs", model_key(), lambda: data)
    out_dir.mkdir(parents=True, exist_ok=True)
    result = {}
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        for output in stem.outputs:
            audio = archive.read(output.label)
            path = out_dir / f"{output.label}.mp3"
            path.write_bytes(audio)
            result[output.label] = StemResult(audio, duration), path
    return result


def _run_separator(
    input_path: Path,
    stem: Stem,
    out_dir: Path,
    model_cache: str,
) -> dict[str, tuple[StemResult, Path]]:
    out_dir.mkdir(parents=True, exist_ok=True)
    start = time.monotonic()
    subprocess.run(
        [
            "audio-separator",
            str(input_path),
            "--model_filename",
            stem.model,
            "--output_format",
            "MP3",
            "--output_dir",
            str(out_dir),
            "--model_file_dir",
            model_cache,
        ],
        check=True,
    )
    duration = time.monotonic() - start

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
                matched[output.label] = (
                    StemResult(data=path.read_bytes(), duration_s=duration),
                    path,
                )
                used.add(path)
                break
        else:
            raise RuntimeError(
                f"no output matching {output.keep_pattern!r} in {out_dir}"
            )
    return matched


def run_separation(
    input_path: Path,
    options: SeparationOptions,
    tmp_dir: Path,
    model_cache: str,
    stem_cache: str,
) -> SeparationResult:
    """Run the stem graph, retaining internal vocals for lyrics/pitch analysis.

    Public audio outputs are filtered by run_processing; this prerequisite must
    not change selected outputs or add dereverb passes.
    """
    requested = options.output_labels
    if not requested and not options.needs_lyrics and not options.needs_pitch:
        return {}
    results: SeparationResult = {}
    paths: dict[str, Path] = {}

    def run(stems: list[Stem], source: Path, suffix: str = "") -> None:
        for stem in stems:
            out_dir = tmp_dir / f"{stem.model}{suffix}"
            for label, (result, path) in run_separator(
                source, stem, out_dir, model_cache, stem_cache
            ).items():
                results[label] = result
                paths[label] = path

    components = options.mix_components
    needs_vocals = bool(
        options.extract_vocals
        or options.needs_lyrics
        or options.needs_pitch
        or options.decrowd_vocals
        or options.genders
        or options.lead_backing
        or components.intersection({"vocals", "female", "male", "lead", "backing"})
        or "vocals-dry" in requested
    )
    if needs_vocals:
        run([VOCALS_STEM], input_path)
        vocal_source = "vocals"
        if options.decrowd_vocals:
            run(DECROWD_VOCALS_STEMS, paths[vocal_source], suffix="-vocals")
            vocal_source = "vocals-decrowded"
        if options.genders or components.intersection({"female", "male"}):
            run(GENDER_STEMS, paths[vocal_source])
        if options.lead_backing or components.intersection({"lead", "backing"}):
            run(LEAD_BACKING_STEMS, paths[vocal_source])
        dry_sources = [
            label.removesuffix("-dry")
            for label in requested
            if label.endswith("-dry")
            and label.removesuffix("-dry") in VOCAL_STEM_LABELS
        ]
        if options.dereverb:
            dry_sources.extend(
                options.component_label(component).removesuffix("-dry")
                for component in components
                if component in {"vocals", "female", "male", "lead", "backing"}
            )
        for label in dict.fromkeys(dry_sources):
            stem = Stem(DEREVERB_MODEL, [StemOutput(f"{label}-dry", "noreverb")])
            run([stem], paths[label], suffix=f"-{label}")

    needs_drums = options.drums or bool(
        components.intersection({"drums", "bass", "other"})
    )
    if (
        options.extract_instruments
        or options.decrowd
        or needs_drums
        or "instruments" in components
    ):
        run([INSTRUMENTS_STEM], input_path)
        if options.decrowd:
            run(DECROWD_STEMS, paths["instruments"], suffix="-instruments")
        if needs_drums:
            source = "instruments-decrowded" if options.decrowd else "instruments"
            run([DRUM_STEMS], paths[source])

    for mix in options.mixes:
        output = tmp_dir / f"{mix.id}.mp3"
        start = time.monotonic()
        inputs = [paths[options.component_label(part)] for part in mix.components]

        def produce_mix(inputs=inputs, output=output) -> bytes:
            mix_audio(inputs, output)
            return output.read_bytes()

        audio = cached_bytes(
            Path(stem_cache) / "mixes",
            cache_key(
                cache_versions.MIX,
                cache_versions.binary_revision("ffmpeg"),
                sorted(digest(path.read_bytes()) for path in inputs),
            ),
            produce_mix,
        )
        output.write_bytes(audio)
        results[mix.id] = StemResult(audio, time.monotonic() - start)
    if (options.needs_lyrics or options.detect_pitch) and "vocals" not in requested:
        requested.append("vocals")
    requested.extend(label for label in options.pitch_labels if label not in requested)
    return {label: results[label] for label in requested}
