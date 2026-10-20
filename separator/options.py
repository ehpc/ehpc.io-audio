from dataclasses import dataclass
from math import isfinite


@dataclass(frozen=True)
class SeparationOptions:
    extract_vocals: bool = False
    extract_instruments: bool = False
    mix_female_instruments: bool = False
    mix_male_instruments: bool = False
    mix_backing_instruments: bool = False
    decrowd: bool = False
    decrowd_vocals: bool = False
    dereverb: bool = False
    genders: bool = False
    lead_backing: bool = False
    drums: bool = False
    no_cache: bool = False
    pitch_semitones: float = 0.0
    tempo_percent: float = 100.0

    def __post_init__(self) -> None:
        if not isfinite(self.pitch_semitones):
            raise ValueError("pitch_semitones must be finite")
        if not isfinite(self.tempo_percent) or self.tempo_percent <= 0:
            raise ValueError("tempo_percent must be finite and positive")

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
        for selected, label in (
            (self.mix_female_instruments, "female-instruments"),
            (self.mix_male_instruments, "male-instruments"),
            (self.mix_backing_instruments, "backing-instruments"),
        ):
            if selected:
                labels.append(label)
        if self.dereverb and not labels:
            labels.append("vocals-dry")
        return labels
