"""Word-cell pitch text; one renderer for browser, history and TXT downloads."""

import re
import unicodedata
from dataclasses import dataclass

from separator.lyrics import (
    LyricDisplayLine,
    Transcript,
    format_timestamp,
    transcript_export_text,
)
from separator.lyrics_reference import tokens
from separator.pitch import PitchAnalysis, PitchTrack


@dataclass(frozen=True)
class PitchedLyricsTrack:
    label: str
    text: str


def display_width(text: str) -> int:
    """Columns for lyric scripts: combining marks zero, East Asian wide/full two.

    This is deliberately not an emoji/grapheme terminal emulator. Lyric word
    cells preserve Unicode verbatim; controls are replaced before measurement.
    """
    return sum(
        0
        if unicodedata.combining(char)
        or unicodedata.category(char) in {"Mn", "Me", "Cf"}
        else 2
        if unicodedata.east_asian_width(char) in {"W", "F"}
        else 1
        for char in text
    )


def _printable(text: str) -> str:
    return "".join(" " if unicodedata.category(c) == "Cc" else c for c in text)


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


def pitched_lyrics_text(
    transcript: Transcript, analysis: PitchAnalysis, track: PitchTrack
) -> str:
    rate = analysis.tempo_percent / 100

    def render(line: LyricDisplayLine) -> str:
        cells = re.findall(r"\S+", _printable(line.text))
        aligned = [
            (index, word)
            for index, word in enumerate(analysis.words)
            if line.start_s is not None
            and line.end_s is not None
            and word.start_s * rate >= line.start_s - 0.001
            and word.end_s * rate <= line.end_s + 0.001
        ]
        cell_words: dict[int, set[int]] = {}
        if line.canonical_line_index is not None:
            # Stable source provenance, never text matching against a filtered
            # word subset. Old records without positions remain explicit '?'.
            token_cells = [
                cell_index
                for cell_index, cell in enumerate(cells)
                for _ in tokens(cell)
            ]
            canonical_tokens = tokens(line.text)
            for position in transcript.canonical_word_positions:
                if (
                    position.reference_line_index != line.canonical_line_index
                    or position.word_index >= len(analysis.words)
                    or position.reference_token_index >= len(token_cells)
                    or line.start_s is None
                    or line.end_s is None
                ):
                    continue
                word = analysis.words[position.word_index]
                source_word = transcript.words[position.word_index]
                if (
                    word.text != source_word.text
                    or abs(word.start_s * rate - source_word.start_s) > 0.001
                    or tokens(word.text)
                    != [canonical_tokens[position.reference_token_index]]
                ):
                    continue
                cell_index = token_cells[position.reference_token_index]
                cell_words.setdefault(cell_index, set()).add(position.word_index)
            cell_words = {
                cell_index: word_indices
                for cell_index, word_indices in cell_words.items()
                if len(word_indices) == token_cells.count(cell_index)
            }
        else:
            links = _unique_word_cells(cells, [word.text for _, word in aligned])
            cell_words = {cell: {aligned[linked][0]} for cell, linked in links.items()}
        pitches = []
        for index in range(len(cells)):
            word_indices = cell_words.get(index, set())
            labels = [
                note.note
                for note in track.notes
                if word_indices.intersection(note.word_indices)
            ]
            pitches.append(" ".join(labels) if labels else "?")
        widths = [
            max(display_width(word), display_width(pitch))
            for word, pitch in zip(cells, pitches, strict=True)
        ]

        def row(values: list[str]) -> str:
            return "  ".join(
                value + " " * (width - display_width(value))
                for value, width in zip(values, widths, strict=True)
            ).rstrip()

        prefix = (
            format_timestamp(line.start_s / rate)
            if line.start_s is not None
            else line.prefix
        )
        return f"[{prefix}]\n{row(pitches)}\n{row(cells)}\n\n"

    shift = analysis.pitch_shift_semitones
    body = transcript_export_text(transcript, render, analysis.tempo_percent)
    if transcript.status == "empty" and not (
        transcript.reference is not None and transcript.reference.lines
    ):
        body += "[No lyrics recognized or aligned.]\n"
    return (
        f"[Lyrics with pitches — vocal stem: {track.label}; "
        f"output projection {shift:+g} semitones; "
        f"tempo {analysis.tempo_percent:g}%]\n"
        "[Timestamps: output audio clock, start only; "
        "source-estimated pitch projected, NOT re-measured]\n"
        "[Individual note names rounded to nearest semitone, not song key; "
        "? = unknown alignment/no detected pitch, NOT a rest]\n"
        "[Approximate full-vocal words, not syllables/independent split voices; "
        "multiple notes preserve melisma/repeated detections]\n\n" + body
    )


def pitched_lyrics_tracks(
    transcript: Transcript, analysis: PitchAnalysis
) -> list[PitchedLyricsTrack]:
    return [
        PitchedLyricsTrack(
            track.label, pitched_lyrics_text(transcript, analysis, track)
        )
        for track in analysis.tracks
    ]
