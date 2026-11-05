import asyncio
import json
from unittest.mock import MagicMock
from urllib.parse import unquote

import pytest
from fastapi.testclient import TestClient

from backend import db, modal_client, queue
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
from separator.pitched_lyrics import display_width, pitched_lyrics_text
from separator.processing import ProcessingResult


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


def test_melisma_and_real_repeated_notes_widen_cells_without_changing_lyrics() -> None:
    transcript, analysis = singing()
    text = pitched_lyrics_text(transcript, analysis, analysis.tracks[0])
    rows = text.splitlines()
    start = next(index for index, row in enumerate(rows) if row.startswith("[00:01] "))
    assert rows[start - 1] == "        C#4 C#4 D#4  ?"
    assert rows[start].split()[1:] == ["Cœur", "поёт"]
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
    assert "        ?     ?     D4\n[00:01] glow  glow  stars\n" in text
    assert text.count("[??:??]") == 2
    assert "Reference line" not in text and "UNCONFIRMED" not in text
    assert "variant" not in text
    assert "C4" not in text


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
    assert "        ?   ?   D4\n[00:01] go  go  home\n" in pitched_lyrics_text(
        transcript, analysis, analysis.tracks[0]
    )


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
    assert "        ?     C4    D4\n[00:01] glow  glow  stars\n" in text
    assert "B3" not in text
    legacy = Transcript(words=transcript.words, reference=transcript.reference)
    legacy_text = pitched_lyrics_text(legacy, analysis, analysis.tracks[0])
    assert "        ?     ?     ?\n[00:01] glow  glow  stars\n" in legacy_text


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
    job_id = response.json()["id"]
    monkeypatch.setattr(queue, "detect_key", lambda *args: None)
    monkeypatch.setattr(queue, "reference_metadata", lambda *args, **kwargs: None)
    monkeypatch.setattr(
        modal_client,
        "spawn_with_lyrics",
        lambda *args: MagicMock(object_id="fc-lyrics"),
    )
    monkeypatch.setattr(
        modal_client,
        "poll",
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
        client.get("/api/jobs").json()[0]["pitched_lyrics"] == payload["pitched_lyrics"]
    )
    event = json.loads(
        client.get(f"/api/jobs/{job_id}/events").text.removeprefix("data: ")
    )
    assert event["pitched_lyrics"] == payload["pitched_lyrics"]
    assert client.post(f"/api/jobs/{job_id}/retry").status_code == 200
    assert (
        client.get("/api/jobs/current").json()["options"]["extract_pitched_lyrics"]
        is True
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
    ).json()["id"]
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
    plain_id = db.insert_job(job.session_id, "url", "example", SeparationOptions())
    db.mark_done(plain_id, [], transcript, pitch_to_json(analysis))
    assert (
        client.get(f"/api/jobs/{plain_id}/pitched-lyrics/lead/download").status_code
        == 404
    )
    assert client.get(f"/api/jobs/{plain_id}").json()["pitched_lyrics"] is None
