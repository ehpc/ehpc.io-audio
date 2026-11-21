"""Lightweight transcript contract shared by the GPU worker and web API."""

import json
from collections import Counter
from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from itertools import pairwise
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
UNKNOWN_TIMESTAMP = "??:??"


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
class CanonicalWordPosition:
    """Published word index and exact position in the intact reference text."""

    word_index: int
    reference_line_index: int
    reference_token_index: int


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
    canonical_word_positions: list[CanonicalWordPosition] = field(default_factory=list)

    status: Literal["recognized", "empty"] = field(init=False, default="empty")

    def __post_init__(self) -> None:
        has_recognition = (
            self.segments
            or self.words
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
        if any(
            position.word_index < 0
            or position.word_index >= len(self.words)
            or position.reference_line_index < 0
            or position.reference_token_index < 0
            for position in self.canonical_word_positions
        ):
            raise ValueError("Invalid canonical word position")

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
    """Format a start-only onset as whole seconds on the caller's audio clock."""
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


@dataclass(frozen=True)
class LyricDisplayLine:
    """Canonical text and independently supported original-clock bounds."""

    text: str
    prefix: str
    start_s: float | None = None
    end_s: float | None = None
    canonical_line_index: int | None = None
    onset_s: float | None = None
    onset_source: Literal["provider-synced", "acoustic", "unknown"] = "unknown"


@dataclass(frozen=True)
class LyricLineWord:
    word_index: int
    token_index: int


@dataclass(frozen=True)
class LyricLineProjection:
    text: str
    source_kind: Literal["canonical", "asr-extra", "asr-word", "segment", "untimed"]
    source_index: int
    canonical_line_index: int | None
    onset_s: float | None
    end_s: float | None
    onset_source: Literal["provider-synced", "acoustic", "unknown"]
    words: list[LyricLineWord]


def ordered_lyric_lines(transcript: Transcript) -> list[LyricLineProjection]:
    """Project stored evidence without modifying the transcript or inventing ends."""
    from separator.lyrics_reference import tokens  # noqa: PLC0415

    review = transcript.reference
    lines = review.lines if review is not None else []
    duration = review.duration_s if review is not None else None
    provider_ok = (
        review is not None
        and bool(lines)
        and review.provider == "LRCLIB"
        and review.provider_timing_status == "validated"
        and duration is not None
        and isfinite(duration)
        and duration > 0
        and all(
            line.provider_start_s is not None
            and isfinite(line.provider_start_s)
            and 0 <= line.provider_start_s < duration
            and line.provider_end_s is not None
            and isfinite(line.provider_end_s)
            and line.provider_start_s < line.provider_end_s <= duration
            for line in lines
        )
        and all(
            left.provider_end_s is not None
            and right.provider_start_s is not None
            and left.provider_end_s <= right.provider_start_s
            for left, right in pairwise(lines)
        )
    )
    result = []
    for index, line in enumerate(lines):
        expected = tokens(line.text)
        positions = [
            LyricLineWord(position.word_index, position.reference_token_index)
            for position in transcript.canonical_word_positions
            if position.reference_line_index == index
            and 0 <= position.word_index < len(transcript.words)
            and 0 <= position.reference_token_index < len(expected)
            and tokens(transcript.words[position.word_index].text)
            == [expected[position.reference_token_index]]
        ]
        first = [position for position in positions if position.token_index == 0]
        if provider_ok:
            onset, source = line.provider_start_s, "provider-synced"
        elif len(first) == 1:
            onset, source = transcript.words[first[0].word_index].start_s, "acoustic"
        else:
            onset, source = None, "unknown"
        result.append(
            LyricLineProjection(
                line.text, "canonical", index, index, onset, None, source, positions
            )
        )

    linked = {word.word_index for line in result for word in line.words}

    def segment_words(segment: TranscriptSegment) -> list[LyricLineWord]:
        expected = tokens(segment.text)
        heard = [
            (word_index, tokens(word.text))
            for word_index, word in enumerate(transcript.words)
            if word_index not in linked
            and segment.start_s <= word.start_s
            and word.end_s <= segment.end_s
        ]
        single = [item[0] if len(item) == 1 else None for _, item in heard]
        exact = expected == single
        positions = []
        for token_index, token in enumerate(expected):
            if exact:
                positions.append(LyricLineWord(heard[token_index][0], token_index))
            elif expected.count(token) == 1 and single.count(token) == 1:
                positions.append(
                    LyricLineWord(heard[single.index(token)][0], token_index)
                )
        linked.update(position.word_index for position in positions)
        return positions

    segments = transcript.asr_extras if lines else transcript.segments
    kind = "asr-extra" if lines else "segment"
    for index, segment in enumerate(segments):
        result.append(
            LyricLineProjection(
                segment.text,
                kind,
                index,
                None,
                segment.start_s,
                segment.end_s,
                "acoustic",
                segment_words(segment),
            )
        )
    for index, word in enumerate(transcript.words):
        if (
            index in linked
            or (lines and word.origin != "asr-extra")
            or any(
                segment.start_s <= word.start_s and word.end_s <= segment.end_s
                for segment in segments
            )
        ):
            continue
        result.append(
            LyricLineProjection(
                word.text,
                "asr-word",
                index,
                None,
                word.start_s,
                word.end_s,
                "acoustic",
                [LyricLineWord(index, 0)],
            )
        )
    if not lines:
        for index, item in enumerate(transcript.untimed):
            result.append(
                LyricLineProjection(
                    item.text, "untimed", index, None, None, None, "unknown", []
                )
            )
    return result


type LyricLineRenderer = Callable[[LyricDisplayLine], str]


def _plain_line(line: LyricDisplayLine) -> str:
    return f"[{line.prefix}] {line.text}\n"


def _single_line(value: str) -> str:
    return " ".join(value.split())


def _identity_line(
    reference: "ReferenceReview | None", title: str | None
) -> str | None:
    """Reference song identity wins; the job title is the fallback."""
    if reference is not None:
        artist = _single_line(reference.artist) if reference.artist else ""
        track = _single_line(reference.title) if reference.title else ""
        if artist and track:
            return f"{artist} — {track}"
        if artist or track:
            return artist or track
    if title:
        return _single_line(title)
    return None


def _head_lines(
    reference: "ReferenceReview | None", title: str | None, output_key: str | None
) -> list[str]:
    head: list[str] = []
    identity = _identity_line(reference, title)
    if identity is not None:
        head.append(f"{identity}\n")
    if output_key is not None:
        head.append(f"Tonality: {output_key}\n")
    return head


def transcript_text(
    segments: list[TranscriptSegment],
    sections: list[TranscriptSection] | None = None,
    render_line: LyricLineRenderer = _plain_line,
) -> str:
    """One canonical TXT: model headings and intact ASR lines on the source clock.

    A line crossing a boundary belongs to its greatest-overlap section (earliest
    wins ties). Without word alignment we must not split, duplicate, or drop it.
    Model intervals without lyrics still have headings; gaps never acquire an
    invented musical label. Distinct same-label intervals remain distinct.
    """
    if not sections:
        return "".join(
            render_line(
                LyricDisplayLine(
                    segment.text,
                    format_timestamp(segment.start_s),
                    segment.start_s,
                    segment.end_s,
                )
            )
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
            render_line(
                LyricDisplayLine(
                    segment.text,
                    format_timestamp(segment.start_s),
                    segment.start_s,
                    segment.end_s,
                )
            )
            for segment in lines
        )
        previous_was_section = kind == 0
    return "".join(output)


def transcript_export_text(
    transcript: Transcript,
    render_line: LyricLineRenderer = _plain_line,
    output_tempo_percent: float | None = None,
    *,
    title: str | None = None,
    output_key: str | None = None,
) -> str:
    """One primary renderer: ordered canonical candidates or independent ASR.

    The file starts with an identity line (reference artist/track, else the
    caller's title), plus a Tonality line when the caller supplies an output
    key. Undetectable onsets render the UNKNOWN_TIMESTAMP token.
    """
    rate = output_tempo_percent / 100 if output_tempo_percent is not None else 1
    clock = "Output" if output_tempo_percent is not None else "Original"
    head = _head_lines(transcript.reference, title, output_key)
    presentation = ordered_lyric_lines(transcript)
    timed_lines = sorted(
        (
            TranscriptSegment(line.onset_s, line.end_s, line.text)
            for line in presentation
            if line.source_kind in {"segment", "asr-extra", "asr-word"}
            and line.onset_s is not None
            and line.end_s is not None
        ),
        key=lambda line: line.start_s,
    )
    if transcript.reference is not None and transcript.reference.lines:
        review = transcript.reference
        output = list(head)
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
            projected = presentation[index]
            prefix = (
                format_timestamp(projected.onset_s)
                if projected.onset_s is not None
                else UNKNOWN_TIMESTAMP
            )
            output.append(
                render_line(
                    LyricDisplayLine(
                        line.text,
                        prefix,
                        line.start_s if line.status == "aligned" else None,
                        line.end_s if line.status == "aligned" else None,
                        index,
                        projected.onset_s,
                        projected.onset_source,
                    )
                )
            )
            previous_group = line.group
        if has_anchors:
            output.extend(
                f"\n[{SECTION_HEADINGS[section.label]}]\n"
                for section in transcript.sections[next_section:]
            )
        if timed_lines:
            output.append(transcript_text(timed_lines, render_line=render_line))
        if transcript.sections and not has_anchors:
            output.append(
                "\n[Estimated musical structure — original mix; "
                f"{clock.lower()} clock]\n"
                if output_tempo_percent is not None
                else "\n[Estimated musical structure — original mix/clock]\n"
            )
            output.extend(
                f"[{format_timestamp(section.start_s / rate)}] "
                f"{SECTION_HEADINGS[section.label]}\n"
                for section in transcript.sections
            )
        return "".join(output)
    text = "".join(head) + transcript_text(
        timed_lines, transcript.sections, render_line
    )
    if transcript.untimed:
        text += "\n[Recognized text — alignment unavailable, NO TIMESTAMPS]\n"
        for item in transcript.untimed:
            text += render_line(LyricDisplayLine(item.text, UNKNOWN_TIMESTAMP))
            text += f"[Alignment unavailable: {item.reason}]\n"
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
        canonical_word_positions=[
            CanonicalWordPosition(**position)
            for position in value.get("canonical_word_positions", [])
        ],
        reference=(
            reference_review_from_dict(value["reference"])
            if value.get("reference") is not None
            else None
        ),
    )
