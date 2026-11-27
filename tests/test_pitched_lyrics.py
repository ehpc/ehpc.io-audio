import asyncio
import io
import json
import re
import zipfile
from dataclasses import replace
from urllib.parse import unquote
from xml.etree import ElementTree

import pytest
from fastapi.testclient import TestClient

from backend import db, queue
from separator.lyric_pitch import lyric_pitch_lines
from separator.lyrics import (
    CanonicalWordPosition,
    Transcript,
    TranscriptSection,
    TranscriptSegment,
    TranscriptWord,
)
from separator.lyrics_reference import ReferenceLine, ReferenceReview, apply_reference
from separator.options import SeparationOptions
from separator.pitch import (
    PitchAnalysis,
    PitchNote,
    PitchTrack,
    pitch_to_json,
    transform_analysis,
)
from separator.pitched_lyrics import (
    display_width,
    pitched_lyrics_document,
    pitched_lyrics_text,
)
from separator.pitched_lyrics_odt import pitched_lyrics_odt
from separator.processing import ProcessingResult
from tests.pitched_lyrics_odt_fixture import odf_text


def singing() -> tuple[Transcript, PitchAnalysis]:
    words = [TranscriptWord(2, 4, "Cœur"), TranscriptWord(4, 5, "поёт")]
    transcript = Transcript(
        segments=[TranscriptSegment(2, 5, "Cœur поёт")],
        words=words,
        sections=[TranscriptSection(0, 8, "verse")],
        word_alignment="torchaudio/MMS_FA",
    )
    notes = [
        PitchNote(2, 2.8, 60, 261.625565, 0.9),
        PitchNote(2.9, 3.4, 60, 261.625565, 0.9),
        PitchNote(3.4, 4, 62, 293.664768, 0.9),
        PitchNote(6, 7, 69, 440, 0.9),  # Unlinked notes must never appear over words.
    ]
    analysis = transform_analysis(
        PitchAnalysis(8, 8, [PitchTrack("lead", notes), PitchTrack("backing", [])]),
        1.25,
        125,
        words,
        transcript.word_alignment,
    )
    return transcript, analysis


def test_pitch_name_runs_compress_per_word_and_match_txt_odt() -> None:
    words = [TranscriptWord(1, 5, "first"), TranscriptWord(6, 9, "second")]
    transcript = Transcript(
        segments=[TranscriptSegment(1, 9, "first second")], words=words
    )
    semitones = [60, 60, 62, 62, 60, 72, 72, 72, 72]
    times = [
        (1, 1.4),
        (1.5, 1.9),
        (2, 2.4),
        (2.5, 2.9),
        (3, 3.4),
        (3.5, 3.9),
        (4, 4.4),
        (6.2, 6.4),
        (6.5, 6.8),
    ]
    notes = [
        PitchNote(start, end, semitone, 261.625565, 0.9)
        for (start, end), semitone in zip(times, semitones, strict=True)
    ]
    analysis = transform_analysis(
        PitchAnalysis(10, 10, [PitchTrack("lead", notes)]), 0, 100, words
    )
    original_pitch = pitch_to_json(analysis)
    associations = lyric_pitch_lines(transcript, analysis)
    assert [word.tracks[0].note_indices for word in associations[0].words] == [
        list(range(7)),
        [7, 8],
    ]

    blocks = pitched_lyrics_document(
        transcript, analysis, analysis.tracks[0], associations=associations
    )
    text = pitched_lyrics_text(
        transcript, analysis, analysis.tracks[0], associations=associations
    )
    rows = text.splitlines()
    start = next(index for index, row in enumerate(rows) if row.startswith("[00:01] "))
    expected_names = ["C4", "D4", "C4", "C5", "C5"]
    assert rows[start - 1].split() == expected_names

    with zipfile.ZipFile(io.BytesIO(pitched_lyrics_odt(blocks))) as archive:
        root = ElementTree.fromstring(archive.read("content.xml"))
    paragraphs = root.findall(".//{urn:oasis:names:tc:opendocument:xmlns:text:1.0}p")
    visible = " ".join(odf_text(paragraph) for paragraph in paragraphs)
    assert re.findall(r"[A-G]#?[0-9]+", visible) == expected_names
    assert pitch_to_json(analysis) == original_pitch


def test_residual_line_pitch_sequence_collapses_only_consecutive_names() -> None:
    transcript = Transcript(segments=[TranscriptSegment(1, 5, "unanchored phrase")])
    semitones = [60, 60, 62, 62, 60, 72, 72]
    notes = [
        PitchNote(1 + index * 0.5, 1.25 + index * 0.5, semitone, 261.6, 0.9)
        for index, semitone in enumerate(semitones)
    ]
    analysis = PitchAnalysis(6, 6, [PitchTrack("lead", notes)])
    original_pitch = pitch_to_json(analysis)
    associations = lyric_pitch_lines(transcript, analysis)
    assert associations[0].tracks[0].note_indices == list(range(7))

    blocks = pitched_lyrics_document(
        transcript, analysis, analysis.tracks[0], associations=associations
    )
    text = pitched_lyrics_text(
        transcript, analysis, analysis.tracks[0], associations=associations
    )
    pitch_row = next(row for row in text.splitlines() if row.startswith("[line] "))
    expected_names = ["C4", "D4", "C4", "C5"]
    assert pitch_row.removeprefix("[line] ").split() == expected_names
    with zipfile.ZipFile(io.BytesIO(pitched_lyrics_odt(blocks))) as archive:
        root = ElementTree.fromstring(archive.read("content.xml"))
    paragraphs = root.findall(".//{urn:oasis:names:tc:opendocument:xmlns:text:1.0}p")
    visible = " ".join(odf_text(paragraph) for paragraph in paragraphs)
    assert re.findall(r"[A-G]#?[0-9]+", visible) == expected_names
    assert pitch_to_json(analysis) == original_pitch


def test_consecutive_note_names_compress_without_changing_raw_notes() -> None:
    transcript, analysis = singing()
    original_pitch = pitch_to_json(analysis)
    associations = lyric_pitch_lines(transcript, analysis)
    text = pitched_lyrics_text(
        transcript, analysis, analysis.tracks[0], associations=associations
    )
    rows = text.splitlines()
    start = next(index for index, row in enumerate(rows) if row.startswith("[00:01] "))
    assert rows[start - 1] == "        C#4 D#4  ?"
    assert rows[start].split()[1:] == ["Cœur", "поёт"]
    assert associations[0].words[0].tracks[0].note_indices == [0, 1, 2]
    assert pitch_to_json(analysis) == original_pitch
    assert display_width(rows[start - 1].split("  ?")[0]) + 2 == display_width(
        rows[start].split("поёт")[0]
    )
    assert "A#4" not in text
    assert "[Verse]" in text
    assert analysis.tracks[0].notes[0].start_s == 1.6
    assert analysis.words[0].start_s == 1.6
    assert "[00:02]" not in text
    assert "        ?     ?\n[00:01] Cœur  поёт\n" in pitched_lyrics_text(
        transcript, analysis, analysis.tracks[1]
    )


def test_pitched_txt_head_is_identity_and_transposed_tonality() -> None:
    transcript, analysis = singing()
    text = pitched_lyrics_text(
        transcript,
        analysis,
        analysis.tracks[0],
        title="Cœur.wav",
        output_key="D minor",
    )
    assert text.startswith("Cœur.wav\nTonality: D minor\n")
    plain = pitched_lyrics_text(
        transcript, analysis, analysis.tracks[0], title="Cœur.wav"
    )
    assert plain.startswith("Cœur.wav\n[")
    assert "Tonality" not in plain


def test_empty_lyrics_do_not_assign_unlinked_notes_to_fake_words() -> None:
    transcript = Transcript(sections=[TranscriptSection(0, 5, "inst")])
    analysis = PitchAnalysis(
        5, 5, [PitchTrack("vocals", [PitchNote(1, 2, 60, 261, 0.9)])]
    )
    text = pitched_lyrics_text(transcript, analysis, analysis.tracks[0])
    assert text == pitched_lyrics_text(transcript, analysis, PitchTrack("vocals", []))
    assert "[Instrumental]" in text
    assert "C4" not in text
    assert "[00:01]" not in text


def test_canonical_order_disputed_repeats_and_unconfirmed_lines_are_not_guessed() -> (
    None
):
    transcript = Transcript(
        words=[
            TranscriptWord(2, 3, "glow", origin="reference-aligned"),
            TranscriptWord(4, 5, "stars", origin="reference-aligned"),
        ],
        reference=ReferenceReview(
            "partial",
            "Synthetic",
            provider="Synthetic test",
            lines=[
                ReferenceLine("Untimed opening"),
                ReferenceLine(
                    "glow glow stars",
                    "aligned",
                    start_s=1,
                    end_s=5,
                    unconfirmed_words=["glow"],
                    recognized_variant="variant",
                ),
                ReferenceLine("Untimed ending"),
            ],
        ),
        canonical_word_positions=[CanonicalWordPosition(1, 1, 2)],
    )
    analysis = transform_analysis(
        PitchAnalysis(
            8,
            8,
            [
                PitchTrack(
                    "vocals",
                    [
                        PitchNote(2, 3, 60, 261.625565, 0.9),
                        PitchNote(4, 5, 62, 293.664768, 0.9),
                    ],
                )
            ],
        ),
        0,
        100,
        transcript.words,
    )
    text = pitched_lyrics_text(transcript, analysis, analysis.tracks[0])
    assert (
        text.index("Untimed  opening")
        < text.index("glow  glow  stars")
        < text.index("Untimed  ending")
    )
    projected = lyric_pitch_lines(transcript, analysis)[1]
    assert [word.origin for word in projected.words] == [
        "interpolated",
        "interpolated",
        "measured",
    ]
    assert projected.words[-1].tracks[0].note_indices == [1]
    assert "~C4" in text
    assert text.count("[??:??]") == 3
    assert "Reference line" not in text and "UNCONFIRMED" not in text
    assert "variant" not in text
    assert projected.words[0].tracks[0].note_indices == [0]


def test_incomplete_repeated_word_alignment_is_ambiguous_even_without_metadata() -> (
    None
):
    transcript = Transcript(segments=[TranscriptSegment(1, 4, "go go home")])
    analysis = transform_analysis(
        PitchAnalysis(
            5,
            5,
            [
                PitchTrack(
                    "vocals",
                    [PitchNote(1, 2, 60, 261, 0.9), PitchNote(3, 4, 62, 294, 0.9)],
                )
            ],
        ),
        0,
        100,
        [TranscriptWord(1, 2, "go"), TranscriptWord(3, 4, "home")],
    )
    line = lyric_pitch_lines(transcript, analysis)[0]
    assert [word.origin for word in line.words] == [
        "interpolated",
        "interpolated",
        "measured",
    ]
    assert line.words[-1].tracks[0].note_indices == [1]
    assert "~C4" in pitched_lyrics_text(transcript, analysis, analysis.tracks[0])


def test_unicode_column_padding_preserves_combining_cyrillic_and_wide_cells() -> None:
    transcript = Transcript(segments=[TranscriptSegment(1, 4, "e\u0301 星光 мир")])
    words = [
        TranscriptWord(1, 2, "é"),
        TranscriptWord(2, 3, "星光"),
        TranscriptWord(3, 4, "мир"),
    ]
    analysis = transform_analysis(
        PitchAnalysis(5, 5, [PitchTrack("vocals", [PitchNote(3, 4, 60, 261, 0.9)])]),
        0,
        100,
        words,
    )
    text = pitched_lyrics_text(transcript, analysis, analysis.tracks[0])
    assert display_width("e\u0301") == display_width("é") == 1
    assert display_width("星光") == 4
    assert "        ?  ?     C4\n[00:01] e\u0301  星光  мир\n" in text


def test_reference_positions_survive_repeated_tokens_and_extras_sort() -> None:
    words = [
        TranscriptWord(0.1, 0.5, "hey", alignment_score=0.9),
        TranscriptWord(1, 2, "glow", alignment_score=0.9),
        TranscriptWord(2, 3, "glow", alignment_score=0.9),
        TranscriptWord(3, 4, "stars", alignment_score=0.9),
    ]
    source = Transcript(words=words)
    review = ReferenceReview(
        "matched", "Synthetic", lines=[ReferenceLine("glow glow stars")]
    )
    candidate = [
        TranscriptWord(1, 2, "glow", alignment_score=0.01),
        TranscriptWord(2, 3, "glow", alignment_score=0.9),
        TranscriptWord(3, 4, "stars", alignment_score=0.9),
    ]
    transcript = apply_reference(source, review, {0: candidate})
    assert [word.text for word in transcript.words] == ["hey", "glow", "stars"]
    assert transcript.canonical_word_positions == [
        CanonicalWordPosition(1, 0, 1),
        CanonicalWordPosition(2, 0, 2),
    ]
    analysis = transform_analysis(
        PitchAnalysis(
            5,
            5,
            [
                PitchTrack(
                    "lead",
                    [
                        PitchNote(1, 2, 59, 247, 0.9),
                        PitchNote(2, 3, 60, 261, 0.9),
                        PitchNote(3, 4, 62, 294, 0.9),
                    ],
                )
            ],
        ),
        0,
        100,
        transcript.words,
    )
    text = pitched_lyrics_text(transcript, analysis, analysis.tracks[0])
    projected = lyric_pitch_lines(transcript, analysis)[0]
    assert [word.origin for word in projected.words] == [
        "interpolated",
        "measured",
        "measured",
    ]
    assert [word.tracks[0].note_indices for word in projected.words] == [[0], [1], [2]]
    assert "~B3" in text
    legacy = Transcript(words=transcript.words, reference=transcript.reference)
    legacy_text = pitched_lyrics_text(legacy, analysis, analysis.tracks[0])
    assert lyric_pitch_lines(legacy, analysis)[0].words == []
    assert "C4" in legacy_text


def test_canonical_ids_use_exact_tokenization_for_decomposed_word_cells() -> None:
    # Existing reference tokenization splits the combining-mark word internally;
    # display keeps it one intact whole-word cell, without shifting later IDs.
    text = "cafe\u0301ine glow glow"
    words = [
        TranscriptWord(1, 2, "cafe", origin="reference-aligned"),
        TranscriptWord(2, 3, "ine", origin="reference-aligned"),
        TranscriptWord(4, 5, "glow", origin="reference-aligned"),
    ]
    transcript = Transcript(
        words=words,
        reference=ReferenceReview(
            "partial",
            "Synthetic",
            lines=[ReferenceLine(text, "aligned", start_s=1, end_s=5)],
        ),
        canonical_word_positions=[
            CanonicalWordPosition(0, 0, 0),
            CanonicalWordPosition(1, 0, 1),
            CanonicalWordPosition(2, 0, 3),
        ],
    )
    analysis = transform_analysis(
        PitchAnalysis(
            6,
            6,
            [
                PitchTrack(
                    "lead",
                    [
                        PitchNote(1, 2, 60, 261, 0.9),
                        PitchNote(2, 3, 62, 294, 0.9),
                        PitchNote(4, 5, 64, 330, 0.9),
                    ],
                )
            ],
        ),
        0,
        100,
        words,
    )
    rendered = pitched_lyrics_text(transcript, analysis, analysis.tracks[0])
    assert "        C4 D4    ?     E4\n[00:01] cafe\u0301ine  glow  glow\n" in rendered
    assert display_width("cafe\u0301ine") == 7


def test_provider_onset_and_partial_acoustic_word_reach_txt_and_odt() -> None:
    words = [TranscriptWord(5, 6, "stars", origin="reference-aligned")]
    transcript = Transcript(
        words=words,
        reference=ReferenceReview(
            "partial",
            "Validated provider timing",
            duration_s=10,
            provider_timing_status="validated",
            lines=[
                ReferenceLine(
                    "shine stars tonight",
                    "aligned",
                    start_s=5,
                    end_s=6,
                    provider_start_s=2.5,
                    provider_end_s=7,
                ),
                ReferenceLine("silent sky", provider_start_s=7, provider_end_s=10),
            ],
        ),
        canonical_word_positions=[CanonicalWordPosition(0, 0, 1)],
    )
    analysis = transform_analysis(
        PitchAnalysis(
            10,
            10,
            [PitchTrack("vocals", [PitchNote(5, 6, 60, 261, 0.9)])],
        ),
        0,
        125,
        words,
    )
    track = analysis.tracks[0]
    text = pitched_lyrics_text(transcript, analysis, track)
    assert "        ?      C4     ?\n[00:02] shine  stars  tonight\n" in text
    assert "        ?       ?\n[00:05] silent  sky\n" in text
    assert "[00:04]" not in text

    odt = pitched_lyrics_odt(pitched_lyrics_document(transcript, analysis, track))
    with zipfile.ZipFile(io.BytesIO(odt)) as archive:
        root = ElementTree.fromstring(archive.read("content.xml"))
    paragraphs = root.findall(".//{urn:oasis:names:tc:opendocument:xmlns:text:1.0}p")
    visible = ["".join(paragraph.itertext()) for paragraph in paragraphs]
    assert any("?C4?[00:02]shinestarstonight" in line for line in visible)
    assert any("??[00:05]silentsky" in line for line in visible)


def test_stale_pitch_word_link_cannot_override_measured_overlap() -> None:
    source_word = TranscriptWord(5, 6, "stars", origin="reference-aligned")
    transcript = Transcript(
        words=[source_word],
        reference=ReferenceReview("partial", "test", lines=[ReferenceLine("stars")]),
        canonical_word_positions=[CanonicalWordPosition(0, 0, 0)],
    )
    analysis = transform_analysis(
        PitchAnalysis(
            10,
            10,
            [
                PitchTrack(
                    "vocals",
                    [PitchNote(1, 2, 60, 261, 0.9), PitchNote(5, 6, 62, 294, 0.9)],
                )
            ],
        ),
        0,
        125,
        transcript.words,
    )
    notes = analysis.tracks[0].notes
    stale = replace(
        analysis,
        words=[replace(analysis.words[0], text="other")],
        tracks=[
            PitchTrack(
                "vocals",
                [
                    replace(notes[0], word_indices=[0]),
                    replace(notes[1], word_indices=[]),
                ],
            )
        ],
    )
    original = pitch_to_json(stale)
    line = lyric_pitch_lines(transcript, stale)[0]
    assert (line.words[0].start_s, line.words[0].end_s) == (4, 4.8)
    assert line.words[0].origin == "measured"
    assert line.words[0].tracks[0].note_indices == [1]
    text = pitched_lyrics_text(transcript, stale, stale.tracks[0])
    assert "D4" in text and "C4" not in text
    assert transcript.words == [source_word]
    assert pitch_to_json(stale) == original


@pytest.mark.parametrize(
    "selection,labels",
    [
        ({}, ["vocals"]),
        (
            {"lead_backing": True, "dereverb": True},
            ["lead", "lead-dry", "backing", "backing-dry"],
        ),
        ({"extract_instruments": True}, ["vocals"]),
        ({"genders": True}, ["vocals-male", "vocals-female"]),
    ],
)
def test_opt_in_dependency_graph_does_not_export_hidden_vocals(
    selection: dict, labels: list[str]
) -> None:
    options = SeparationOptions(extract_pitched_lyrics=True, **selection)
    assert options.needs_lyrics and options.needs_pitch
    assert options.pitch_labels == labels
    assert options.output_labels == SeparationOptions(**selection).output_labels
    assert not options.extract_lyrics and not options.detect_pitch
    assert not SeparationOptions().needs_lyrics and not SeparationOptions().needs_pitch


def test_pitched_lyrics_lifecycle_canonical_bytes_history_retry_and_privacy(
    client: TestClient,
    other_client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    transcript, analysis = singing()
    response = client.post(
        "/api/jobs",
        files={"file": ("Cœur.wav", b"source", "audio/wav")},
        data={"extract_pitched_lyrics": "true"},
    )
    job_id = response.json()["work_id"]
    monkeypatch.setattr(queue, "detect_key", lambda *args: None)
    monkeypatch.setattr(queue, "reference_metadata", lambda *args, **kwargs: None)
    monkeypatch.setattr(
        queue,
        "process_source",
        lambda *args: ProcessingResult({}, transcript, pitch_to_json(analysis)),
    )
    job = db.get_job(job_id)
    assert job is not None
    asyncio.run(queue._run_job(job))
    payload = client.get(f"/api/jobs/{job_id}").json()
    assert payload["status"] == "done", payload["error_message"]
    assert payload["manifest"] == []
    assert [track["label"] for track in payload["pitched_lyrics"]] == [
        "lead",
        "backing",
    ]
    assert payload["pitched_lyrics"][0]["text"].startswith("Cœur\n[Verse]\n")
    for track in payload["pitched_lyrics"]:
        path = f"/api/jobs/{job_id}/pitched-lyrics/{track['label']}/download"
        download = client.get(path)
        assert download.content == track["text"].encode("utf-8")
        assert f"Cœur - {track['label']} - lyrics-with-pitches.txt" in unquote(
            download.headers["content-disposition"]
        )
        assert other_client.get(path).status_code == 404
    assert (
        client.get(
            f"/api/jobs/{job_id}/pitched-lyrics/no-such-stem/download"
        ).status_code
        == 404
    )
    assert client.get(f"/api/jobs/{job_id}/results/vocals").status_code == 404
    db.init_db()
    assert (
        client.get(f"/api/jobs/{job_id}").json()["pitched_lyrics"]
        == payload["pitched_lyrics"]
    )
    event = json.loads(
        client.get(f"/api/jobs/{job_id}/events").text.removeprefix("data: ")
    )
    assert event["pitched_lyrics"] == payload["pitched_lyrics"]
    before_retry = client.get(f"/api/songs/{payload['song_id']}").json()
    retried = client.post(f"/api/jobs/{job_id}/retry")
    assert retried.status_code == 200
    assert retried.json() == {
        "song_id": payload["song_id"],
        "work_id": None,
        "status": "done",
        "position": None,
        "progress": None,
    }
    assert client.get(f"/api/songs/{payload['song_id']}").json() == before_retry
    assert (
        client.get(f"/api/jobs/{job_id}").json()["pitched_lyrics"]
        == payload["pitched_lyrics"]
    )


def test_pitched_download_uses_transform_filename_and_requires_explicit_option(
    client: TestClient,
) -> None:
    transcript, analysis = singing()
    job_id = client.post(
        "/api/jobs",
        data={
            "url": "https://example.org/song",
            "extract_pitched_lyrics": "true",
            "pitch_semitones": "1.25",
            "tempo_percent": "125",
        },
    ).json()["work_id"]
    db.mark_done(job_id, [], transcript, pitch_to_json(analysis))
    response = client.get(f"/api/jobs/{job_id}/pitched-lyrics/lead/download")
    assert "lead - lyrics-with-pitches - pitch+1.25st - tempo125pct.txt" in unquote(
        response.headers["content-disposition"]
    )
    db.set_title(job_id, "Song")
    db.set_original_key(job_id, "C major")
    response = client.get(f"/api/jobs/{job_id}/pitched-lyrics/lead/download")
    assert response.text.startswith("Song\nTonality: Db major (+25 cents)\n")
    payload = client.get(f"/api/jobs/{job_id}").json()
    assert payload["pitched_lyrics"][0]["text"] == response.text
    job = db.get_job(job_id)
    assert job is not None
    plain_work = db.insert_job(job.session_id, "url", "example", SeparationOptions())
    assert plain_work.work_id is not None
    plain_id = plain_work.work_id
    db.mark_done(plain_id, [], transcript, pitch_to_json(analysis))
    assert (
        client.get(f"/api/jobs/{plain_id}/pitched-lyrics/lead/download").status_code
        == 404
    )
    assert client.get(f"/api/jobs/{plain_id}").json()["pitched_lyrics"] is None


def test_word_only_saved_job_downloads_both_real_formats(
    client: TestClient, other_client: TestClient
) -> None:
    word = TranscriptWord(2, 3, "hello")
    transcript = Transcript(words=[word], language="en")
    source = PitchAnalysis(
        5, 5, [PitchTrack("lead", [PitchNote(2, 3, 60, 261.625565, 0.9)])]
    )
    analysis = transform_analysis(source, 0, 125, [word], "fixture")
    job_id = client.post(
        "/api/jobs",
        data={"url": "https://example.org/song", "extract_pitched_lyrics": "true"},
    ).json()["work_id"]
    db.mark_done(job_id, [], transcript, pitch_to_json(analysis))
    plain = client.get(f"/api/jobs/{job_id}/lyrics/download")
    pitched = client.get(f"/api/jobs/{job_id}/pitched-lyrics/lead/download")
    document = client.get(f"/api/jobs/{job_id}/pitched-lyrics/lead/download?format=odt")
    assert "[00:02] hello" in plain.text
    assert "[00:01] hello" in pitched.text
    assert "C4" in pitched.text
    with zipfile.ZipFile(io.BytesIO(document.content)) as archive:
        content = archive.read("content.xml").decode()
        assert "hello" in content
        assert "C4" in content
        assert "[00:01]" in content
    assert (
        other_client.get(f"/api/jobs/{job_id}/pitched-lyrics/lead/download").status_code
        == 404
    )
