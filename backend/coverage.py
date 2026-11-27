"""Producer identities for independently reusable public song outputs."""

from dataclasses import replace

from backend import config
from separator import cache_versions
from separator.artifact_cache import cache_key
from separator.options import MIX_COMPONENTS, SeparationOptions
from separator.producer_manifest import load_manifest
from separator.stems import (
    DECROWD_STEMS,
    DEREVERB_MODEL,
    DRUM_STEMS,
    GENDER_STEMS,
    INSTRUMENTS_STEM,
    LEAD_BACKING_STEMS,
    VOCALS_STEM,
)


def output_identity(label: str, options: SeparationOptions) -> str:
    mix = next((mix for mix in options.mixes if mix.id == label), None)
    components = (
        mix.components
        if mix
        else ("drums", "vocals")
        if label == "drums-vocals"
        else None
    )
    if components is not None:
        parts = sorted(
            _component_identity(component, options) for component in components
        )
        return "mix:" + ",".join(parts)
    return _stem_identity(label, options)


def output_display_name(label: str, options: SeparationOptions) -> str:
    mix = next((mix for mix in options.mixes if mix.id == label), None)
    components = (
        mix.components
        if mix
        else ("drums", "vocals")
        if label == "drums-vocals"
        else None
    )
    name = options.display_name(label)
    if mix:
        name += (
            " ("
            + " + ".join(MIX_COMPONENTS[component] for component in mix.components)
            + ")"
        )
    if components:
        cleaned = []
        if options.decrowd and set(components).intersection(
            {"drums", "bass", "other", "instruments"}
        ):
            cleaned.append("instruments")
        if options.decrowd_vocals and set(components).intersection(
            {"vocals", "female", "male", "lead", "backing"}
        ):
            cleaned.append("vocals")
        if cleaned:
            name += " (crowd removed: " + ", ".join(cleaned) + ")"
        if options.dereverb and set(components).intersection(
            {"vocals", "female", "male", "lead", "backing"}
        ):
            name += " (reverb removed: vocals)"
    elif _stem_identity(label, options) != label:
        name += " (crowd removed)"
    return name


def _stem_identity(label: str, options: SeparationOptions) -> str:
    if options.decrowd and label in {"drums", "bass", "other-instruments"}:
        return label + ":decrowded"
    base = label.removesuffix("-dry")
    if options.decrowd_vocals and base in {
        "vocals-male",
        "vocals-female",
        "lead",
        "backing",
    }:
        return label + ":decrowded"
    return label


def _component_identity(component: str, options: SeparationOptions) -> str:
    return _stem_identity(options.component_label(component), options)


def _stem_models(label: str, options: SeparationOptions) -> set[str]:
    if label == "song":
        return set()
    dry = label.endswith("-dry")
    label = label.removesuffix("-dry")
    if label in {
        "instruments",
        "instruments-decrowded",
        "drums",
        "bass",
        "other-instruments",
    }:
        models = {INSTRUMENTS_STEM.model}
        if label == "instruments-decrowded" or (
            options.decrowd and label in {"drums", "bass", "other-instruments"}
        ):
            models.add(DECROWD_STEMS[0].model)
        if label in {"drums", "bass", "other-instruments"}:
            models.add(DRUM_STEMS.model)
        return models
    models = {VOCALS_STEM.model}
    if label == "vocals-decrowded" or (
        options.decrowd_vocals
        and label in {"vocals-male", "vocals-female", "lead", "backing"}
    ):
        models.add(DECROWD_STEMS[0].model)
    if label in {"vocals-male", "vocals-female"}:
        models.add(GENDER_STEMS[0].model)
    if label in {"lead", "backing"}:
        models.add(LEAD_BACKING_STEMS[0].model)
    if dry:
        models.add(DEREVERB_MODEL)
    return models


def signatures(options: SeparationOptions) -> dict[str, str]:
    """Compute identities from the same producer versions used by the artifact DAG.

    Failure to read a producer is deliberately reported to the caller: unknown
    provenance must never be treated as evidence that an export is current.
    """
    if (
        not options.result_labels
        and not options.needs_lyrics
        and not options.needs_pitch
    ):
        return {}
    manifest = None

    def producer():
        nonlocal manifest
        if manifest is None:
            manifest = load_manifest(config.PRODUCER_MANIFEST)
        return manifest

    identities = {}
    transform = None
    if options.pitch_semitones != 0 or options.tempo_percent != 100:
        transform = [
            cache_versions.TRANSFORM,
            cache_versions.binary_revision("ffmpeg"),
            cache_versions.binary_revision("rubberband"),
            options.pitch_semitones,
            options.tempo_percent,
        ]

    def stems(labels):
        models = set()
        for label in labels:
            models.update(_stem_models(label, options))
        return [
            producer().operation_identity("separation", model)
            for model in sorted(models)
        ]

    for label in options.result_labels:
        mix = next((mix for mix in options.mixes if mix.id == label), None)
        components = (
            mix.components
            if mix
            else ("drums", "vocals")
            if label == "drums-vocals"
            else None
        )
        labels = (
            [options.component_label(component) for component in components]
            if components
            else [label]
        )
        mixer = (
            [cache_versions.MIX, cache_versions.binary_revision("ffmpeg")]
            if components
            else None
        )
        identities["audio:" + output_identity(label, options)] = cache_key(
            stems(labels), mixer, transform
        )
    if options.needs_lyrics:
        identities["lyrics"] = cache_key(
            stems(["vocals"]),
            producer().operation_identity("recognition"),
            producer().operation_identity("alignment"),
            producer().operation_identity("structure"),
            cache_versions.REFERENCE_POLICY,
        )
    if options.needs_pitch:
        identities["pitch"] = cache_key(
            stems(options.pitch_labels),
            producer().operation_identity("pitch"),
            options.pitch_labels,
            options.pitch_semitones,
            options.tempo_percent,
        )
    if options.needs_lyrics and options.needs_pitch:
        identities["pitched_lyrics"] = cache_key(
            identities["lyrics"], identities["pitch"]
        )
    return identities


def known_signatures(options: SeparationOptions) -> dict[str, str] | None:
    try:
        return signatures(options)
    except (OSError, RuntimeError, ValueError, KeyError, TypeError):
        return None


def enrich_options(options: SeparationOptions, detail) -> SeparationOptions:
    variant = next(
        (
            item
            for item in detail.variants
            if item.pitch_semitones == options.pitch_semitones
            and item.tempo_percent == options.tempo_percent
        ),
        None,
    )
    if variant is None:
        return options
    return replace(
        options,
        detect_pitch=options.detect_pitch
        or bool(
            options.needs_lyrics and not options.needs_pitch and variant.karaoke_work_id
        ),
        extract_lyrics=options.extract_lyrics
        or bool(
            options.detect_pitch and not options.needs_lyrics and variant.lyrics_work_id
        ),
    )


def missing_options(options: SeparationOptions, missing: set[str]) -> SeparationOptions:
    """Drop fully covered explicit exports without changing pitch-track planning."""
    if options.needs_pitch or options.dereverb:
        return options

    def needed(label: str) -> bool:
        return "audio:" + output_identity(label, options) in missing

    vocals = options.extract_vocals and (
        needed("vocals") or (options.dereverb and needed("vocals-dry"))
    )
    instruments = options.extract_instruments and needed("instruments")
    drums = options.drums and any(
        needed(label) for label in ("drums", "bass", "other-instruments")
    )
    mixes = tuple(mix for mix in options.mixes if needed(mix.id))
    return replace(
        options,
        extract_vocals=vocals,
        extract_instruments=instruments,
        drums=drums,
        mixes=mixes,
    )
