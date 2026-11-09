from xml.etree import ElementTree as ET

from separator.lyrics import Transcript, TranscriptSegment, TranscriptWord
from separator.pitch import (
    PitchAnalysis,
    PitchNote,
    PitchTrack,
    transform_analysis,
)
from separator.pitched_lyrics_odt import NS


def odf_text(element: ET.Element) -> str:
    result = element.text or ""
    for child in element:
        if child.tag == f"{{{NS['text']}}}s":
            result += " " * int(child.get(f"{{{NS['text']}}}c", "1"))
        elif child.tag == f"{{{NS['text']}}}line-break":
            result += "\n"
        else:
            result += odf_text(child)
        result += child.tail or ""
    return result


def document_fixture(count: int = 90) -> tuple[Transcript, PitchAnalysis]:
    """Synthetic multi-page typography fixture, never recognition evidence."""
    segments = []
    words = []
    notes = []
    for index in range(count):
        start = 6000 + index * 60
        cells = [f"pair{index:03d}", "cafe\u0301", "星光", "мир", "[echo]", "safe<&>"]
        if index % 7 == 0:
            cells += [f"word{number:02d}" for number in range(24)]
        segments.append(TranscriptSegment(start, start + len(cells), " ".join(cells)))
        for position, cell in enumerate(cells):
            word_start = start + position
            words.append(TranscriptWord(word_start, word_start + 0.9, cell))
            notes.append(
                PitchNote(word_start, word_start + 0.4, 60 + position % 5, 261, 0.9)
            )
            if position == 0:
                notes.append(
                    PitchNote(word_start + 0.4, word_start + 0.9, 62, 294, 0.9)
                )
    transcript = Transcript(segments=segments, words=words)
    analysis = transform_analysis(
        PitchAnalysis(
            12000, 12000, [PitchTrack("lead", notes), PitchTrack("backing", [])]
        ),
        0,
        100,
        words,
    )
    return transcript, analysis
