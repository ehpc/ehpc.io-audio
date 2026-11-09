import re
from dataclasses import dataclass
from math import isfinite

OPTIONS_SCHEMA_VERSION = 3

MIX_COMPONENTS: dict[str, str] = {
    "drums": "Drums",
    "bass": "Bass",
    "vocals": "Vocals",
    "other": "Other instruments",
    "instruments": "Instruments",
    "female": "Female vocals",
    "male": "Male vocals",
    "lead": "Lead vocals",
    "backing": "Backing vocals",
}

VOCAL_STEM_LABELS = frozenset(
    {"vocals", "vocals-decrowded", "vocals-male", "vocals-female", "lead", "backing"}
)


@dataclass(frozen=True)
class MixSpec:
    """Stable identity is independent of editable, potentially duplicate names."""

    id: str
    name: str
    components: tuple[str, ...]

    def __post_init__(self) -> None:
        if not isinstance(self.id, str) or not re.fullmatch(
            r"mix-[a-z0-9][a-z0-9-]{0,47}", self.id
        ):
            raise ValueError(
                "mix id requires mix- and 1-48 lowercase letters, digits or hyphens"
            )
        if not isinstance(self.name, str) or not 1 <= len(self.name.strip()) <= 120:
            raise ValueError("mix name must contain 1-120 characters")
        if any(ord(char) < 32 or ord(char) == 127 for char in self.name):
            raise ValueError("mix name cannot contain control characters")
        if not isinstance(self.components, (list, tuple)) or not all(
            isinstance(component, str) and component in MIX_COMPONENTS
            for component in self.components
        ):
            raise ValueError("unknown mix component")
        if len(self.components) < 2 or len(set(self.components)) != len(
            self.components
        ):
            raise ValueError(
                "mixes require at least two distinct components, without duplicates"
            )
        object.__setattr__(self, "name", self.name.strip())
        object.__setattr__(self, "components", tuple(self.components))


def parse_mixes(value: object) -> tuple[MixSpec, ...]:
    if not isinstance(value, (list, tuple)):
        raise ValueError("mixes must be an array")
    mixes = []
    for item in value:
        if isinstance(item, MixSpec):
            mix = item
        elif isinstance(item, dict) and set(item) == {"id", "name", "components"}:
            mix = MixSpec(**item)
        else:
            raise ValueError("each mix requires exactly id, name and components")
        mixes.append(mix)
    if len({mix.id for mix in mixes}) != len(mixes):
        raise ValueError("mix ids must be unique")
    return tuple(mixes)


@dataclass(frozen=True)
class SeparationOptions:
    extract_vocals: bool = False
    extract_instruments: bool = False
    extract_lyrics: bool = False
    detect_pitch: bool = False
    extract_pitched_lyrics: bool = False
    mixes: tuple[MixSpec, ...] = ()
    decrowd: bool = False
    decrowd_vocals: bool = False
    dereverb: bool = False
    genders: bool = False
    lead_backing: bool = False
    drums: bool = False
    pitch_semitones: float = 0.0
    tempo_percent: float = 100.0

    def __post_init__(self) -> None:
        object.__setattr__(self, "mixes", parse_mixes(self.mixes))
        if not isfinite(self.pitch_semitones):
            raise ValueError("pitch_semitones must be finite")
        if not isfinite(self.tempo_percent) or self.tempo_percent <= 0:
            raise ValueError("tempo_percent must be finite and positive")

    def display_name(self, label: str) -> str:
        if label == "drums-vocals":
            return "Drums + Vocals"
        return next((mix.name for mix in self.mixes if mix.id == label), label)

    @property
    def mix_components(self) -> set[str]:
        components = {component for mix in self.mixes for component in mix.components}
        if self.detect_pitch:
            components.update(("drums", "vocals"))
        return components

    def component_label(self, component: str) -> str:
        """Resolve global cleanup once for both extraction planning and mixing."""
        label = {
            "other": "other-instruments",
            "female": "vocals-female",
            "male": "vocals-male",
        }.get(component, component)
        if component == "vocals" and self.decrowd_vocals:
            label = "vocals-decrowded"
        if component == "instruments" and self.decrowd:
            label = "instruments-decrowded"
        if (
            component in {"vocals", "female", "male", "lead", "backing"}
            and self.dereverb
        ):
            label += "-dry"
        return label

    @property
    def needs_lyrics(self) -> bool:
        return self.extract_lyrics or self.extract_pitched_lyrics

    @property
    def needs_pitch(self) -> bool:
        return self.detect_pitch or self.extract_pitched_lyrics

    @property
    def output_labels(self) -> list[str]:
        """Explicit outputs in download order; prerequisite stems stay internal."""
        vocals = []
        if self.extract_vocals:
            vocals.append("vocals")
        if self.decrowd_vocals:
            vocals.append("vocals-decrowded")
        if self.genders:
            vocals.extend(("vocals-male", "vocals-female"))
        if self.lead_backing:
            vocals.extend(("lead", "backing"))
        labels = []
        for label in vocals:
            labels.append(label)
            if self.dereverb:
                labels.append(f"{label}-dry")
        if self.extract_instruments:
            labels.append("instruments")
        if self.decrowd:
            labels.append("instruments-decrowded")
        if self.drums:
            labels.extend(("drums", "bass", "other-instruments"))
        if self.detect_pitch:
            labels.append("drums-vocals")
        labels.extend(mix.id for mix in self.mixes)
        if self.dereverb and not labels:
            labels.append("vocals-dry")
        return labels

    @property
    def pitch_labels(self) -> list[str]:
        """Only selected vocal stems; never accompaniment or reconstructed mixes."""
        selected = [
            label
            for label in self.output_labels
            if label.removesuffix("-dry") in VOCAL_STEM_LABELS
        ]
        return selected or ["vocals"] if self.needs_pitch else []

    @property
    def result_labels(self) -> list[str]:
        """Public transformed outputs, including the full source when pitched."""
        labels = self.output_labels
        if self.pitch_semitones != 0 or (not labels and self.tempo_percent != 100):
            labels.insert(0, "song")
        return labels
