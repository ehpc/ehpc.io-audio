"""Lightweight transcript contract shared by the GPU worker and web API."""

import json
from collections import Counter
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
    probability: float | None = None
    alignment_score: float | None = None
    origin: Literal["asr", "reference-aligned", "asr-extra"] = "asr"

    def __post_init__(self) -> None:
        if (
            not all(isfinite(v) for v in (self.start_s, self.end_s))
            or self.start_s < 0
            or self.end_s <= self.start_s
            or (
                self.probability is not None
                and (not isfinite(self.probability) or not 0 <= self.probability <= 1)
            )
            or (
                self.alignment_score is not None
                and (
                    not isfinite(self.alignment_score)
                    or not 0 <= self.alignment_score <= 1
                )
            )
            or not self.text.strip()
        ):
            raise ValueError("Invalid transcript word")


@dataclass(frozen=True)
class RecognitionChunk:
    """Raw, unprompted ASR with input-window bounds, NOT sung-word timestamps."""

    input_start_s: float
    input_end_s: float
    ownership_start_s: float
    ownership_end_s: float
    text: str
    language: str


@dataclass(frozen=True)
class UntimedRecognition:
    text: str
    reason: str


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
    asr_model: str | None = None
    word_alignment: str | None = None
    recognition_chunks: list[RecognitionChunk] = field(default_factory=list)
    untimed: list[UntimedRecognition] = field(default_factory=list)
    asr_extras: list[TranscriptSegment] = field(default_factory=list)

    status: Literal["recognized", "empty"] = field(init=False, default="empty")

    def __post_init__(self) -> None:
        has_recognition = (
            self.segments
            or self.untimed
            or self.asr_extras
            or any(chunk.text.strip() for chunk in self.recognition_chunks)
            or (
                self.reference is not None
                and (
                    self.reference.original_segments or self.reference.original_untimed
                )
            )
        )
        object.__setattr__(self, "status", "recognized" if has_recognition else "empty")
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


def recognition_transcript(
    chunks: list[RecognitionChunk],
    alignments: list[list[TranscriptWord]],
    asr_model: str,
    alignment_model: str,
    minimum_score: float,
) -> Transcript:
    """Keep raw ASR intact; publish only acoustically supported ownership spans."""
    from separator.lyrics_reference import tokens  # noqa: PLC0415

    words: list[TranscriptWord] = []
    segments = []
    untimed = []
    languages: Counter[str] = Counter()
    for chunk, candidates in zip(chunks, alignments, strict=True):
        if not chunk.text.strip():
            continue
        languages[chunk.language] += 1
        owned = [
            word
            for word in candidates
            if chunk.ownership_start_s
            <= (word.start_s + word.end_s) / 2
            < chunk.ownership_end_s
        ]
        aligned = [
            word
            for word in owned
            if word.alignment_score is not None
            and word.alignment_score >= minimum_score
            and (not words or word.start_s >= words[-1].end_s)
        ]
        if not candidates:
            untimed.append(
                UntimedRecognition(
                    chunk.text,
                    "Acoustic alignment unavailable for this text/script; "
                    "input window bounds are not lyric timestamps.",
                )
            )
        else:
            missing = [word.text for word in owned if word not in aligned]
            candidate_tokens = [
                token for word in candidates for token in tokens(word.text)
            ]
            if candidate_tokens != tokens(chunk.text):
                # An aligner returning only part of the recognized text must
                # never erase the raw recognition or silently claim completeness.
                untimed.append(
                    UntimedRecognition(
                        chunk.text,
                        "Incomplete alignment; full unprompted recognition retained.",
                    )
                )
            elif missing:
                untimed.append(
                    UntimedRecognition(
                        " ".join(missing),
                        "Insufficient acoustic alignment evidence; "
                        "raw context is retained.",
                    )
                )
        if aligned:
            segments.append(
                TranscriptSegment(
                    aligned[0].start_s,
                    aligned[-1].end_s,
                    " ".join(word.text for word in aligned),
                )
            )
            words.extend(aligned)
    return Transcript(
        segments=segments,
        words=words,
        language=languages.most_common(1)[0][0] if languages else None,
        asr_model=asr_model,
        word_alignment=alignment_model if words else None,
        recognition_chunks=chunks,
        untimed=untimed,
    )


def format_timestamp(seconds: float) -> str:
    """Format an onset as whole seconds on the original audio clock."""
    total_seconds = int(seconds)
    minutes, seconds = divmod(total_seconds, 60)
    return f"{minutes:02d}:{seconds:02d}"


def _best_section(
    segment: TranscriptSegment,
    sections: list[TranscriptSection],
    first: int = 0,
) -> int | None:
    """Greatest overlap; preserve the earliest interval on a tie."""
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
    return best


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
        best = _best_section(segment, sections, first)
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


def transcript_export_text(transcript: Transcript) -> str:
    """One primary renderer: ordered canonical candidates or independent ASR."""
    if transcript.reference is not None and transcript.reference.lines:
        review = transcript.reference
        source = review.source_url or review.provider
        output = [
            "[Canonical reference lyrics — candidate text, NOT verified]\n",
            "[Original audio clock; unconfirmed lines have NO TIMESTAMP]\n",
            f"[Reference source: {source}]\n",
        ]
        anchored = [
            _best_section(
                TranscriptSegment(line.start_s, line.end_s, line.text),
                transcript.sections,
            )
            if line.status == "aligned"
            and line.start_s is not None
            and line.end_s is not None
            else None
            for line in review.lines
        ]
        group_sections: dict[int, set[int]] = {}
        for line, section in zip(review.lines, anchored, strict=True):
            if section is not None:
                group_sections.setdefault(line.group, set()).add(section)
        has_anchors = any(section is not None for section in anchored)
        next_section = 0
        have_heading = False
        previous_group = None
        for index, line in enumerate(review.lines):
            if previous_group is not None and line.group != previous_group:
                output.append("\n")
            desired = anchored[index]
            if desired is None and previous_group != line.group:
                group_anchors = group_sections.get(line.group, set())
                if len(group_anchors) == 1:
                    desired = next(iter(group_anchors))
            if desired is not None:
                for section_index in range(next_section, desired + 1):
                    section = transcript.sections[section_index]
                    output.append(f"\n[{SECTION_HEADINGS[section.label]}]\n")
                next_section = max(next_section, desired + 1)
                have_heading = True
            elif transcript.sections and (
                previous_group != line.group
                or (line.status == "aligned" and not have_heading)
            ):
                output.append("\n[Unknown section — no reliable lyric anchor]\n")
                have_heading = True
            if line.status == "aligned" and line.start_s is not None:
                prefix = format_timestamp(line.start_s)
            else:
                prefix = f"Reference line {index + 1}; UNCONFIRMED, NO TIMESTAMP"
            output.append(f"[{prefix}] {line.text}\n")
            previous_group = line.group
        if has_anchors:
            output.extend(
                f"\n[{SECTION_HEADINGS[section.label]}]\n"
                for section in transcript.sections[next_section:]
            )
        if transcript.asr_extras:
            output.append(
                "\n[ASR-only candidate extras/adlibs — not in canonical reference]\n"
            )
            output.append(transcript_text(transcript.asr_extras))
        uncertain = [
            f"[Reference line {index + 1}: {len(line.unconfirmed_words)} "
            "uncorroborated word timings; NO WORD TIMESTAMPS — see JSON]\n"
            for index, line in enumerate(review.lines)
            if line.status == "aligned" and line.unconfirmed_words
        ]
        if uncertain:
            output.append("\n[Word-level timing uncertainty]\n")
            output.extend(uncertain)
        if transcript.sections and not has_anchors:
            output.append("\n[Estimated musical structure — original mix/clock]\n")
            output.extend(
                f"[{format_timestamp(section.start_s)}] "
                f"{SECTION_HEADINGS[section.label]}\n"
                for section in transcript.sections
            )
        return "".join(output)
    text = transcript_text(transcript.segments, transcript.sections)
    if transcript.untimed:
        text += "\n[Recognized text — alignment unavailable, NO TIMESTAMPS]\n"
        text += "".join(f"{item.text} ({item.reason})\n" for item in transcript.untimed)
    return text


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
        asr_model=value.get("asr_model"),
        word_alignment=value.get("word_alignment"),
        recognition_chunks=[
            RecognitionChunk(**chunk) for chunk in value.get("recognition_chunks", [])
        ],
        untimed=[UntimedRecognition(**item) for item in value.get("untimed", [])],
        asr_extras=[
            TranscriptSegment(**segment) for segment in value.get("asr_extras", [])
        ],
        reference=(
            reference_review_from_dict(value["reference"])
            if value.get("reference") is not None
            else None
        ),
    )
