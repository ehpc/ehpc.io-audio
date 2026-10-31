"""Synthetic lyrics only: exercise matching, text surgery, and real HTTP parsing."""

import json
import threading
from dataclasses import asdict, replace
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, TypedDict
from urllib.parse import parse_qs, urlsplit

import pytest

from separator import lyrics_reference
from separator.lyrics import Transcript, TranscriptSegment, TranscriptWord
from separator.lyrics_reference import (
    ReferenceMetadata,
    ReferenceRecord,
    compare_reference,
    reference_review_from_dict,
    review_lyrics,
)

SYNTHETIC = (
    "Amber lanterns softly shimmer beyond quiet windows while silver branches "
    "gather tiny raindrops under violet skies beside distant gardens where "
    "gentle breezes carry secret stories toward the mountains"
)
METADATA = ReferenceMetadata(
    "Synthetic Artist", "Synthetic Song", 180, "Synthetic Album"
)
RECORD = ReferenceRecord(
    123,
    METADATA.artist,
    METADATA.title,
    METADATA.album or "",
    180,
    False,
    SYNTHETIC.replace("shimmer", "shimmers"),
)


def _transcript(text: str = SYNTHETIC, low_word: str = "shimmer") -> Transcript:
    words = [
        TranscriptWord(
            index + 0.125,
            index + 0.625,
            token,
            0.3 if token.strip(",.!?") == low_word else 0.98,
        )
        for index, token in enumerate(text.split())
    ]
    return Transcript(
        [TranscriptSegment(0, len(words) + 1, text)], language="en", words=words
    )


class ProviderState(TypedDict):
    status: int
    calls: list[tuple[str, dict[str, str]]]
    body: dict[str, Any]


@pytest.fixture
def provider(monkeypatch: pytest.MonkeyPatch):
    state: ProviderState = {
        "status": 200,
        "calls": [],
        "body": {
            "id": RECORD.record_id,
            "artistName": RECORD.artist,
            "trackName": RECORD.title,
            "albumName": RECORD.album,
            "duration": RECORD.duration_s,
            "instrumental": False,
            "plainLyrics": RECORD.plain_lyrics,
            # Deliberately unrelated timing: never used by the implementation.
            "syncedLyrics": "[99:59.00] provider time must not become audio time",
        },
    }

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            state["calls"].append((self.path, dict(self.headers)))
            body = json.dumps(state["body"]).encode()
            self.send_response(state["status"])
            self.send_header("Content-Type", "application/json")
            self.send_header("Retry-After", "60")
            self.end_headers()
            self.wfile.write(body)

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


def test_http_match_corrects_one_word_preserving_original_and_clock(provider):
    original = _transcript()
    result = review_lyrics(original, METADATA)
    assert result.review.status == "corrected"
    assert result.segments[0].text == SYNTHETIC.replace("shimmer", "shimmers")
    assert result.review.original_segments == original.segments
    assert result.review.original_words == original.words
    assert result.review.source_url == "https://lrclib.net/api/get/123"
    assert [(word.start_s, word.end_s, word.probability) for word in result.words] == [
        (word.start_s, word.end_s, word.probability) for word in original.words
    ]
    assert [(segment.start_s, segment.end_s) for segment in result.segments] == [
        (segment.start_s, segment.end_s) for segment in original.segments
    ]
    correction = result.review.corrections[0]
    assert (correction.original, correction.replacement) == ("shimmer", "shimmers")
    assert result.words[correction.word_index].text == "shimmers"
    assert len(provider["calls"]) == 1
    path, _ = provider["calls"][0]
    assert parse_qs(urlsplit(path).query) == {
        "artist_name": [METADATA.artist],
        "track_name": [METADATA.title],
        "album_name": [METADATA.album],
        "duration": ["180"],
    }
    restored = reference_review_from_dict(json.loads(json.dumps(asdict(result.review))))
    assert restored == result.review


def test_punctuation_and_repeated_words_are_surgically_preserved():
    text = SYNTHETIC.replace("softly shimmer", "softly, shimmer!") + " Amber Amber"
    original = _transcript(text)
    record = replace(RECORD, plain_lyrics=text.replace("shimmer!", "shimmers!"))
    result = compare_reference(original, METADATA, record)
    assert result.review.status == "corrected"
    assert result.segments[0].text == text.replace("shimmer!", "shimmers!")
    assert result.words[3].text == "shimmers!"
    assert [word.text for word in result.words[-2:]] == ["Amber", "Amber"]
    assert len(result.words) == len(original.words)


@pytest.mark.parametrize("status", [429, 503])
def test_provider_outage_is_one_request_and_retains_asr(provider, status):
    provider["status"] = status
    original = _transcript()
    result = review_lyrics(original, METADATA)
    assert result.review.status == "unavailable"
    assert str(status) in result.review.reason
    assert result.segments is original.segments
    assert result.words is original.words
    assert result.review.original_segments == original.segments
    assert len(provider["calls"]) == 1


@pytest.mark.parametrize(
    "metadata",
    [
        None,
        ReferenceMetadata("", "Title", 180),
        ReferenceMetadata("Artist", "", 180),
        ReferenceMetadata("Artist", "Title", float("nan")),
    ],
)
def test_missing_credible_metadata_does_not_contact_provider(provider, metadata):
    original = _transcript()
    result = review_lyrics(original, metadata)
    assert result.review.status == "skipped"
    assert result.segments is original.segments
    assert result.words is original.words
    assert provider["calls"] == []


@pytest.mark.parametrize(
    "version",
    [
        "Synthetic Song (Live)",
        "Synthetic Song - Remix",
        "Synthetic Song Cover",
        "Synthetic Song (Translation)",
        "Synthetic Song (Acoustic Version)",
    ],
)
def test_known_alternate_recording_never_contacts_provider(provider, version):
    result = review_lyrics(_transcript(), replace(METADATA, title=version))
    assert result.review.status == "skipped"
    assert provider["calls"] == []


@pytest.mark.parametrize(
    "record",
    [
        replace(RECORD, artist="Different Artist"),
        replace(RECORD, title="Synthetic Song (Live)"),
        replace(RECORD, duration_s=183),
        replace(RECORD, album="Synthetic Album (Remix)"),
    ],
)
def test_weak_title_or_wrong_version_match_is_rejected(record):
    original = _transcript()
    result = compare_reference(original, METADATA, record)
    assert result.review.status == "rejected"
    assert result.segments is original.segments
    assert result.words is original.words
    assert result.review.corrections == []


def test_unrelated_lyrics_rejected_despite_exact_metadata():
    original = _transcript()
    record = replace(RECORD, plain_lyrics="unrelated different words " * 20)
    result = compare_reference(original, METADATA, record)
    assert result.review.status == "rejected"
    assert result.segments is original.segments


def test_missing_provider_lines_never_inserted_into_asr():
    original = _transcript()
    record = replace(RECORD, plain_lyrics=SYNTHETIC + " missingword")
    result = compare_reference(original, METADATA, record)
    assert result.review.status == "compared"
    assert result.segments == original.segments
    assert result.words == original.words
    assert "missingword" not in result.segments[0].text


def test_high_confidence_asr_and_multiword_changes_are_not_overwritten():
    original = _transcript(low_word="none")
    result = compare_reference(original, METADATA, RECORD)
    assert result.review.status == "compared"
    assert result.words == original.words
    record = replace(
        RECORD, plain_lyrics=SYNTHETIC.replace("shimmer", "shine brightly")
    )
    result = compare_reference(_transcript(), METADATA, record)
    assert result.review.status == "compared"
    assert result.segments[0].text == SYNTHETIC


def test_imperfect_segment_alignment_does_not_discard_or_rebuild_words():
    original = _transcript()
    original = replace(
        original,
        segments=[
            replace(
                original.segments[0],
                text=original.segments[0].text + " punctuation-only-tail",
            )
        ],
    )
    result = compare_reference(original, METADATA, RECORD)
    assert result.review.status == "compared"
    assert result.segments == original.segments
    assert result.words == original.words


def test_repeated_reference_window_is_not_guessed():
    text = SYNTHETIC + " " + SYNTHETIC
    original = _transcript(text)
    record = replace(RECORD, plain_lyrics=text.replace("shimmer", "shimmers"))
    result = compare_reference(original, METADATA, record)
    assert result.review.status == "compared"
    assert result.words == original.words


def test_invalid_provider_record_is_unavailable_not_audio_failure(provider):
    provider["body"]["duration"] = "180"
    result = review_lyrics(_transcript(), METADATA)
    assert result.review.status == "unavailable"
    assert result.words == _transcript().words


def test_provider_not_found_and_absent_alignment_are_honest(provider):
    provider["status"] = 404
    result = review_lyrics(_transcript(), METADATA)
    assert result.review.status == "not_found"
    assert result.words == _transcript().words
    calls = len(provider["calls"])
    result = review_lyrics(Transcript([TranscriptSegment(0, 1, "hello")]), METADATA)
    assert result.review.status == "skipped"
    assert len(provider["calls"]) == calls
