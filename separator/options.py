from dataclasses import dataclass
from math import isfinite


@dataclass(frozen=True)
class SeparationOptions:
    extract_vocals: bool = False
    extract_instruments: bool = False
    extract_lyrics: bool = False
    detect_pitch: bool = False
    mix_female_instruments: bool = False
    mix_male_instruments: bool = False
    mix_backing_instruments: bool = False
    mix_lead_instruments: bool = False
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
            (self.mix_lead_instruments, "lead-instruments"),
        ):
            if selected:
                labels.append(label)
        if self.dereverb and not labels:
            labels.append("vocals-dry")
        return labels

    @property
    def pitch_labels(self) -> list[str]:
        """Only selected vocal stems; never accompaniment or reconstructed mixes."""
        vocal_labels = {
            "vocals",
            "vocals-decrowded",
            "vocals-male",
            "vocals-female",
            "lead",
            "backing",
        }
        selected = [
            label
            for label in self.output_labels
            if label.removesuffix("-dry") in vocal_labels
        ]
        return selected or ["vocals"] if self.detect_pitch else []

    @property
    def result_labels(self) -> list[str]:
        """Public transformed outputs, including the full source when pitched.

        Tempo-only jobs retain their existing full-song fallback when no stems
        are selected. The source song is CPU-only, never a separation output.
        """
        labels = self.output_labels
        if self.pitch_semitones != 0 or (
            not self.output_labels and self.tempo_percent != 100
        ):
            labels.insert(0, "song")
        return labels
