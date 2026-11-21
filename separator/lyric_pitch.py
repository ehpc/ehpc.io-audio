"""Read-time, output-clock lyric/pitch associations; stored evidence is untouched."""

import unicodedata
from dataclasses import dataclass
from itertools import pairwise
from math import isfinite
from typing import Literal

from separator.lyrics import Transcript, ordered_lyric_lines
from separator.lyrics_reference import tokens
from separator.pitch import PitchAnalysis


@dataclass(frozen=True)
class LyricPitchTrack:
    track_index: int
    note_indices: list[int]


@dataclass(frozen=True)
class LyricPitchWord:
    token_index: int
    start_s: float
    end_s: float
    origin: Literal["measured", "interpolated"]
    tracks: list[LyricPitchTrack]


@dataclass(frozen=True)
class LyricPitchLine:
    source_kind: Literal["canonical", "asr-extra", "asr-word", "segment", "untimed"]
    source_index: int
    canonical_line_index: int | None
    start_s: float | None
    end_s: float | None
    bounds_source: Literal["provider-synced", "acoustic", "unknown"]
    words: list[LyricPitchWord]
    tracks: list[LyricPitchTrack]


@dataclass(frozen=True)
class _WordSpan:
    start_s: float
    end_s: float
    origin: Literal["measured", "interpolated"]
    source_index: int | None


def _unique_word_cells(cells: list[str], heard: list[str]) -> dict[int, int]:
    """Only links shared by every exact, ordered embedding of published words.

    Filtered alignments omit disputed words. Greedy matching would falsely
    assign a surviving repeated word to an earlier unconfirmed occurrence.
    Prefix/suffix feasibility keeps ambiguous occurrences explicitly unknown.
    No fuzzy spelling matches or timing interpolation are used.
    """
    expected = [tokens(unicodedata.normalize("NFKC", cell)) for cell in cells]
    observed = [tokens(unicodedata.normalize("NFKC", word)) for word in heard]
    n, m = len(expected), len(observed)
    prefix = [[False] * (m + 1) for _ in range(n + 1)]
    prefix[0][0] = True
    for i in range(n):
        for j in range(m + 1):
            prefix[i + 1][j] = prefix[i][j] or (
                j > 0
                and bool(expected[i])
                and expected[i] == observed[j - 1]
                and prefix[i][j - 1]
            )
    if not prefix[n][m]:
        return {}
    suffix = [[False] * (m + 1) for _ in range(n + 1)]
    suffix[n][m] = True
    for i in range(n - 1, -1, -1):
        for j in range(m, -1, -1):
            suffix[i][j] = suffix[i + 1][j] or (
                j < m
                and bool(expected[i])
                and expected[i] == observed[j]
                and suffix[i + 1][j + 1]
            )
    links = {}
    for j in range(m):
        candidates = [
            i
            for i in range(n)
            if expected[i]
            and expected[i] == observed[j]
            and prefix[i][j]
            and suffix[i + 1][j + 1]
        ]
        if len(candidates) == 1:
            links[candidates[0]] = j
    return links


def _same_word(source, projected, rate: float) -> bool:
    return (
        source.text == projected.text
        and abs(source.start_s - projected.start_s * rate) <= 0.001
        and abs(source.end_s - projected.end_s * rate) <= 0.001
        and source.probability == projected.probability
        and source.alignment_score == projected.alignment_score
        and source.origin == projected.origin
    )


def lyric_pitch_lines(
    transcript: Transcript, analysis: PitchAnalysis
) -> list[LyricPitchLine]:
    """Derive associations from line priors and measured words, never write them back.

    Provider ends are ownership bounds, not measured vocal endings. Notes touching
    a boundary without positive overlap do not belong to the adjacent interval.
    """
    rate = analysis.tempo_percent / 100
    result = []
    for line in ordered_lyric_lines(transcript):
        start, end = line.onset_s, line.end_s
        source = line.onset_source
        if line.canonical_line_index is not None and transcript.reference is not None:
            reference_line = transcript.reference.lines[line.canonical_line_index]
            if source == "provider-synced":
                end = reference_line.provider_end_s
            elif reference_line.status == "aligned":
                start, end, source = (
                    reference_line.start_s,
                    reference_line.end_s,
                    "acoustic",
                )
        start = (
            start / rate
            if start is not None and isfinite(start) and start >= 0
            else None
        )
        end = end / rate if end is not None and isfinite(end) and end >= 0 else None
        if start is not None and end is not None:
            end = min(end, analysis.duration_s)
            if start >= end:
                start = end = None
                source = "unknown"
        expected = tokens(line.text)
        by_token: dict[int, list[int]] = {}
        for position in line.words:
            if 0 <= position.token_index < len(
                expected
            ) and 0 <= position.word_index < len(transcript.words):
                word = transcript.words[position.word_index]
                if tokens(word.text) == [expected[position.token_index]]:
                    by_token.setdefault(position.token_index, []).append(
                        position.word_index
                    )
        anchors = {
            token: indices[0]
            for token, indices in by_token.items()
            if len(indices) == 1
        }
        # Older ASR-only records can retain measured words solely in pitch JSON.
        # Preserve only unambiguous ordered matches within their actual segment.
        if (
            not anchors
            and line.source_kind == "segment"
            and not transcript.words
            and start is not None
            and end is not None
        ):
            expected = tokens(unicodedata.normalize("NFKC", line.text))
            heard = [
                (index, word)
                for index, word in enumerate(analysis.words)
                if start <= word.start_s and word.end_s <= end
            ]
            links = _unique_word_cells(expected, [word.text for _, word in heard])
            for token, heard_index in links.items():
                anchors[token] = -heard[heard_index][0] - 1
        spans: dict[int, _WordSpan] = {}
        for token, index in anchors.items():
            if index < 0:
                word = analysis.words[-index - 1]
                spans[token] = _WordSpan(word.start_s, word.end_s, "measured", index)
            else:
                word = transcript.words[index]
                spans[token] = _WordSpan(
                    word.start_s / rate, word.end_s / rate, "measured", index
                )

        # A missing run is estimated only when both of its boundaries are known.
        # An entirely unanchored line remains a phrase, not invented words.
        if anchors:
            ordered = sorted(anchors)
            gaps = [
                (None, ordered[0]),
                *pairwise(ordered),
                (ordered[-1], None),
            ]
            for left, right in gaps:
                first = 0 if left is None else left + 1
                last = len(expected) if right is None else right
                count = last - first
                lower = start if left is None else spans[left].end_s
                upper = end if right is None else spans[right].start_s
                if count <= 0 or lower is None or upper is None or upper <= lower:
                    continue
                # An anchor outside a provider prior cannot justify extrapolation
                # across that prior or a gap extending beyond it.
                if (start is not None and lower < start) or (
                    end is not None and upper > end
                ):
                    continue
                if any(
                    span.origin == "measured"
                    and span.start_s < upper
                    and span.end_s > lower
                    for span in spans.values()
                ):
                    continue
                step = (upper - lower) / count
                for offset in range(count):
                    spans[first + offset] = _WordSpan(
                        lower + step * offset,
                        lower + step * (offset + 1),
                        "interpolated",
                        None,
                    )

        word_tracks: dict[int, list[LyricPitchTrack]] = {token: [] for token in spans}
        line_tracks = []
        for track_index, track in enumerate(analysis.tracks):
            assigned: set[int] = set()
            for token, span in sorted(spans.items()):
                if span.origin == "measured":
                    assert span.source_index is not None
                    if span.source_index < 0:
                        matching = [-span.source_index - 1]
                    else:
                        source_word = transcript.words[span.source_index]
                        matching = [
                            i
                            for i, word in enumerate(analysis.words)
                            if _same_word(source_word, word, rate)
                        ]
                        # Duplicate source identities are also ambiguous.
                        duplicates = (
                            sum(
                                _same_word(word, analysis.words[matching[0]], rate)
                                for word in transcript.words
                            )
                            if len(matching) == 1
                            else 0
                        )
                        if duplicates != 1:
                            matching = []
                    note_indices = [
                        i
                        for i, note in enumerate(track.notes)
                        if (len(matching) == 1 and matching[0] in note.word_indices)
                        or (note.start_s < span.end_s and note.end_s > span.start_s)
                    ]
                else:
                    note_indices = [
                        i
                        for i, note in enumerate(track.notes)
                        if note.start_s < span.end_s
                        and note.end_s > span.start_s
                        and (start is None or note.end_s > start)
                        and (end is None or note.start_s < end)
                    ]
                assigned.update(note_indices)
                word_tracks[token].append(LyricPitchTrack(track_index, note_indices))
            remainder = [
                i
                for i, note in enumerate(track.notes)
                if start is not None
                and end is not None
                and note.start_s < end
                and note.end_s > start
                and i not in assigned
            ]
            line_tracks.append(LyricPitchTrack(track_index, remainder))
        words = [
            LyricPitchWord(
                token, span.start_s, span.end_s, span.origin, word_tracks[token]
            )
            for token, span in sorted(spans.items())
        ]
        result.append(
            LyricPitchLine(
                line.source_kind,
                line.source_index,
                line.canonical_line_index,
                start,
                end,
                source,
                words,
                line_tracks,
            )
        )
    return result
