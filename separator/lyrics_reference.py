"""Optional LRCLIB comparison; ASR remains the only source of audio timing.

A reference is evidence for a tentative spelling correction, not ground truth.
Never import provider lines, syllables, or timestamps into the transcript.
"""

import json
import re
import unicodedata
from dataclasses import dataclass, field, replace
from difflib import SequenceMatcher
from math import isfinite
from typing import Literal
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from separator.lyrics import Transcript, TranscriptSegment, TranscriptWord

_API = "https://lrclib.net/api/get"
_USER_AGENT = "ehpc's Vocal Tools v0.1 (https://github.com/ehpc/ehpc.io-audio)"
_MAX_RESPONSE_BYTES = 1_000_000
_TOKEN = re.compile(r"[^\W_]+(?:['\u2019][^\W_]+)*", re.UNICODE)
_VERSION = re.compile(
    r"\b(live|remix|remixed|cover|translated|translation|karaoke|instrumental|"
    r"acoustic|sped|slowed|nightcore|demo|edit|remaster(?:ed)?|version)\b",
    re.IGNORECASE,
)
ReferenceStatus = Literal[
    "skipped", "unavailable", "not_found", "rejected", "compared", "corrected"
]


@dataclass(frozen=True)
class ReferenceMetadata:
    artist: str
    title: str
    duration_s: float
    album: str | None = None


@dataclass(frozen=True)
class ReferenceCorrection:
    word_index: int
    original: str
    replacement: str
    start_s: float
    end_s: float


@dataclass(frozen=True)
class ReferenceReview:
    status: ReferenceStatus
    reason: str
    provider: str = "LRCLIB"
    source_url: str | None = None
    record_id: int | None = None
    artist: str | None = None
    title: str | None = None
    album: str | None = None
    duration_s: float | None = None
    agreement: float | None = None
    corrections: list[ReferenceCorrection] = field(default_factory=list)
    original_segments: list[TranscriptSegment] = field(default_factory=list)
    original_words: list[TranscriptWord] = field(default_factory=list)


@dataclass(frozen=True)
class ReferenceResult:
    segments: list[TranscriptSegment]
    words: list[TranscriptWord]
    review: ReferenceReview


@dataclass(frozen=True)
class ReferenceRecord:
    record_id: int
    artist: str
    title: str
    album: str
    duration_s: float
    instrumental: bool
    plain_lyrics: str | None


class ReferenceUnavailable(Exception):
    """The optional provider cannot supply a usable response."""


def reference_review_from_dict(value: dict) -> ReferenceReview:
    """Decode the primitives-only transcript wire format, including ASR provenance."""
    return ReferenceReview(
        status=value["status"],
        reason=value["reason"],
        provider=value.get("provider", "LRCLIB"),
        source_url=value.get("source_url"),
        record_id=value.get("record_id"),
        artist=value.get("artist"),
        title=value.get("title"),
        album=value.get("album"),
        duration_s=value.get("duration_s"),
        agreement=value.get("agreement"),
        corrections=[
            ReferenceCorrection(**item) for item in value.get("corrections", [])
        ],
        original_segments=[
            TranscriptSegment(**item) for item in value.get("original_segments", [])
        ],
        original_words=[
            TranscriptWord(**item) for item in value.get("original_words", [])
        ],
    )


def _normalize(text: str) -> str:
    # Do not remove version qualifiers, credits, accents, or artist punctuation.
    return " ".join(unicodedata.normalize("NFKC", text).casefold().split())


def _tokens(text: str) -> list[str]:
    return [
        _normalize(match.group()).replace("\u2019", "'")
        for match in _TOKEN.finditer(text)
    ]


def _metadata_reason(metadata: ReferenceMetadata | None) -> str | None:
    if (
        metadata is None
        or not metadata.artist.strip()
        or not metadata.title.strip()
        or not isfinite(metadata.duration_s)
        or not 1 <= metadata.duration_s <= 3600
    ):
        return "Credible artist, track title, and source duration are required."
    if any(_VERSION.search(value) for value in (metadata.title, metadata.album or "")):
        return "Alternate/live/remix/cover versions are not automatically corrected."
    return None


def fetch_reference(metadata: ReferenceMetadata) -> ReferenceRecord | None:
    """One bounded documented API request; no scraping, search fallback, or retries.

    In particular, a 429/503 does not trigger another request or violate the
    provider's Retry-After instruction. A later user job is a separate lookup.
    """
    params: dict[str, str | float] = {
        "artist_name": metadata.artist,
        "track_name": metadata.title,
        "duration": metadata.duration_s,
    }
    if metadata.album:
        params["album_name"] = metadata.album
    request = Request(
        f"{_API}?{urlencode(params)}",
        headers={"User-Agent": _USER_AGENT, "Accept": "application/json"},
    )
    try:
        with urlopen(request, timeout=8) as response:
            if response.headers.get_content_type() != "application/json":
                raise ReferenceUnavailable("Provider returned a non-JSON response.")
            raw = response.read(_MAX_RESPONSE_BYTES + 1)
            if len(raw) > _MAX_RESPONSE_BYTES:
                raise ReferenceUnavailable("Provider response exceeded the size limit.")
        value = json.loads(raw)
        if (
            not isinstance(value, dict)
            or type(value.get("id")) is not int
            or value["id"] <= 0
            or not all(
                isinstance(value.get(key), str)
                for key in ("artistName", "trackName", "albumName")
            )
            or type(value.get("duration")) not in (int, float)
            or not isfinite(value["duration"])
            or value["duration"] <= 0
            or type(value.get("instrumental")) is not bool
            or not isinstance(value.get("plainLyrics"), str | type(None))
        ):
            raise ReferenceUnavailable("Provider returned an invalid lyrics record.")
        return ReferenceRecord(
            value["id"],
            value["artistName"],
            value["trackName"],
            value["albumName"],
            value["duration"],
            value["instrumental"],
            value.get("plainLyrics"),
        )
    except HTTPError as exc:
        if exc.code == 404:
            return None
        raise ReferenceUnavailable(
            f"Provider HTTP {exc.code}; ASR is unchanged."
        ) from exc
    except (URLError, TimeoutError, OSError, ValueError) as exc:
        raise ReferenceUnavailable(
            "Provider unavailable or invalid; ASR is unchanged."
        ) from exc


def _unchanged(
    transcript: Transcript,
    status: ReferenceStatus,
    reason: str,
    review: ReferenceReview | None = None,
) -> ReferenceResult:
    base = review or ReferenceReview(
        status="skipped",
        reason=reason,
        original_segments=transcript.segments,
        original_words=transcript.words,
    )
    return ReferenceResult(
        transcript.segments,
        transcript.words,
        replace(base, status=status, reason=reason),
    )


def review_lyrics(
    transcript: Transcript,
    metadata: ReferenceMetadata | None,
) -> ReferenceResult:
    """Best-effort comparison; missing metadata or an outage never fails ASR."""
    reason = _metadata_reason(metadata)
    if reason is not None:
        return _unchanged(transcript, "skipped", reason)
    if not transcript.words:
        return _unchanged(
            transcript, "skipped", "ASR word alignment is unavailable; no text changed."
        )
    assert metadata is not None
    try:
        record = fetch_reference(metadata)
    except ReferenceUnavailable as exc:
        return _unchanged(transcript, "unavailable", str(exc))
    if record is None:
        return _unchanged(transcript, "not_found", "No matching provider record found.")
    return compare_reference(transcript, metadata, record)


def _single_edit(left: str, right: str) -> bool:
    """Only one-character spelling differences, never phrases or word splits."""
    if min(len(left), len(right)) < 5 or abs(len(left) - len(right)) > 1:
        return False
    if len(left) == len(right):
        return sum(a != b for a, b in zip(left, right, strict=True)) == 1
    short, long = sorted((left, right), key=len)
    return any(short == long[:index] + long[index + 1 :] for index in range(len(long)))


def _word_replacement(original: str, target: str) -> str:
    match = _TOKEN.search(original)
    assert match is not None
    if match.group().isupper():
        target = target.upper()
    elif match.group()[0].isupper():
        target = target[0].upper() + target[1:]
    return original[: match.start()] + target + original[match.end() :]


def compare_reference(
    transcript: Transcript,
    metadata: ReferenceMetadata,
    record: ReferenceRecord,
) -> ReferenceResult:
    """Conservative deterministic comparison; tentative fixes retain ASR evidence."""
    review = ReferenceReview(
        status="rejected",
        reason="Reference metadata does not match the source.",
        source_url=f"https://lrclib.net/api/get/{record.record_id}",
        record_id=record.record_id,
        artist=record.artist,
        title=record.title,
        album=record.album,
        duration_s=record.duration_s,
        original_segments=transcript.segments,
        original_words=transcript.words,
    )
    reason = _metadata_reason(metadata)
    if reason:
        return _unchanged(transcript, "rejected", reason, review)
    if (
        _normalize(metadata.artist) != _normalize(record.artist)
        or _normalize(metadata.title) != _normalize(record.title)
        or (metadata.album and _normalize(metadata.album) != _normalize(record.album))
        or not isfinite(record.duration_s)
        or abs(metadata.duration_s - record.duration_s) > 2
        or any(_VERSION.search(value) for value in (record.title, record.album))
    ):
        return _unchanged(transcript, "rejected", review.reason, review)
    if record.instrumental or not record.plain_lyrics:
        return _unchanged(
            transcript, "rejected", "Reference has no comparable sung lyrics.", review
        )
    source = [_tokens(word.text) for word in transcript.words]
    if not source or any(len(tokens) != 1 for tokens in source):
        return _unchanged(
            transcript,
            "rejected",
            "ASR words do not support one-to-one comparison.",
            review,
        )
    recognized = [tokens[0] for tokens in source]
    reference = _tokens(record.plain_lyrics)
    if min(len(recognized), len(reference)) < 20:
        return _unchanged(
            transcript,
            "rejected",
            "Too few aligned words for a confident comparison.",
            review,
        )
    matcher = SequenceMatcher(None, recognized, reference, autojunk=False)
    matched = sum(block.size for block in matcher.get_matching_blocks())
    agreement = matched / max(len(recognized), len(reference))
    review = replace(review, agreement=agreement)
    if agreement < 0.9:
        return _unchanged(
            transcript,
            "rejected",
            "Lyrics disagree; the recording may be a different version.",
            review,
        )
    # Locate words in the existing segment text before considering any edits.
    # A mismatch (including filtered zero-duration ASR tokens) means no rewrite
    # of that segment: we never reconstruct missing text from the provider.
    locations: dict[int, tuple[int, int, int]] = {}
    for segment_index, segment in enumerate(transcript.segments):
        indices = [
            index
            for index, word in enumerate(transcript.words)
            if word.start_s >= segment.start_s and word.end_s <= segment.end_s
        ]
        spans = list(_TOKEN.finditer(segment.text))
        if [_normalize(span.group()).replace("\u2019", "'") for span in spans] != [
            recognized[index] for index in indices
        ]:
            continue
        for index, span in zip(indices, spans, strict=True):
            locations[index] = segment_index, span.start(), span.end()
    words = list(transcript.words)
    corrections = []
    edits: dict[int, list[tuple[int, int, str]]] = {}
    opcodes = matcher.get_opcodes()
    for position, (tag, a, b, c, d) in enumerate(opcodes):
        if tag != "replace" or b - a != 1 or d - c != 1 or a not in locations:
            continue
        if position == 0 or position == len(opcodes) - 1:
            continue
        before, after = opcodes[position - 1], opcodes[position + 1]
        if (
            before[0] != "equal"
            or after[0] != "equal"
            or before[2] - before[1] < 3
            or after[2] - after[1] < 3
            or transcript.words[a].probability > 0.6
            or not _single_edit(recognized[a], reference[c])
        ):
            continue
        # Repeated choruses can align ambiguously. Require a unique seven-word
        # reference window rather than guessing which repeated line was sung.
        window = reference[c - 3 : c + 4]
        if sum(reference[i : i + 7] == window for i in range(len(reference) - 6)) != 1:
            continue
        replacement = _word_replacement(transcript.words[a].text, reference[c])
        words[a] = replace(transcript.words[a], text=replacement)
        segment_index, start, end = locations[a]
        original_token = transcript.segments[segment_index].text[start:end]
        replacement_token = _word_replacement(original_token, reference[c])
        edits.setdefault(segment_index, []).append((start, end, replacement_token))
        corrections.append(
            ReferenceCorrection(
                a,
                transcript.words[a].text,
                replacement,
                transcript.words[a].start_s,
                transcript.words[a].end_s,
            )
        )
    segments = list(transcript.segments)
    for index, replacements in edits.items():
        text = segments[index].text
        for start, end, replacement in sorted(replacements, reverse=True):
            text = text[:start] + replacement + text[end:]
        segments[index] = replace(segments[index], text=text)
    return ReferenceResult(
        segments,
        words,
        replace(
            review,
            status="corrected" if corrections else "compared",
            reason=(
                "Tentative reference-assisted spelling corrections; "
                "verify against the audio."
                if corrections
                else "Reference compared; no sufficiently safe word corrections found."
            ),
            corrections=corrections,
        ),
    )
