"""Synthetic lyrics: real HTTP lookup/cache and audio-evidence policy regressions."""

import json
import threading
from dataclasses import asdict, replace
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, TypedDict
from urllib.parse import parse_qs, urlsplit

import pytest

from separator import lyrics_reference
from separator.lyrics import (
    Transcript,
    TranscriptSection,
    TranscriptSegment,
    TranscriptWord,
    UntimedRecognition,
    transcript_export_text,
)
from separator.lyrics_reference import (
    AcousticEvidence,
    ReferenceLine,
    ReferenceMetadata,
    ReferenceReview,
    apply_reference,
    counterfactual_line,
    lookup_reference,
    ordered_matches,
    plan_reference,
    reference_lines,
    reference_review_from_dict,
    reuse_exact_asr_candidates,
)

METADATA = ReferenceMetadata(
    "Synthetic Artist", "Synthetic Song", 180, "Synthetic Album"
)
CANONICAL = (
    "Amber lanterns shine\nSilver branches sway\n"
    "Amber lanterns shine\nQuiet gardens sleep"
)


def words(text: str, start: float = 1) -> list[TranscriptWord]:
    return [
        TranscriptWord(start + index, start + index + 0.6, token, alignment_score=0.8)
        for index, token in enumerate(text.split())
    ]


def heard(text: str, start: float = 1) -> Transcript:
    aligned = words(text, start)
    return Transcript(
        [TranscriptSegment(aligned[0].start_s, aligned[-1].end_s, text)],
        language="English",
        words=aligned,
        asr_model="Qwen/Qwen3-ASR-1.7B",
        word_alignment="torchaudio/MMS_FA",
    )


def review(text: str = CANONICAL) -> ReferenceReview:
    return ReferenceReview(
        "matched",
        "Exact metadata matched.",
        lines=[ReferenceLine(line) for line in text.splitlines()],
    )


class ProviderState(TypedDict):
    status: int
    calls: list[str]
    body: dict[str, Any]


@pytest.fixture
def provider(monkeypatch: pytest.MonkeyPatch):
    state: ProviderState = {
        "status": 200,
        "calls": [],
        "body": {
            "id": 123,
            "artistName": METADATA.artist,
            "trackName": METADATA.title,
            "albumName": METADATA.album,
            "duration": 180,
            "instrumental": False,
            "plainLyrics": CANONICAL,
            "syncedLyrics": "[99:59.00] never audio timing",
        },
    }

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            state["calls"].append(self.path)
            self.send_response(state["status"])
            self.send_header("Content-Type", "application/json")
            self.send_header("Retry-After", "60")
            self.end_headers()
            self.wfile.write(json.dumps(state["body"]).encode())

        def log_message(self, format: str, *args: Any) -> None:
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    monkeypatch.setattr(
        lyrics_reference, "_API", f"http://127.0.0.1:{server.server_port}/api/get"
    )
    try:
        yield state
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def test_exact_metadata_lookup_before_asr_caches_only_legitimate_provider_record(
    provider, tmp_path: Path
):
    result = lookup_reference(METADATA, tmp_path)
    assert result.record is not None
    assert result.record.plain_lyrics == CANONICAL
    assert result.review.status == "matched"
    assert result.review.fetched_at is not None
    assert result.review.cached is False
    assert all(
        line.start_s is None and line.end_s is None for line in result.review.lines
    )
    assert parse_qs(urlsplit(provider["calls"][0]).query) == {
        "artist_name": [METADATA.artist],
        "track_name": [METADATA.title],
        "album_name": [METADATA.album],
        "duration": ["180"],
    }
    provider["status"] = 503
    cached = lookup_reference(METADATA, tmp_path)
    assert cached.record == result.record
    assert cached.review.cached is True
    assert cached.review.fetched_at == result.review.fetched_at
    assert len(provider["calls"]) == 1


@pytest.mark.parametrize(
    "status, expected", [(404, "not_found"), (429, "unavailable"), (503, "unavailable")]
)
def test_provider_failures_do_not_retry_or_create_reference_text(
    provider, status, expected
):
    provider["status"] = status
    result = lookup_reference(METADATA)
    assert result.record is None
    assert result.review.status == expected
    assert result.review.lines == []
    assert len(provider["calls"]) == 1


@pytest.mark.parametrize(
    "key, value",
    [
        ("artistName", "Different artist"),
        ("trackName", "Synthetic Song (Live)"),
        ("albumName", "Other album"),
        ("duration", 183),
        ("plainLyrics", None),
        ("instrumental", True),
    ],
)
def test_wrong_version_or_empty_lyrics_never_authorize_reference_alignment(
    provider, key, value
):
    provider["body"][key] = value
    result = lookup_reference(METADATA)
    assert result.record is None
    assert result.review.status == "rejected"


def test_exact_live_version_is_not_stripped_to_album_version(provider):
    live = replace(METADATA, title="Synthetic Song (Live)")
    provider["body"]["trackName"] = live.title
    assert lookup_reference(live).review.status == "matched"
    assert lookup_reference(METADATA).review.status == "rejected"


def test_missing_credible_identity_never_contacts_provider(provider):
    result = lookup_reference(None)
    assert result.review.status == "skipped"
    assert provider["calls"] == []


def test_repeated_chorus_uses_distinct_monotonic_occurrences_and_preserves_order():
    original = heard(CANONICAL.replace("\n", " "))
    planned, phrases = plan_reference(original, review(), 180)
    repeated: list[str] = ["a", "b", "a", "b"]
    assert ordered_matches(repeated, repeated) == {
        3: 3,
        2: 2,
        1: 1,
        0: 0,
    }
    candidates = {
        index: original.words[index * 3 : index * 3 + 3] for index in range(4)
    }
    result = apply_reference(original, planned, candidates)
    assert [segment.text for segment in result.segments] == CANONICAL.splitlines()
    assert result.reference is not None
    assert result.reference.status == "aligned"
    first_start = result.reference.lines[0].start_s
    repeated_start = result.reference.lines[2].start_s
    assert first_start is not None and repeated_start is not None
    assert first_start < repeated_start
    assert [index for phrase in phrases for index in phrase.line_indices] == [
        0,
        1,
        2,
        3,
    ]
    assert all(0 <= phrase.start_s < phrase.end_s <= 180 for phrase in phrases)
    assert result.reference.original_words == original.words
    assert result.reference.original_segments == original.segments


def test_omitted_verse_is_untimed_despite_valid_forced_alignment_spans():
    original = heard("Amber lanterns shine Quiet gardens sleep")
    canonical = "Amber lanterns shine\nSilver branches sway\nQuiet gardens sleep"
    planned, phrases = plan_reference(original, review(canonical), 180)
    assert planned.lines[1].support == 0
    assert any(1 in phrase.line_indices for phrase in phrases)
    candidates = {
        0: original.words[:3],
        1: words("Silver branches sway", 40),
        2: original.words[3:],
    }
    result = apply_reference(original, planned, candidates)
    assert result.reference is not None
    omitted = result.reference.lines[1]
    assert omitted.status == "unconfirmed"
    assert omitted.start_s is None and omitted.end_s is None
    assert "Silver branches sway" not in " ".join(
        segment.text for segment in result.segments
    )
    exported = transcript_export_text(result)
    assert "[??:??] Silver branches sway" in exported
    assert "[00:40] Silver" not in exported


def test_wrong_chorus_variant_is_not_overwritten_despite_high_shared_word_ratio():
    original = heard("Amber lanterns never shine beyond quiet windows")
    canonical = "Amber lanterns always shine beyond quiet windows"
    planned, _ = plan_reference(original, review(canonical), 180)
    result = apply_reference(original, planned, {0: words(canonical)})
    assert result.segments == []
    assert result.words == []
    assert result.reference is not None
    assert result.reference.original_segments == original.segments
    assert result.reference.original_words == original.words
    assert canonical in transcript_export_text(result)
    assert "never" not in transcript_export_text(result)
    assert (
        result.reference.lines[0].recognized_variant
        == "amber lanterns never shine beyond quiet windows"
    )
    assert result.reference.lines[0].start_s is None


def test_sung_adlib_inside_shared_line_is_retained_instead_of_silently_deleted():
    original = heard("Amber lanterns oh shine beyond quiet windows")
    canonical = "Amber lanterns shine beyond quiet windows"
    result = apply_reference(original, review(canonical), {0: words(canonical)})
    assert result.segments == []
    assert result.reference is not None
    assert result.reference.lines[0].recognized_variant is not None
    assert "oh" in result.reference.lines[0].recognized_variant


def test_provider_only_word_is_exposed_as_uncorroborated_without_word_timestamp():
    original = heard("Amber lanterns shine beyond windows")
    canonical = "Amber lanterns shine beyond quiet windows"
    planned, _ = plan_reference(original, review(canonical), 180)
    result = apply_reference(original, planned, {0: words(canonical)})
    assert result.reference is not None
    assert result.reference.lines[0].unconfirmed_words == ["quiet"]
    assert "quiet" not in [word.text for word in result.words]
    assert result.reference.lines[0].status == "aligned"
    assert "quiet" in result.segments[0].text


def test_asr_only_extra_verse_is_retained_with_original_clock():
    original = heard("Amber lanterns shine secret morning rises")
    result = apply_reference(
        original, review("Amber lanterns shine"), {0: original.words[:3]}
    )
    assert "secret morning rises" in " ".join(
        segment.text for segment in result.asr_extras
    )
    assert [(word.start_s, word.end_s, word.text) for word in result.words[-3:]] == [
        (word.start_s, word.end_s, word.text) for word in original.words[-3:]
    ]
    assert all(word.origin == "asr-extra" for word in result.words[-3:])


def test_review_wire_roundtrip_preserves_null_scores_uncertainty_and_original_asr():
    original = heard("Amber lanterns shine")
    result = apply_reference(
        original, review("Amber lanterns shine"), {0: original.words}
    )
    assert result.reference is not None
    assert (
        reference_review_from_dict(json.loads(json.dumps(asdict(result.reference))))
        == result.reference
    )
    assert all(
        word.probability is None and word.alignment_score == 0.8
        for word in result.words
    )


def test_counterfactual_comparison_does_not_reward_recognizer_word_omissions():
    assert (
        counterfactual_line(
            "Amber lanterns softly shine",
            "Amber lanterns shine",
        )
        == "amber lanterns softly shine"
    )
    assert (
        counterfactual_line(
            "Amber lanterns softly shine",
            "Amber lanterns brightly shine",
        )
        == "amber lanterns brightly shine"
    )


def test_negative_same_frame_acoustic_margin_rejects_a_real_chorus_variant():
    original = heard("Amber lanterns never shine beyond quiet windows")
    canonical = "Amber lanterns always shine beyond quiet windows"
    evidence = AcousticEvidence(
        -0.5,
        -0.1,
        original.segments[0].text,
        100,
        original.segments[0].text,
        0,
        2,
    )
    result = apply_reference(
        original,
        review(canonical),
        {0: words(canonical)},
        {0: evidence},
    )
    assert result.segments == []
    assert result.reference is not None
    assert result.reference.lines[0].status == "unconfirmed"
    assert result.reference.lines[0].acoustic_log_odds == -40


def test_lrc_blank_boundaries_remain_provider_priors_not_instrumental_lyrics():
    lines = reference_lines(
        "Amber lanterns shine\n\nSilver branches sway",
        "[00:10.00] Amber lanterns shine\n[00:20.00]\n"
        "[00:50.00] Silver branches sway\n[01:00.00]",
        100,
    )
    assert len(lines) == 2
    assert lines[0].provider_start_s == 10
    assert lines[0].provider_end_s == 20
    assert lines[1].provider_start_s == 50
    assert all(line.start_s is None and line.end_s is None for line in lines)
    assert lines[0].group != lines[1].group


@pytest.mark.parametrize(
    "synced",
    [
        "[00:10.00] Different lyrics\n[00:20.00] Silver branches sway",
        "[00:20.00] Amber lanterns shine\n[00:10.00] Silver branches sway",
        "[99:00.00] Amber lanterns shine\n[99:01.00] Silver branches sway",
    ],
)
def test_mismatched_or_invalid_provider_lrc_never_supplies_source_clock_priors(synced):
    lines = reference_lines("Amber lanterns shine\nSilver branches sway", synced, 100)
    assert all(line.provider_start_s is None for line in lines)


def test_provider_clock_requires_multiple_distributed_independent_anchors():
    canonical = (
        "Amber lanterns shine\nSilver branches sway\n"
        "Quiet gardens sleep\nGentle breezes whisper"
    )
    starts = [10, 30, 60, 90]
    synced = "\n".join(
        f"[{start // 60:02}:{start % 60:02}.00] {line}"
        for start, line in zip(starts, canonical.splitlines(), strict=True)
    )
    lines = reference_lines(canonical, synced, 120)
    aligned = [
        word
        for start, line in zip(starts, canonical.splitlines(), strict=True)
        for word in words(line, start + 0.3)
    ]
    original = Transcript(
        [TranscriptSegment(word.start_s, word.end_s, word.text) for word in aligned],
        words=aligned,
    )
    candidate = ReferenceReview(
        "matched",
        "Metadata matched",
        lines=lines,
        provider_timing_status="candidate",
    )
    planned, _ = plan_reference(original, candidate, 120)
    assert planned.provider_timing_status == "validated"
    assert planned.provider_timing_reason is not None
    assert "0.30s" in planned.provider_timing_reason
    actual = apply_reference(
        original,
        planned,
        {index: aligned[index * 3 : index * 3 + 3] for index in range(4)},
    )
    assert actual.reference is not None
    assert actual.reference.lines[0].provider_start_s == 10
    assert actual.reference.lines[0].start_s == 10.3
    shifted = replace(
        original,
        segments=[],
        words=[
            replace(word, start_s=word.start_s + 10, end_s=word.end_s + 10)
            for word in aligned
        ],
    )
    rejected, _ = plan_reference(shifted, candidate, 120)
    assert rejected.provider_timing_status == "rejected"


def test_successful_cache_survives_encoder_precision_and_metadata_case_variation(
    provider,
    tmp_path: Path,
):
    precise = replace(METADATA, duration_s=180.02325)
    first = lookup_reference(precise, tmp_path)
    assert first.record is not None
    provider["status"] = 503
    rounded = replace(
        METADATA,
        artist="  SYNTHETIC Artist ",
        title="synthetic song",
        album="Synthetic ALBUM",
        duration_s=180.0,
    )
    cached = lookup_reference(rounded, tmp_path)
    assert cached.record == first.record
    assert cached.review.cached is True
    assert len(provider["calls"]) == 1
    other_version = lookup_reference(replace(rounded, duration_s=184), tmp_path)
    assert other_version.review.status == "unavailable"
    assert len(provider["calls"]) == 2


def test_primary_canonical_order_keeps_disputed_line_inline_without_asr_typo():
    canonical = "Amber lanterns shine\nSilver branches sway\nQuiet gardens sleep"
    original = heard("Amber lanterns shine Silver branches sleep Quiet gardens sleep")
    original = replace(
        original,
        sections=[
            TranscriptSection(0, 1, "intro"),
            TranscriptSection(1, 6.8, "verse"),
            TranscriptSection(6.8, 10, "chorus"),
            TranscriptSection(10, 14, "inst"),
            TranscriptSection(14, 16, "outro"),
        ],
    )
    result = apply_reference(
        original,
        review(canonical),
        {
            0: original.words[:3],
            1: words("Silver branches sway", 4),
            2: original.words[6:],
        },
    )
    text = transcript_export_text(result)
    assert text.index("Amber lanterns shine") < text.index("Silver branches sway")
    assert text.index("Silver branches sway") < text.index("Quiet gardens sleep")
    assert all(text.count(line) == 1 for line in canonical.splitlines())
    assert "[??:??] Silver branches sway" in text
    assert "[00:04] Silver branches sway" not in text
    assert "Silver branches sleep" not in text
    assert "[Verse]\n[00:01] Amber lanterns shine" in text
    assert "\n[Chorus]\n[00:07] Quiet gardens sleep" in text
    assert "[Instrumental]" in text and "[Outro]" in text
    assert "Estimated musical structure" not in text
    assert [segment.text for segment in result.segments] == [
        "Amber lanterns shine",
        "Quiet gardens sleep",
    ]
    assert not any(word.text.casefold() == "silver" for word in result.words)
    assert result.reference is not None
    assert result.reference.original_segments == original.segments
    assert result.reference.lines[1].recognized_variant == "silver branches sleep"


def test_unanchored_canonical_group_has_unknown_section_not_invented_label():
    result = Transcript(
        reference=review("Unheard canonical words"),
        sections=[
            TranscriptSection(0, 10, "intro"),
            TranscriptSection(10, 20, "verse"),
        ],
    )
    text = transcript_export_text(result)
    assert "Unknown section" in text
    assert "[??:??] Unheard canonical words" in text
    assert "Estimated musical structure" in text
    assert text.count("Verse") == 1


def test_txt_head_is_identity_without_system_messages_or_bottom_legend() -> None:
    identified = transcript_export_text(
        Transcript(
            reference=replace(
                review("Amber lanterns shine"), artist="Doe", title="Amber Song"
            )
        ),
        title="Upload.wav",
    )
    assert identified.splitlines()[0] == "Doe — Amber Song"
    fallback = transcript_export_text(
        Transcript(reference=review("Amber lanterns shine")), title="Upload.wav"
    )
    assert fallback.splitlines()[0] == "Upload.wav"
    anonymous = transcript_export_text(
        Transcript(reference=review("Amber lanterns shine"))
    )
    assert anonymous.splitlines()[0] == "[??:??] Amber lanterns shine"
    for text in (identified, fallback, anonymous):
        assert "NOT verified" not in text
        assert "Reference source" not in text
        assert "audio clock" not in text
        assert "Word-level timing uncertainty" not in text
        assert "NO WORD TIMESTAMPS" not in text


def test_unconfirmed_word_timings_stay_in_json_not_a_bottom_legend() -> None:
    text = transcript_export_text(
        Transcript(
            reference=ReferenceReview(
                "aligned",
                "Synthetic policy fixture",
                artist="Doe",
                title="Amber Song",
                lines=[
                    ReferenceLine(
                        "Amber lanterns shine",
                        "aligned",
                        1,
                        2,
                        3,
                        unconfirmed_words=["shine"],
                    )
                ],
            )
        )
    )
    assert text.splitlines()[0] == "Doe — Amber Song"
    assert "[00:02] Amber lanterns shine" in text
    assert "Word-level timing uncertainty" not in text
    assert "uncorroborated" not in text


def test_unreferenced_txt_head_falls_back_to_title_and_marks_untimed_rows() -> None:
    transcript = Transcript(
        segments=[TranscriptSegment(0, 2, "Heard line")],
        untimed=[UntimedRecognition("Raw words", "Insufficient acoustic evidence")],
    )
    text = transcript_export_text(transcript, title="Upload.wav")
    assert text.startswith("Upload.wav\n[00:00] Heard line\n")
    assert "[??:??] Raw words" in text
    assert "[Alignment unavailable: Insufficient acoustic evidence]" in text
    assert transcript_export_text(transcript) == text.removeprefix("Upload.wav\n")


def test_explicit_long_stanzas_split_without_losing_anchored_source_times():
    texts = [
        "amber lanterns shine",
        "silver branches sway",
        "quiet gardens sleep",
        "gentle breezes whisper",
        "morning birds awaken",
        "distant rivers wander",
    ]
    starts = [6, 16, 26, 36, 48, 58]
    anchors = [
        word
        for start, text in zip(starts, texts, strict=True)
        for word in words(text, start + 0.3)
    ]
    original = Transcript(words=anchors)
    lines = [
        ReferenceLine(
            text,
            group=0 if index < 4 else 1,
            provider_start_s=start,
            provider_end_s=starts[index + 1] if index + 1 < len(starts) else 75,
        )
        for index, (text, start) in enumerate(zip(texts, starts, strict=True))
    ]
    candidate = ReferenceReview(
        "matched", "Exact recording", lines=lines, provider_timing_status="candidate"
    )
    planned, phrases = plan_reference(original, candidate, 80, anchors)
    assert planned.provider_timing_status == "validated"
    assert [i for phrase in phrases for i in phrase.line_indices] == list(range(6))
    assert len(phrases) == 3
    for phrase in phrases:
        assert 0 < phrase.end_s - phrase.start_s <= 30
        assert len({lines[index].group for index in phrase.line_indices}) == 1
        for index in phrase.line_indices:
            assert all(
                phrase.start_s <= word.start_s < word.end_s <= phrase.end_s
                for word in anchors[index * 3 : index * 3 + 3]
            )
    # The stanza boundary stays distinct even when the surrounding windows overlap.
    assert phrases[1].line_indices == [3]
    assert phrases[2].line_indices == [4, 5]


def test_overlong_single_line_stays_untimed_instead_of_clipped():
    original = Transcript(
        words=[
            TranscriptWord(1, 2, "amber", alignment_score=0.8),
            TranscriptWord(16, 17, "lanterns", alignment_score=0.8),
            TranscriptWord(32, 33, "shine", alignment_score=0.8),
        ]
    )
    candidate = review("amber lanterns shine")
    planned, phrases = plan_reference(original, candidate, 60, original.words)
    assert phrases == []
    result = apply_reference(original, planned, {})
    assert result.reference is not None
    assert result.reference.lines[0].status == "unconfirmed"
    assert result.reference.lines[0].start_s is None
    assert "[??:??] amber lanterns shine" in transcript_export_text(result)


def test_reuse_only_unique_acoustic_asr_spans_and_preserve_conflicts():
    lines = [
        ReferenceLine("amber lanterns", provider_start_s=10, provider_end_s=15),
        ReferenceLine("silver branches", provider_start_s=20, provider_end_s=25),
        ReferenceLine("quiet gardens", provider_start_s=30, provider_end_s=35),
        ReferenceLine("quiet gardens", provider_start_s=40, provider_end_s=45),
        ReferenceLine("never heard", provider_start_s=50, provider_end_s=55),
    ]
    first = words("amber lanterns", 10.4)
    disputed = words("silver branches", 20.4)
    repeated = words("quiet gardens", 30.4) + words("quiet gardens", 40.4)
    original = Transcript(words=first + disputed + repeated)
    review = ReferenceReview(
        "matched", "Exact recording", lines=lines, provider_timing_status="validated"
    )
    forced_conflict = words("silver branches", 21)
    candidates, reused = reuse_exact_asr_candidates(
        original, review, {1: forced_conflict}, original.words
    )
    assert reused == {0, 2, 3}
    assert candidates[1] == forced_conflict
    assert 4 not in candidates
    result = apply_reference(original, review, candidates, {}, asr_reused=reused)
    assert result.reference is not None
    assert result.reference.lines[0].start_s == first[0].start_s
    assert result.reference.lines[2].start_s == repeated[0].start_s
    assert result.reference.lines[3].start_s == repeated[2].start_s
    assert result.reference.lines[4].start_s is None
    assert result.words[0].origin == "asr"
    assert result.reference.lines[0].canonical_log_score is None
    assert result.reference.lines[0].acoustic_log_odds is None
    assert (
        "provider did not supply the word timings" in result.reference.lines[0].reason
    )
    assert "[??:??] never heard" in transcript_export_text(result)

    # Duplicate occurrences in one provider interval are ambiguous, not a match.
    duplicate = first + words("amber lanterns", 13)
    ambiguous = Transcript(words=duplicate)
    none, reused = reuse_exact_asr_candidates(
        ambiguous, replace(review, lines=lines[:1]), {}, duplicate
    )
    assert none == {} and reused == set()
    # A second occurrence is still ambiguous if one of its acoustic words is
    # too weak to appear in the published ASR transcript.
    weak_repeat = words("amber lanterns", 13)
    weak_repeat[0] = replace(weak_repeat[0], alignment_score=0.01)
    raw = [*first, *weak_repeat]
    published = Transcript(words=[*first, weak_repeat[1]])
    none, reused = reuse_exact_asr_candidates(
        published, replace(review, lines=lines[:1]), {}, raw
    )
    assert none == {} and reused == set()
    # Weak hidden acoustic words inside an otherwise exact published match are
    # not discarded to turn contradictory audio into a unique reference match.
    interruption = TranscriptWord(11, 11.2, "other", alignment_score=0.01)
    raw = sorted([*first, interruption], key=lambda word: word.start_s)
    none, reused = reuse_exact_asr_candidates(
        Transcript(words=first), replace(review, lines=lines[:1]), {}, raw
    )
    assert none == {} and reused == set()
    rejected = replace(review, provider_timing_status="rejected")
    assert reuse_exact_asr_candidates(original, rejected, {}, original.words) == (
        {},
        set(),
    )


def test_reused_span_never_overlaps_existing_neighbor_candidate():
    original = Transcript(words=words("amber lanterns", 10.4))
    review = ReferenceReview(
        "matched",
        "Exact recording",
        lines=[
            ReferenceLine("amber lanterns", provider_start_s=10, provider_end_s=15),
            ReferenceLine("silver branches", provider_start_s=15, provider_end_s=20),
        ],
        provider_timing_status="validated",
    )
    existing = words("silver branches", 11.5)
    candidates, reused = reuse_exact_asr_candidates(
        original, review, {1: existing}, original.words
    )
    assert reused == set()
    assert candidates == {1: existing}
    evidence = {
        1: AcousticEvidence(-0.1, -0.2, "silver branches", 100, "other", 10, 15)
    }
    result = apply_reference(original, review, candidates, evidence)
    assert result.reference is not None
    assert result.reference.lines[0].status == "unconfirmed"
    assert result.reference.lines[1].status == "aligned"
    assert result.reference.lines[1].start_s == 11.5


@pytest.mark.parametrize(
    "field,value", [("alignment_score", float("nan")), ("end_s", 10.4)]
)
def test_invalid_reused_raw_acoustic_word_cannot_be_published(field, value):
    candidate = words("amber lanterns", 10.4)
    # Simulate an invalid deserialized/raw object bypassing dataclass construction.
    object.__setattr__(candidate[0], field, value)
    original = Transcript(words=candidate)
    review = ReferenceReview(
        "matched",
        "Exact recording",
        lines=[ReferenceLine("amber lanterns", provider_start_s=10, provider_end_s=15)],
        provider_timing_status="validated",
    )
    aligned, reused = reuse_exact_asr_candidates(original, review, {}, candidate)
    assert aligned == {} and reused == set()
    result = apply_reference(original, review, {})
    assert result.reference is not None
    assert result.reference.lines[0].status == "unconfirmed"
