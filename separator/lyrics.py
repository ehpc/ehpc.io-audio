"""Lightweight transcript contract shared by the GPU worker and web API."""

import json
from dataclasses import asdict, dataclass, field
from math import isfinite
from typing import TYPE_CHECKING, Literal

if TYPE_CHECKING:
    from separator.lyrics_reference import ReferenceReview

SectionLabel = Literal[
    "intro", "verse", "chorus", "bridge", "inst", "outro", "silence", "pre-chorus"
]
SECTION_HEADINGS = {
    "intro": "Intro",
    "verse": "Verse",
    "chorus": "Chorus",
    "bridge": "Bridge",
    "inst": "Instrumental",
    "outro": "Outro",
    "silence": "Silence",
    "pre-chorus": "Pre-chorus",
}


@dataclass(frozen=True)
class TranscriptSegment:
    start_s: float
    end_s: float
    text: str

    def __post_init__(self) -> None:
        if (
            not isfinite(self.start_s)
            or not isfinite(self.end_s)
            or self.start_s < 0
            or self.end_s < self.start_s
        ):
            raise ValueError("Invalid transcript segment timestamps")


@dataclass(frozen=True)
class TranscriptWord:
    start_s: float
    end_s: float
    text: str
    probability: float

    def __post_init__(self) -> None:
        if (
            not all(isfinite(v) for v in (self.start_s, self.end_s, self.probability))
            or self.start_s < 0
            or self.end_s <= self.start_s
            or not 0 <= self.probability <= 1
            or not self.text.strip()
        ):
            raise ValueError("Invalid transcript word")


@dataclass(frozen=True)
class TranscriptSection:
    start_s: float
    end_s: float
    label: SectionLabel

    def __post_init__(self) -> None:
        if (
            not isfinite(self.start_s)
            or not isfinite(self.end_s)
            or self.start_s < 0
            or self.end_s <= self.start_s
        ):
            raise ValueError("Invalid musical section timestamps")
        if self.label not in SECTION_HEADINGS:
            raise ValueError("Invalid musical section label")


@dataclass(frozen=True)
class Transcript:
    segments: list[TranscriptSegment] = field(default_factory=list)
    language: str | None = None
    timestamp_reference: Literal["original"] = "original"
    sections: list[TranscriptSection] = field(default_factory=list)
    structure_model: str | None = None
    words: list[TranscriptWord] = field(default_factory=list)
    reference: "ReferenceReview | None" = None

    status: Literal["recognized", "empty"] = field(init=False, default="empty")

    def __post_init__(self) -> None:
        object.__setattr__(self, "status", "recognized" if self.segments else "empty")
        if any(
            right.start_s < left.end_s
            for left, right in zip(self.segments, self.segments[1:], strict=False)
        ):
            raise ValueError("Transcript segments must be ordered and non-overlapping")
        if any(
            right.start_s < left.end_s
            for left, right in zip(self.sections, self.sections[1:], strict=False)
        ):
            raise ValueError("Musical sections must be ordered and non-overlapping")
        if any(
            right.start_s < left.end_s
            for left, right in zip(self.words, self.words[1:], strict=False)
        ):
            raise ValueError("Transcript words must be ordered and non-overlapping")

    def __reduce__(self):
        # The already-deployed web worker knows this canonical JSON decoder.
        # Transport only primitives: a GPU-first promotion must not send it a
        # pickle referencing the newly introduced TranscriptSection class.
        return transcript_from_json, (json.dumps(asdict(self), ensure_ascii=False),)


def format_timestamp(seconds: float) -> str:
    """Format an onset as whole seconds on the original audio clock."""
    total_seconds = int(seconds)
    minutes, seconds = divmod(total_seconds, 60)
    return f"{minutes:02d}:{seconds:02d}"


def transcript_text(
    segments: list[TranscriptSegment],
    sections: list[TranscriptSection] | None = None,
) -> str:
    """One canonical TXT: model headings and intact ASR lines on the source clock.

    A line crossing a boundary belongs to its greatest-overlap section (earliest
    wins ties). Without word alignment we must not split, duplicate, or drop it.
    Model intervals without lyrics still have headings; gaps never acquire an
    invented musical label. Distinct same-label intervals remain distinct.
    """
    if not sections:
        return "".join(
            f"[{format_timestamp(segment.start_s)}] {segment.text}\n"
            for segment in segments
        )
    assigned: list[list[TranscriptSegment]] = [[] for _ in sections]
    events = [(section.start_s, 0, index) for index, section in enumerate(sections)]
    first = 0
    for index, segment in enumerate(segments):
        while first < len(sections) and sections[first].end_s <= segment.start_s:
            first += 1
        best = None
        best_overlap = 0.0
        for candidate in range(first, len(sections)):
            section = sections[candidate]
            if segment.start_s == segment.end_s:
                if section.start_s <= segment.start_s < section.end_s:
                    best = candidate
                break
            if section.start_s >= segment.end_s:
                break
            overlap = min(segment.end_s, section.end_s) - max(
                segment.start_s, section.start_s
            )
            if overlap > best_overlap:
                best, best_overlap = candidate, overlap
        if best is None:
            events.append((segment.start_s, 1, index))
        else:
            assigned[best].append(segment)
    output = []
    previous_was_section = False
    for _, kind, index in sorted(events):
        if kind == 0:
            if output:
                output.append("\n")
            output.append(f"[{SECTION_HEADINGS[sections[index].label]}]\n")
            lines = assigned[index]
        else:
            if previous_was_section:
                output.append("\n")
            lines = [segments[index]]
        output.extend(
            f"[{format_timestamp(segment.start_s)}] {segment.text}\n"
            for segment in lines
        )
        previous_was_section = kind == 0
    return "".join(output)


def transcript_from_json(data: str) -> Transcript:
    value = json.loads(data)
    # Runtime-local import breaks the reference module's dependency on this
    # lightweight transcript contract; old decoders safely ignore new fields.
    from separator.lyrics_reference import reference_review_from_dict  # noqa: PLC0415

    return Transcript(
        segments=[TranscriptSegment(**segment) for segment in value["segments"]],
        language=value["language"],
        timestamp_reference=value["timestamp_reference"],
        sections=[
            TranscriptSection(**section) for section in value.get("sections", [])
        ],
        structure_model=value.get("structure_model"),
        words=[TranscriptWord(**word) for word in value.get("words", [])],
        reference=(
            reference_review_from_dict(value["reference"])
            if value.get("reference") is not None
            else None
        ),
    )
