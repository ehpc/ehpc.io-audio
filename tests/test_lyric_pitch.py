import io
import zipfile
from dataclasses import replace
from xml.etree import ElementTree

from fastapi.testclient import TestClient

from backend import db
from separator.lyric_pitch import lyric_pitch_lines
from separator.lyrics import (
    CanonicalWordPosition,
    Transcript,
    TranscriptSegment,
    TranscriptWord,
    transcript_export_text,
)
from separator.lyrics_reference import ReferenceLine, ReferenceReview
from separator.pitch import PitchAnalysis, PitchNote, PitchTrack, pitch_to_json
from separator.pitched_lyrics import pitched_lyrics_text
from tests.pitched_lyrics_odt_fixture import odf_text


def note(
    start: float, end: float, midi: int, words: list[int] | None = None
) -> PitchNote:
    return PitchNote(start, end, midi, 440, 0.8, word_indices=words or [])


def fixture() -> tuple[Transcript, PitchAnalysis]:
    reference = ReferenceReview(
        "matched",
        "synthetic",
        duration_s=20,
        provider_timing_status="validated",
        lines=[
            ReferenceLine("red green blue", provider_start_s=2, provider_end_s=8),
            ReferenceLine("red green blue", provider_start_s=12, provider_end_s=18),
        ],
    )
    word = TranscriptWord(
        4, 5, "green", alignment_score=0.7, origin="reference-aligned"
    )
    transcript = Transcript(
        words=[word],
        reference=reference,
        canonical_word_positions=[CanonicalWordPosition(0, 0, 1)],
    )
    analysis = PitchAnalysis(
        20,
        10,
        [
            PitchTrack(
                "lead",
                [
                    note(0.9, 1.2, 60),
                    note(1.8, 2.2, 62, [0]),
                    note(2.6, 3, 64),
                    note(3.9, 4.2, 65),
                    note(5, 5.5, 67),
                    note(5.9, 6.2, 69),
                ],
            ),
            PitchTrack("backing", [note(6.5, 7, 71)]),
        ],
        words=[replace(word, start_s=2, end_s=2.5)],
        tempo_percent=200,
    )
    return transcript, analysis


def test_partial_and_unanchored_lines_separate_tracks_and_bounds() -> None:
    transcript, analysis = fixture()
    original_text = transcript_export_text(transcript)
    original_pitch = pitch_to_json(analysis)
    lines = lyric_pitch_lines(transcript, analysis)
    first, second = lines
    assert (first.start_s, first.end_s, first.bounds_source) == (
        1,
        4,
        "provider-synced",
    )
    assert [
        (word.token_index, word.start_s, word.end_s, word.origin)
        for word in first.words
    ] == [
        (0, 1, 2, "interpolated"),
        (1, 2, 2.5, "measured"),
        (2, 2.5, 4, "interpolated"),
    ]
    assert [word.tracks[0].note_indices for word in first.words] == [
        [0, 1],
        [1],
        [2, 3],
    ]
    assert first.tracks[0].note_indices == []
    assert second.words == []
    assert second.tracks[0].note_indices == [5]
    assert second.tracks[1].note_indices == [0]
    # Provider's explicit blank break 4..6 remains unassigned.
    assert all(4 not in line.tracks[0].note_indices for line in lines)
    assert transcript_export_text(transcript) == original_text
    assert pitch_to_json(analysis) == original_pitch
    rendered = pitched_lyrics_text(transcript, analysis, analysis.tracks[0])
    assert "~C4 D4" in rendered
    assert "Line pitches (approx.): A4" in rendered
    assert "G4" not in rendered


def test_half_open_boundary_sustain_and_residual_for_asr_segment() -> None:
    transcript = Transcript(
        segments=[
            TranscriptSegment(1, 3, "first phrase"),
            TranscriptSegment(3, 5, "next phrase"),
        ]
    )
    analysis = PitchAnalysis(
        6,
        6,
        [PitchTrack("lead", [note(0.5, 1, 60), note(2.5, 3.5, 62), note(5, 5.5, 64)])],
    )
    lines = lyric_pitch_lines(transcript, analysis)
    assert [line.words for line in lines] == [[], []]
    assert [line.tracks[0].note_indices for line in lines] == [[1], [1]]
    assert all(line.bounds_source == "acoustic" for line in lines)


def test_outside_anchor_is_kept_and_unknown_edges_allow_interior_only() -> None:
    words = [
        TranscriptWord(1, 2, "a", alignment_score=0.9),
        TranscriptWord(4, 5, "c", alignment_score=0.8),
    ]
    transcript = Transcript(
        words=words,
        reference=ReferenceReview(
            "matched", "synthetic", lines=[ReferenceLine("a b c d")]
        ),
        canonical_word_positions=[
            CanonicalWordPosition(0, 0, 0),
            CanonicalWordPosition(1, 0, 2),
        ],
    )
    analysis = PitchAnalysis(
        8,
        8,
        [
            PitchTrack(
                "lead", [note(1, 2, 60, [0]), note(3, 4, 62), note(4, 5, 64, [1])]
            )
        ],
        words=words,
    )
    line = lyric_pitch_lines(transcript, analysis)[0]
    assert line.end_s is None
    assert [(word.token_index, word.origin) for word in line.words] == [
        (0, "measured"),
        (1, "interpolated"),
        (2, "measured"),
    ]
    assert line.words[1].tracks[0].note_indices == [1]
    assert line.words[0].tracks[0].note_indices == [0]
    assert line.words[2].tracks[0].note_indices == [2]


def test_saved_job_api_txt_and_odt_share_line_projection(client: TestClient) -> None:
    transcript, analysis = fixture()
    response = client.post(
        "/api/jobs",
        data={"url": "https://example.org/synthetic", "extract_pitched_lyrics": "true"},
    )
    job_id = response.json()["id"]
    stored_pitch = pitch_to_json(analysis)
    db.mark_done(job_id, [], transcript, stored_pitch)
    payload = client.get(f"/api/jobs/{job_id}").json()
    assert payload["lyric_pitch_lines"][1]["tracks"][0]["note_indices"] == [5]
    assert payload["lyric_pitch_lines"][0]["words"][0]["origin"] == "interpolated"
    path = f"/api/jobs/{job_id}/pitched-lyrics/lead/download"
    txt = client.get(path).text
    assert txt == payload["pitched_lyrics"][0]["text"]
    odt = client.get(path, params={"format": "odt"}).content
    with zipfile.ZipFile(io.BytesIO(odt)) as archive:
        content = ElementTree.fromstring(archive.read("content.xml"))
    assert "Line pitches (approx.): A4" in odf_text(content)
    job = db.get_job(job_id)
    assert job is not None
    assert job.transcript == transcript and job.pitch_json == stored_pitch


def test_outside_prior_keeps_measured_word_and_skips_invalid_estimate() -> None:
    word = TranscriptWord(1, 1.5, "middle", alignment_score=0.8)
    transcript = Transcript(
        words=[word],
        reference=ReferenceReview(
            "matched",
            "synthetic",
            duration_s=10,
            provider_timing_status="validated",
            lines=[
                ReferenceLine(
                    "before middle after", provider_start_s=2, provider_end_s=6
                )
            ],
        ),
        canonical_word_positions=[CanonicalWordPosition(0, 0, 1)],
    )
    analysis = PitchAnalysis(
        10,
        10,
        [PitchTrack("lead", [note(1, 1.5, 60, [0]), note(3, 4, 62)])],
        words=[word],
    )
    line = lyric_pitch_lines(transcript, analysis)[0]
    assert [(w.token_index, w.start_s, w.end_s, w.origin) for w in line.words] == [
        (1, 1, 1.5, "measured")
    ]
    assert line.words[0].tracks[0].note_indices == [0]
    assert line.tracks[0].note_indices == [1]


def test_repeated_extra_occurrences_keep_distinct_pitch_tracks_in_export() -> None:
    transcript = Transcript(
        reference=ReferenceReview(
            "matched", "synthetic", lines=[ReferenceLine("main")]
        ),
        asr_extras=[
            TranscriptSegment(1, 2, "echo"),
            TranscriptSegment(4, 5, "echo"),
        ],
    )
    analysis = PitchAnalysis(
        6, 6, [PitchTrack("lead", [note(1, 2, 60), note(4, 5, 62)])]
    )
    projections = lyric_pitch_lines(transcript, analysis)
    assert [
        (p.source_index, p.tracks[0].note_indices)
        for p in projections
        if p.source_kind == "asr-extra"
    ] == [(0, [0]), (1, [1])]
    text = pitched_lyrics_text(transcript, analysis, analysis.tracks[0])
    assert "Line pitches (approx.): C4\n[00:01] echo" in text
    assert "Line pitches (approx.): D4\n[00:04] echo" in text


def test_known_word_receives_overlapping_pitch_without_stored_word_links() -> None:
    word = TranscriptWord(1, 2, "known", alignment_score=0.8)
    transcript = Transcript(
        words=[word],
        reference=ReferenceReview(
            "matched",
            "synthetic",
            duration_s=5,
            provider_timing_status="validated",
            lines=[ReferenceLine("known", provider_start_s=0.5, provider_end_s=3)],
        ),
        canonical_word_positions=[CanonicalWordPosition(0, 0, 0)],
    )
    analysis = PitchAnalysis(
        5,
        5,
        [PitchTrack("lead", [note(0.5, 1, 60), note(1.2, 1.8, 62), note(2, 2.5, 64)])],
    )
    line = lyric_pitch_lines(transcript, analysis)[0]
    assert line.words[0].origin == "measured"
    assert line.words[0].tracks[0].note_indices == [1]
    assert line.tracks[0].note_indices == [0, 2]
    assert "D4" in pitched_lyrics_text(transcript, analysis, analysis.tracks[0])


def test_conflicting_anchor_order_does_not_generate_overlapping_estimates() -> None:
    words = [
        TranscriptWord(1, 2, "earlier"),
        TranscriptWord(3, 4, "later"),
    ]
    transcript = Transcript(
        words=words,
        reference=ReferenceReview(
            "matched",
            "synthetic",
            duration_s=7,
            provider_timing_status="validated",
            lines=[
                ReferenceLine(
                    "later middle earlier end", provider_start_s=0, provider_end_s=6
                )
            ],
        ),
        canonical_word_positions=[
            CanonicalWordPosition(1, 0, 0),
            CanonicalWordPosition(0, 0, 2),
        ],
    )
    analysis = PitchAnalysis(
        7, 7, [PitchTrack("lead", [note(1, 2, 60), note(3, 4, 62)])]
    )
    line = lyric_pitch_lines(transcript, analysis)[0]
    assert [
        (word.token_index, word.start_s, word.end_s, word.origin) for word in line.words
    ] == [
        (0, 3, 4, "measured"),
        (2, 1, 2, "measured"),
    ]
    assert line.words[0].tracks[0].note_indices == [1]
    assert line.words[1].tracks[0].note_indices == [0]
