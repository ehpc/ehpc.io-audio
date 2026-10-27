import hashlib
import shutil
import subprocess
import time
from pathlib import Path
from typing import NamedTuple

from separator.audio import mix_audio
from separator.options import SeparationOptions


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


def run_separator(
    input_path: Path,
    stem: Stem,
    out_dir: Path,
    model_cache: str,
    stem_cache: str,
    use_cache: bool = True,
) -> dict[str, tuple[StemResult, Path]]:
    out_dir.mkdir(parents=True)
    cache_dir = (
        Path(stem_cache)
        / hashlib.sha256(input_path.read_bytes()).hexdigest()
        / stem.model
    )

    if use_cache and cache_dir.is_dir():
        for src in cache_dir.glob("*.mp3"):
            shutil.copy(src, out_dir / src.name)
        duration = 0.0
    else:
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
    requested = options.output_labels
    if not requested:
        return {}
    use_cache = not options.no_cache
    results: SeparationResult = {}
    paths: dict[str, Path] = {}

    def run(stems: list[Stem], source: Path, suffix: str = "") -> None:
        for stem in stems:
            out_dir = tmp_dir / f"{stem.model}{suffix}"
            for label, (result, path) in run_separator(
                source, stem, out_dir, model_cache, stem_cache, use_cache=use_cache
            ).items():
                results[label] = result
                paths[label] = path

    mixes = [
        (label, vocal)
        for selected, label, vocal in (
            (options.mix_female_instruments, "female-instruments", "vocals-female"),
            (options.mix_male_instruments, "male-instruments", "vocals-male"),
            (options.mix_backing_instruments, "backing-instruments", "backing"),
            (options.mix_lead_instruments, "lead-instruments", "lead"),
        )
        if selected
    ]
    needs_vocals = bool(
        options.extract_vocals
        or options.decrowd_vocals
        or options.genders
        or options.lead_backing
        or mixes
        or "vocals-dry" in requested
    )
    if needs_vocals:
        run([VOCALS_STEM], input_path)
        vocal_source = "vocals"
        if options.decrowd_vocals:
            run(DECROWD_VOCALS_STEMS, paths[vocal_source], suffix="-vocals")
            vocal_source = "vocals-decrowded"
        if (
            options.genders
            or options.mix_female_instruments
            or options.mix_male_instruments
        ):
            run(GENDER_STEMS, paths[vocal_source])
        if (
            options.lead_backing
            or options.mix_backing_instruments
            or options.mix_lead_instruments
        ):
            run(LEAD_BACKING_STEMS, paths[vocal_source])
        dry_sources = [
            label.removesuffix("-dry") for label in requested if label.endswith("-dry")
        ]
        if options.dereverb:
            dry_sources.extend(vocal for _, vocal in mixes)
        for label in dict.fromkeys(dry_sources):
            stem = Stem(DEREVERB_MODEL, [StemOutput(f"{label}-dry", "noreverb")])
            run([stem], paths[label], suffix=f"-{label}")

    if options.extract_instruments or options.decrowd or options.drums or mixes:
        run([INSTRUMENTS_STEM], input_path)
        if options.decrowd:
            run(DECROWD_STEMS, paths["instruments"], suffix="-instruments")
        if options.drums:
            run([DRUM_STEMS], paths["instruments"])

    for label, vocal in mixes:
        instrumental = "instruments-decrowded" if options.decrowd else "instruments"
        if options.dereverb:
            vocal += "-dry"
        output = tmp_dir / f"{label}.mp3"
        start = time.monotonic()
        mix_audio(paths[vocal], paths[instrumental], output)
        results[label] = StemResult(output.read_bytes(), time.monotonic() - start)
    return {label: results[label] for label in requested}
