"""Dependency-free pitch/word timeline contract shared by worker and web."""

import io
import json
import sys
import zipfile
from array import array
from collections.abc import Sequence
from dataclasses import asdict, dataclass, field, replace
from math import floor, isfinite, log2, sqrt
from statistics import median
from typing import Literal

from separator.lyrics import TranscriptWord

NOTE_NAMES = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")
FRAME_SECONDS = 0.01
MIN_NOTE_SECONDS = 0.08
MIN_PERIODICITY = 0.21
MIN_RMS = 0.001  # -60 dBFS: CREPE can report confident pitches on digital silence.

type FrameRegion = tuple[int, int]  # start frame, exclusive end frame


def note_name(midi: int) -> str:
    return f"{NOTE_NAMES[midi % 12]}{midi // 12 - 1}"


@dataclass(frozen=True)
class PitchNote:
    start_s: float
    end_s: float
    midi: float
    frequency_hz: float
    confidence: float
    note: str = field(init=False)
    cents: float = field(init=False)
    word_indices: list[int] = field(default_factory=list)

    def __post_init__(self) -> None:
        if (
            not all(
                isfinite(v)
                for v in (
                    self.start_s,
                    self.end_s,
                    self.midi,
                    self.frequency_hz,
                    self.confidence,
                )
            )
            or self.start_s < 0
            or self.end_s <= self.start_s
            or self.frequency_hz <= 0
            or not 0 <= self.confidence <= 1
        ):
            raise ValueError("Invalid pitch note")
        nearest = floor(self.midi + 0.5)
        object.__setattr__(self, "note", note_name(nearest))
        object.__setattr__(self, "cents", round((self.midi - nearest) * 100, 1))


@dataclass(frozen=True)
class PitchTrack:
    label: str
    notes: list[PitchNote]

    def __post_init__(self) -> None:
        if any(
            b.start_s < a.end_s
            for a, b in zip(self.notes, self.notes[1:], strict=False)
        ):
            raise ValueError("Pitch notes must be ordered and non-overlapping")


@dataclass(frozen=True)
class PitchAnalysis:
    source_duration_s: float
    duration_s: float
    tracks: list[PitchTrack]
    words: list[TranscriptWord] = field(default_factory=list)
    pitch_shift_semitones: float = 0.0
    tempo_percent: float = 100.0
    timestamp_reference: Literal["output"] = "output"
    pitch_reference: Literal["output"] = "output"
    model: str = "torchcrepe/full"
    word_alignment: str | None = None
    version: int = 1

    def __post_init__(self) -> None:
        if (
            not all(
                isfinite(v)
                for v in (
                    self.source_duration_s,
                    self.duration_s,
                    self.pitch_shift_semitones,
                    self.tempo_percent,
                )
            )
            or self.source_duration_s <= 0
            or self.duration_s <= 0
            or self.tempo_percent <= 0
        ):
            raise ValueError("Invalid pitch analysis duration or transformation")
        for track in self.tracks:
            if any(note.end_s > self.duration_s + 0.001 for note in track.notes):
                raise ValueError("Pitch notes exceed the audio duration")
            if any(
                index < 0 or index >= len(self.words)
                for note in track.notes
                for index in note.word_indices
            ):
                raise ValueError("Invalid pitch word association")


def pitch_to_json(analysis: PitchAnalysis) -> str:
    return json.dumps(asdict(analysis), ensure_ascii=False, allow_nan=False)


def pitch_from_json(data: str) -> PitchAnalysis:
    value = json.loads(data)
    value["tracks"] = [
        PitchTrack(
            label=track["label"],
            notes=[
                PitchNote(
                    **{k: v for k, v in note.items() if k not in {"note", "cents"}}
                )
                for note in track["notes"]
            ],
        )
        for track in value["tracks"]
    ]
    value["words"] = [TranscriptWord(**word) for word in value.get("words", [])]
    return PitchAnalysis(**value)


def segment_frames(
    frequencies: list[float],
    periodicities: list[float],
    rms: list[float],
    duration_s: float,
    frame_s: float = FRAME_SECONDS,
) -> list[PitchNote]:
    """Stable semitone regions, not a score or polyphonic transcription.

    Median smoothing and 65-cent transition hysteresis suppress vibrato chatter.
    Real unvoiced gaps remain gaps, including repeated same-pitch notes. Regions
    shorter than 80 ms are omitted, never stretched into fabricated notes.
    """
    if not len(frequencies) == len(periodicities) == len(rms):
        raise ValueError("Pitch frame arrays must have equal lengths")
    pitches = [
        69 + 12 * log2(hz / 440)
        if isfinite(hz)
        and hz > 0
        and isfinite(probability)
        and probability >= MIN_PERIODICITY
        and level >= MIN_RMS
        else None
        for hz, probability, level in zip(frequencies, periodicities, rms, strict=True)
    ]
    smoothed = [
        median([p for p in pitches[max(0, i - 5) : i + 6] if p is not None])
        if pitch is not None
        else None
        for i, pitch in enumerate(pitches)
    ]
    regions: list[FrameRegion] = []
    current: int | None = None
    start = 0
    for i, pitch in enumerate([*smoothed, None]):
        target = (
            None
            if pitch is None
            else (
                current
                if current is not None and abs(pitch - current) < 0.65
                else round(pitch)
            )
        )
        if target != current:
            if current is not None:
                regions.append((start, i))
            current, start = target, i
    notes = []
    for start, end in regions:
        onset = max(0.0, start * frame_s - frame_s / 2)
        offset = min(duration_s, end * frame_s - frame_s / 2)
        if offset - onset + 1e-9 < MIN_NOTE_SECONDS:
            continue
        midi = median([p for p in pitches[start:end] if p is not None])
        notes.append(
            PitchNote(
                onset,
                offset,
                midi,
                440 * 2 ** ((midi - 69) / 12),
                median(periodicities[start:end]),
            )
        )
    return notes


def _pitch_rms(
    audio: Sequence[float], frame_count: int, sample_rate: int
) -> list[float]:
    """Original centered 64 ms RMS, with sequential float64 prefix sums."""
    # This is np.pad(audio.astype(float64) ** 2, (512, 512)), followed
    # by concatenate([0], cumsum(...)), without a NumPy web dependency.
    cumulative = array("d", [0.0]) * (len(audio) + 1025)
    total = 0.0
    for index, sample in enumerate(audio, 513):
        total += sample * sample
        cumulative[index] = total
    for index in range(len(audio) + 513, len(cumulative)):
        cumulative[index] = total
    hop_length = int(sample_rate * FRAME_SECONDS)
    return [
        sqrt(
            (
                cumulative[min(frame * hop_length + 1024, len(audio) + 1024)]
                - cumulative[frame * hop_length]
            )
            / 1024
        )
        for frame in range(frame_count)
    ]


def assemble_pitch_prediction(payload: bytes, label: str = "vocals") -> PitchAnalysis:
    """Assemble raw CREPE/PCM wire output on the VPS's original source clock."""
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        metadata = json.loads(archive.read("metadata.json"))
        arrays = []
        for name in ("audio.f32", "pitch.f32", "periodicity.f32"):
            values = array("f")
            values.frombytes(archive.read(name))
            if sys.byteorder != "little":
                values.byteswap()
            if not values or any(not isfinite(value) for value in values):
                raise ValueError("Pitch prediction requires finite, nonempty arrays")
            arrays.append(values)
    audio, frequencies, periodicities = arrays
    sample_rate = metadata["sample_rate"]
    duration_s = metadata["duration_s"]
    if sample_rate != 16000 or duration_s != len(audio) / sample_rate:
        raise ValueError("Pitch PCM metadata does not match the canonical decoder")
    if len(frequencies) != len(periodicities):
        raise ValueError("Pitch frame arrays must have equal lengths")
    levels = _pitch_rms(audio, len(frequencies), sample_rate)
    notes = segment_frames(
        frequencies.tolist(), periodicities.tolist(), levels, duration_s
    )
    return PitchAnalysis(duration_s, duration_s, [PitchTrack(label, notes)])


def transform_analysis(
    source: PitchAnalysis,
    pitch_semitones: float,
    tempo_percent: float,
    words: list[TranscriptWord] | None = None,
    word_alignment: str | None = None,
) -> PitchAnalysis:
    """Project source detections onto the same pitch/tempo as generated audio.

    Word intervals come from full-vocal acoustic alignment, not segment
    interpolation. A word may overlap multiple notes (melisma); no syllable
    boundaries or split-voice recognition are inferred.
    """
    rate = tempo_percent / 100
    aligned = [
        replace(w, start_s=w.start_s / rate, end_s=w.end_s / rate)
        for w in (words or [])
    ]
    tracks = []
    for track in source.tracks:
        notes = []
        first = 0
        for note in track.notes:
            start, end = note.start_s / rate, note.end_s / rate
            while first < len(aligned) and aligned[first].end_s <= start:
                first += 1
            indices = []
            for index in range(first, len(aligned)):
                word = aligned[index]
                if word.start_s >= end:
                    break
                if min(end, word.end_s) - max(start, word.start_s) >= 0.02 / rate:
                    indices.append(index)
            notes.append(
                replace(
                    note,
                    start_s=start,
                    end_s=end,
                    midi=note.midi + pitch_semitones,
                    frequency_hz=note.frequency_hz * 2 ** (pitch_semitones / 12),
                    word_indices=indices,
                )
            )
        tracks.append(PitchTrack(track.label, notes))
    return replace(
        source,
        duration_s=source.source_duration_s / rate,
        tracks=tracks,
        words=aligned,
        pitch_shift_semitones=pitch_semitones,
        tempo_percent=tempo_percent,
        word_alignment=word_alignment if words is not None else None,
    )
