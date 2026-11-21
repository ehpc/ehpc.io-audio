"""Shared word-cell layout for browser, history, TXT and OpenDocument exports."""

import re
import textwrap
import unicodedata
from dataclasses import dataclass

from separator.lyric_pitch import LyricPitchLine, lyric_pitch_lines
from separator.lyrics import (
    UNKNOWN_TIMESTAMP,
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
    wide_characters: str


LINE_COLUMNS = 78


@dataclass(frozen=True)
class PitchedLyricsBlock:
    text: str
    pitch: str | None = None
    continuation: bool = False
    pitch_only: bool = False
    keep_with_next: bool = False


def _word_pairs(
    cells: list[str], pitches: list[str], prefix: str
) -> list[PitchedLyricsBlock]:
    indent = " " * display_width(prefix)
    available = LINE_COLUMNS - display_width(prefix)
    pairs: list[PitchedLyricsBlock] = []
    words: list[str] = []
    notes: list[str] = []
    used = 0

    def flush() -> None:
        nonlocal used
        if words:
            pairs.append(
                PitchedLyricsBlock(
                    (prefix if not pairs else indent) + "  ".join(words).rstrip(),
                    indent + "  ".join(notes).rstrip(),
                    continuation=bool(pairs),
                )
            )
            words.clear()
            notes.clear()
            used = 0

    for word, pitch in zip(cells, pitches, strict=True):
        width = max(display_width(word), display_width(pitch))
        if used and used + 2 + width > available:
            flush()
        words.append(word + " " * (width - display_width(word)))
        notes.append(pitch + " " * (width - display_width(pitch)))
        used += width + (2 if used else 0)
    flush()
    return pairs


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


def pitched_lyrics_document(
    transcript: Transcript,
    analysis: PitchAnalysis,
    track: PitchTrack,
    *,
    title: str | None = None,
    output_key: str | None = None,
    associations: list[LyricPitchLine] | None = None,
) -> list[PitchedLyricsBlock]:
    rate = analysis.tempo_percent / 100
    rendered: list[list[PitchedLyricsBlock]] = []
    if associations is None:
        associations = lyric_pitch_lines(transcript, analysis)
    by_source = {(line.source_kind, line.source_index): line for line in associations}
    track_index = next(
        (i for i, candidate in enumerate(analysis.tracks) if candidate is track), None
    )
    if track_index is None:
        track_index = next(
            (i for i, candidate in enumerate(analysis.tracks) if candidate == track),
            None,
        )

    def render(line: LyricDisplayLine) -> str:
        cells = re.findall(r"\S+", _printable(line.text))
        association = by_source.get((line.source_kind, line.source_index))
        token_cells = [
            cell_index for cell_index, cell in enumerate(cells) for _ in tokens(cell)
        ]
        cell_notes: dict[int, set[int]] = {}
        estimated: set[int] = set()
        if association is not None and track_index is not None:
            for word in association.words:
                if word.token_index >= len(token_cells):
                    continue
                cell_index = token_cells[word.token_index]
                cell_notes.setdefault(cell_index, set()).update(
                    word.tracks[track_index].note_indices
                )
                if word.origin == "interpolated":
                    estimated.add(cell_index)
        pitches = [
            ("~" if index in estimated else "")
            + " ".join(track.notes[note].note for note in sorted(cell_notes[index]))
            if cell_notes.get(index)
            else "?"
            for index in range(len(cells))
        ]
        residual = (
            association.tracks[track_index].note_indices
            if association is not None and track_index is not None
            else []
        )
        # NUL cannot occur in printable word cells. Placeholders let the common
        # transcript exporter retain sole ownership of metadata/section order.
        onset = line.onset_s
        if line.canonical_line_index is None and onset is None:
            onset = line.start_s
        prefix = (
            format_timestamp(onset / rate)
            if onset is not None
            else UNKNOWN_TIMESTAMP
            if line.canonical_line_index is not None
            else line.prefix
        )
        rows = []
        if residual:
            labels = " ".join(track.notes[index].note for index in residual)
            rows = textwrap.wrap(
                f"Line pitches (approx.): {labels}",
                width=LINE_COLUMNS,
                subsequent_indent="  ",
                break_long_words=False,
                break_on_hyphens=False,
            )
        if association is not None and not association.words and residual:
            lyric_rows = _word_pairs(cells, [""] * len(cells), f"[{prefix}] ")
            blocks = [PitchedLyricsBlock(row, pitch_only=True) for row in rows[:-1]]
            blocks.append(
                PitchedLyricsBlock(
                    lyric_rows[0].text, rows[-1], keep_with_next=len(lyric_rows) > 1
                )
            )
            blocks.extend(
                PitchedLyricsBlock(
                    row.text,
                    continuation=True,
                    keep_with_next=index < len(lyric_rows) - 1,
                )
                for index, row in enumerate(lyric_rows[1:], start=1)
            )
        else:
            blocks = [PitchedLyricsBlock(row, pitch_only=True) for row in rows]
            blocks.extend(_word_pairs(cells, pitches, f"[{prefix}] "))
        rendered.append(blocks)
        return f"\0{len(rendered) - 1}\0"

    body = transcript_export_text(
        transcript,
        render,
        analysis.tempo_percent,
        title=title,
        output_key=output_key,
    )
    if transcript.status == "empty" and not (
        transcript.reference is not None and transcript.reference.lines
    ):
        body += "[No lyrics recognized or aligned.]\n"
    blocks: list[PitchedLyricsBlock] = []
    for index, part in enumerate(re.split(r"\0(\d+)\0", body)):
        if index % 2:
            blocks.extend(rendered[int(part)])
        else:
            blocks.extend(
                PitchedLyricsBlock(_printable(line))
                for line in part.splitlines()
                if line.strip()
            )
    return blocks


def pitched_lyrics_text(
    transcript: Transcript,
    analysis: PitchAnalysis,
    track: PitchTrack,
    *,
    title: str | None = None,
    output_key: str | None = None,
    associations: list[LyricPitchLine] | None = None,
) -> str:
    return "".join(
        f"{block.pitch}\n{block.text}\n\n"
        if block.pitch is not None
        else f"{block.text}\n"
        for block in pitched_lyrics_document(
            transcript,
            analysis,
            track,
            title=title,
            output_key=output_key,
            associations=associations,
        )
    )


def pitched_lyrics_tracks(
    transcript: Transcript,
    analysis: PitchAnalysis,
    *,
    title: str | None = None,
    output_key: str | None = None,
    associations: list[LyricPitchLine] | None = None,
) -> list[PitchedLyricsTrack]:
    if associations is None:
        associations = lyric_pitch_lines(transcript, analysis)
    tracks = []
    for track in analysis.tracks:
        text = pitched_lyrics_text(
            transcript,
            analysis,
            track,
            title=title,
            output_key=output_key,
            associations=associations,
        )
        # Font-fallback correction uses the very same Unicode width authority
        # as text padding, rather than introducing browser-side Unicode tables.
        wide = "".join(sorted(char for char in set(text) if display_width(char) == 2))
        tracks.append(PitchedLyricsTrack(track.label, text, wide))
    return tracks
