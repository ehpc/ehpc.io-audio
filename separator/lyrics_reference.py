"""Exact-version LRCLIB lookup and independently corroborated lyric alignment.

Provider text never supplies timestamps. Unconfirmed lines remain explicitly
untimed; the original, unprompted recognizer output is retained verbatim.
"""

import hashlib
import json
import re
import unicodedata
from dataclasses import asdict, dataclass, field, replace
from datetime import UTC, datetime
from difflib import SequenceMatcher
from itertools import pairwise
from math import isfinite, log
from pathlib import Path
from statistics import median
from typing import Literal
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from separator.lyrics import (
    Transcript,
    TranscriptSegment,
    TranscriptWord,
    UntimedRecognition,
)

_API = "https://lrclib.net/api/get"
_USER_AGENT = "ehpc's Vocal Tools v0.1 (https://github.com/ehpc/ehpc.io-audio)"
_MAX_RESPONSE_BYTES = 1_000_000
_LOCAL_CONTEXT_PADDING_S = 1.0
_TOKEN = re.compile(r"[^\W_]+(?:['\u2019][^\W_]+)*", re.UNICODE)
ReferenceStatus = Literal[
    "skipped",
    "unavailable",
    "not_found",
    "rejected",
    "matched",
    "aligned",
    "partial",
    "unconfirmed",
    "compared",
    "corrected",  # Last two: historical data only.
]


@dataclass(frozen=True)
class ReferenceMetadata:
    artist: str
    title: str
    duration_s: float
    album: str | None = None


@dataclass(frozen=True)
class ReferenceLine:
    text: str
    status: Literal["aligned", "unconfirmed"] = "unconfirmed"
    support: float = 0.0
    start_s: float | None = None
    end_s: float | None = None
    reason: str = "Not independently recognized in the audio."
    unconfirmed_words: list[str] = field(default_factory=list)
    recognized_variant: str | None = None
    group: int = 0
    canonical_log_score: float | None = None
    alternative_log_score: float | None = None
    acoustic_margin: float | None = None
    acoustic_log_odds: float | None = None
    acoustic_alternative: str | None = None
    context_start_s: float | None = None
    context_end_s: float | None = None
    provider_start_s: float | None = None
    provider_end_s: float | None = None


@dataclass(frozen=True)
class HistoricalReferenceCorrection:
    """Read-only provenance from jobs produced by the retired spelling policy."""

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
    fetched_at: str | None = None
    cached: bool = False
    alignment_model: str | None = None
    lines: list[ReferenceLine] = field(default_factory=list)
    original_segments: list[TranscriptSegment] = field(default_factory=list)
    original_words: list[TranscriptWord] = field(default_factory=list)
    original_untimed: list[UntimedRecognition] = field(default_factory=list)
    corrections: list[HistoricalReferenceCorrection] = field(default_factory=list)
    provider_timing_status: Literal["absent", "candidate", "validated", "rejected"] = (
        "absent"
    )
    provider_timing_reason: str | None = None
    synced_lyrics_sha256: str | None = None


@dataclass(frozen=True)
class ReferenceRecord:
    record_id: int
    artist: str
    title: str
    album: str
    duration_s: float
    instrumental: bool
    plain_lyrics: str | None
    synced_lyrics: str | None = None


@dataclass(frozen=True)
class ReferenceLookup:
    record: ReferenceRecord | None
    review: ReferenceReview


@dataclass(frozen=True)
class ReferencePhrase:
    """A 20-30s acoustic context anchored by unprompted ASR."""

    line_indices: list[int]
    start_s: float
    end_s: float
    text: str
    recognized_lines: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class AcousticEvidence:
    """Whole-context CTC likelihoods differing only in the candidate line."""

    canonical_log_score: float
    alternative_log_score: float
    recognized_text: str
    frame_count: int
    alternative_text: str
    context_start_s: float
    context_end_s: float

    @property
    def margin(self) -> float:
        return self.canonical_log_score - self.alternative_log_score

    @property
    def log_odds(self) -> float:
        return self.margin * self.frame_count


class ReferenceUnavailable(Exception):
    """The optional provider cannot supply a usable response."""


def reference_review_from_dict(value: dict) -> ReferenceReview:
    return ReferenceReview(
        **{
            key: value[key]
            for key in (
                "status",
                "reason",
                "provider",
                "source_url",
                "record_id",
                "artist",
                "title",
                "album",
                "duration_s",
                "agreement",
                "fetched_at",
                "cached",
                "alignment_model",
                "provider_timing_status",
                "provider_timing_reason",
                "synced_lyrics_sha256",
            )
            if key in value
        },
        lines=[ReferenceLine(**item) for item in value.get("lines", [])],
        original_segments=[
            TranscriptSegment(**item) for item in value.get("original_segments", [])
        ],
        original_words=[
            TranscriptWord(**item) for item in value.get("original_words", [])
        ],
        original_untimed=[
            UntimedRecognition(**item) for item in value.get("original_untimed", [])
        ],
        corrections=[
            HistoricalReferenceCorrection(**item)
            for item in value.get("corrections", [])
        ],
    )


def normalize(text: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", text).casefold().split())


def tokens(text: str) -> list[str]:
    return [
        normalize(match.group()).replace("\u2019", "'")
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
    return None


def _record(value: dict) -> ReferenceRecord:
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
        or not isinstance(value.get("syncedLyrics"), str | type(None))
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
        value.get("syncedLyrics"),
    )


def fetch_reference(metadata: ReferenceMetadata) -> ReferenceRecord | None:
    """One bounded documented API request; no scraping, retries or secret keys."""
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
        return _record(json.loads(raw))
    except HTTPError as exc:
        if exc.code == 404:
            return None
        raise ReferenceUnavailable(
            f"Provider HTTP {exc.code}; using independent ASR."
        ) from exc
    except (URLError, TimeoutError, OSError, ValueError) as exc:
        raise ReferenceUnavailable(
            "Provider unavailable or invalid; using independent ASR."
        ) from exc


def _matches(metadata: ReferenceMetadata, record: ReferenceRecord) -> bool:
    # Full names, including live/remix/version qualifiers, must match. Never
    # strip qualifiers to make an album recording stand in for another version.
    return (
        normalize(metadata.artist) == normalize(record.artist)
        and normalize(metadata.title) == normalize(record.title)
        and (not metadata.album or normalize(metadata.album) == normalize(record.album))
        and isfinite(record.duration_s)
        and abs(metadata.duration_s - record.duration_s) <= 2
    )


def _cache_path(cache: Path, metadata: ReferenceMetadata) -> Path:
    # Container/encoder duration precision is not a different song version.
    # Revalidate the complete record after reading; never reuse by title alone.
    identity = {
        "artist": normalize(metadata.artist),
        "title": normalize(metadata.title),
        "album": normalize(metadata.album or ""),
        "duration_s": round(metadata.duration_s),
    }
    key = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
    return cache / f"{key}.json"


def _store_reference(
    cache: Path,
    metadata: ReferenceMetadata,
    record: ReferenceRecord,
    fetched_at: str,
) -> None:
    if not _matches(metadata, record) or not record.plain_lyrics:
        raise ValueError("Only a matching successful provider record can be cached")
    path = _cache_path(cache, metadata)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            {"record": asdict(record), "fetched_at": fetched_at},
            ensure_ascii=False,
        ),
        "utf-8",
    )


def lookup_reference(
    metadata: ReferenceMetadata | None, cache: Path | None = None
) -> ReferenceLookup:
    reason = _metadata_reason(metadata)
    if reason:
        return ReferenceLookup(None, ReferenceReview("skipped", reason))
    assert metadata is not None
    cached = False
    fetched_at = None
    record = None
    if cache is not None:
        cache_file = _cache_path(cache, metadata)
        try:
            value = json.loads(cache_file.read_text("utf-8"))
            record = ReferenceRecord(**value["record"])
            fetched_at = value["fetched_at"]
            cached = _matches(metadata, record)
            if not cached:
                record = None
        except (OSError, ValueError, TypeError, KeyError):
            record = None
    if record is None:
        try:
            record = fetch_reference(metadata)
        except ReferenceUnavailable as exc:
            return ReferenceLookup(None, ReferenceReview("unavailable", str(exc)))
        if record is None:
            return ReferenceLookup(
                None,
                ReferenceReview(
                    "not_found",
                    "No exact-version lyrics record found; using independent ASR.",
                ),
            )
        fetched_at = datetime.now(UTC).isoformat()
    review = ReferenceReview(
        "rejected",
        "Reference metadata does not match the source.",
        source_url=f"https://lrclib.net/api/get/{record.record_id}",
        record_id=record.record_id,
        artist=record.artist,
        title=record.title,
        album=record.album,
        duration_s=record.duration_s,
        fetched_at=fetched_at,
        cached=cached,
    )
    if not _matches(metadata, record):
        return ReferenceLookup(None, review)
    if (
        record.instrumental
        or not record.plain_lyrics
        or not tokens(record.plain_lyrics)
    ):
        return ReferenceLookup(
            None,
            replace(
                review,
                reason="Reference contains no sung lyrics; using independent ASR.",
            ),
        )
    if not cached and cache is not None:
        assert fetched_at is not None
        _store_reference(cache, metadata, record, fetched_at)
    return ReferenceLookup(
        record,
        replace(
            review,
            status="matched",
            reason=(
                "Exact metadata matched; audio corroboration "
                "and forced alignment are required."
            ),
            lines=reference_lines(
                record.plain_lyrics,
                record.synced_lyrics,
                record.duration_s,
            ),
            provider_timing_status="candidate" if record.synced_lyrics else "absent",
            synced_lyrics_sha256=(
                hashlib.sha256(record.synced_lyrics.encode()).hexdigest()
                if record.synced_lyrics
                else None
            ),
        ),
    )


type TokenPair = tuple[int | None, int | None]


def reference_lines(
    text: str,
    synced_lyrics: str | None = None,
    duration_s: float | None = None,
) -> list[ReferenceLine]:
    lines = []
    group = 0
    for line in text.splitlines():
        if tokens(line):
            lines.append(ReferenceLine(line.strip(), group=group))
        elif lines:
            group += 1
    return attach_provider_priors(lines, synced_lyrics, duration_s)


def attach_provider_priors(
    lines: list[ReferenceLine],
    synced_lyrics: str | None,
    duration_s: float | None,
) -> list[ReferenceLine]:
    """Parse LRC into candidate search bounds, never transcript timestamps."""
    if not synced_lyrics or duration_s is None:
        return lines
    timestamp = re.compile(r"\[(\d+):(\d{2}(?:\.\d+)?)\]")
    entries: list[tuple[float, str]] = []
    for row in synced_lyrics.splitlines():
        found = list(timestamp.finditer(row))
        text = timestamp.sub("", row).strip()
        for match in found:
            seconds = float(match[2])
            start = int(match[1]) * 60 + seconds
            if seconds >= 60 or not 0 <= start <= duration_s:
                return lines
            entries.append((start, text))
    entries.sort(key=lambda item: item[0])
    if not entries or any(right[0] <= left[0] for left, right in pairwise(entries)):
        return lines
    nonempty = [
        (index, text) for index, (_, text) in enumerate(entries) if tokens(text)
    ]
    if [tokens(text) for _, text in nonempty] != [tokens(line.text) for line in lines]:
        return lines
    return [
        replace(
            line,
            provider_start_s=entries[index][0],
            provider_end_s=entries[index + 1][0]
            if index + 1 < len(entries)
            else duration_s,
        )
        for line, (index, _) in zip(lines, nonempty, strict=True)
    ]


def validate_provider_priors(
    review: ReferenceReview,
    source: list[TranscriptWord],
    matches: dict[int, int],
    word_indices: list[int],
    duration_s: float,
) -> ReferenceReview:
    if review.provider_timing_status == "absent":
        return review
    offsets: list[tuple[float, float]] = []
    offset = 0
    for line in review.lines:
        if line.provider_start_s is None or line.provider_end_s is None:
            return replace(
                review,
                provider_timing_status="rejected",
                provider_timing_reason=(
                    "Provider LRC text/order/bounds do not match "
                    "canonical lyrics; priors ignored."
                ),
            )
        if offset in matches:
            word = source[word_indices[matches[offset]]]
            if (word.alignment_score or word.probability or 0) >= 0.03:
                offsets.append(
                    (line.provider_start_s, word.start_s - line.provider_start_s)
                )
        offset += len(tokens(line.text))
    if len(offsets) >= min(3, len(review.lines)):
        shift = median(delta for _, delta in offsets)
        agreement = sum(abs(delta - shift) <= 1.5 for _, delta in offsets) / len(
            offsets
        )
        spread = offsets[-1][0] - offsets[0][0]
        if abs(shift) <= 1.5 and agreement >= 0.6 and spread >= min(30, duration_s / 4):
            return replace(
                review,
                provider_timing_status="validated",
                provider_timing_reason=(
                    f"{len(offsets)} independently recognized onset anchors "
                    f"support the provider clock (median offset {shift:.2f}s). "
                    "LRC is a search prior, not measured word timing."
                ),
            )
    return replace(
        review,
        provider_timing_status="rejected",
        provider_timing_reason=(
            "Insufficient consistent independent audio anchors "
            "for the provider clock; priors ignored."
        ),
    )


def token_alignment(reference: list[str], recognized: list[str]) -> list[TokenPair]:
    """Minimum-edit monotonic alignment; retain substitutions and omissions."""
    rows = [[0] * (len(recognized) + 1) for _ in range(len(reference) + 1)]
    rows[0] = list(range(len(recognized) + 1))
    for i, token in enumerate(reference, 1):
        rows[i][0] = i
        for j, heard in enumerate(recognized, 1):
            rows[i][j] = min(
                rows[i - 1][j] + 1,
                rows[i][j - 1] + 1,
                rows[i - 1][j - 1] + (token != heard),
            )
    pairs = []
    i, j = len(reference), len(recognized)
    while i or j:
        if (
            i
            and j
            and rows[i][j]
            == rows[i - 1][j - 1] + (reference[i - 1] != recognized[j - 1])
        ):
            pairs.append((i - 1, j - 1))
            i, j = i - 1, j - 1
        elif i and (not j or rows[i][j] == rows[i - 1][j] + 1):
            pairs.append((i - 1, None))
            i -= 1
        else:
            pairs.append((None, j - 1))
            j -= 1
    return list(reversed(pairs))


def ordered_matches(reference: list[str], recognized: list[str]) -> dict[int, int]:
    return {
        left: right
        for left, right in token_alignment(reference, recognized)
        if left is not None
        and right is not None
        and reference[left] == recognized[right]
    }


def counterfactual_line(canonical: str, recognized: str) -> str:
    """Challenge lexical variants without favoring ASR's omitted words.

    Unrecognized canonical words stay identical in BOTH scoring hypotheses.
    They cannot count as independent ASR agreement or acquire word timestamps
    merely because the phrase-level reference hypothesis wins.
    """
    expected, heard = tokens(canonical), tokens(recognized)
    words = []
    for left, right in token_alignment(expected, heard):
        if right is not None:
            words.append(heard[right])
        elif left is not None:
            words.append(expected[left])
    return " ".join(words)


def plan_reference(
    transcript: Transcript,
    review: ReferenceReview,
    duration_s: float,
    evidence_words: list[TranscriptWord] | None = None,
) -> tuple[ReferenceReview, list[ReferencePhrase]]:
    """Locate canonical stanzas using raw unprompted lexical/audio anchors.

    Short lines are not individually gated: a one-word ASR substitution in a
    two-word line must be challenged acoustically in its full phrase context.
    Candidate selection is not acceptance; omitted/contradictory lines still
    require independent local evidence at publication.
    """
    source = transcript.words if evidence_words is None else evidence_words
    flat = [token for line in review.lines for token in tokens(line.text)]
    heard = []
    word_indices = []
    for index, word in enumerate(source):
        for token in tokens(word.text):
            heard.append(token)
            word_indices.append(index)
    matches = ordered_matches(flat, heard)
    review = validate_provider_priors(
        review,
        source,
        matches,
        word_indices,
        duration_s,
    )
    token_lines = [
        index for index, line in enumerate(review.lines) for _ in tokens(line.text)
    ]
    variants: dict[int, list[str]] = {index: [] for index in range(len(review.lines))}
    current_line = 0
    for left, right in token_alignment(flat, heard):
        if left is not None:
            current_line = token_lines[left]
        if right is not None and current_line in variants:
            variants[current_line].append(heard[right])
    lines = []
    line_anchors: list[list[TranscriptWord]] = []
    offset = 0
    for line in review.lines:
        count = len(tokens(line.text))
        anchors = [
            source[word_indices[matches[i]]]
            for i in range(offset, offset + count)
            if i in matches
        ]
        lines.append(replace(line, support=len(anchors) / count))
        line_anchors.append(anchors)
        offset += count
    groups: list[list[int]] = []
    explicit_stanzas = len({line.group for line in lines}) > 1
    for index, line in enumerate(lines):
        anchors = line_anchors[index]
        previous_anchors = [
            anchor
            for previous in (groups[-1] if groups else [])
            for anchor in line_anchors[previous]
        ]
        split = (
            not groups
            or line.group != lines[groups[-1][-1]].group
            or (
                not explicit_stanzas
                and anchors
                and previous_anchors
                and anchors[-1].end_s - previous_anchors[0].start_s > 26
            )
        )
        if split:
            groups.append([])
        groups[-1].append(index)
    phrases = []
    for indices in groups:
        anchors = [anchor for index in indices for anchor in line_anchors[index]]
        count = sum(len(tokens(lines[index].text)) for index in indices)
        if len(anchors) < min(3, count) or len(anchors) / count < 0.5:
            continue
        strong = [
            anchor
            for anchor in anchors
            if anchor.alignment_score is None or anchor.alignment_score >= 0.03
        ]
        if not strong:
            continue
        provider_start = lines[indices[0]].provider_start_s
        start = max(
            0,
            provider_start - 1.5
            if review.provider_timing_status == "validated"
            and provider_start is not None
            else strong[0].start_s - 2,
        )
        phrases.append(
            ReferencePhrase(
                indices,
                start,
                min(duration_s, start + 30),
                "\n".join(lines[index].text for index in indices),
                [" ".join(variants[index]) for index in indices],
            )
        )
    agreement = len(matches) / max(len(flat), len(heard), 1)
    return replace(
        review,
        lines=lines,
        agreement=agreement,
        original_segments=transcript.segments,
        original_words=transcript.words,
        original_untimed=transcript.untimed,
    ), phrases


def apply_reference(
    transcript: Transcript,
    review: ReferenceReview,
    aligned: dict[int, list[TranscriptWord]],
    acoustic_evidence: dict[int, AcousticEvidence] | None = None,
) -> Transcript:
    """Publish only locally corroborated timings; retain ASR-only extras/adlibs."""
    lines = []
    accepted = []
    words = []
    previous_end = 0.0
    for index, line in enumerate(review.lines):
        candidate = aligned.get(index, [])
        expected = tokens(line.text)
        if (
            not candidate
            or [token for word in candidate for token in tokens(word.text)] != expected
            or candidate[0].start_s < previous_end
            or any(b.start_s < a.end_s for a, b in pairwise(candidate))
        ):
            lines.append(
                replace(
                    line,
                    reason=(
                        "Insufficient independent recognition "
                        "or reliable word alignment."
                    ),
                )
            )
            continue
        evidence = (acoustic_evidence or {}).get(index)
        if evidence is not None:
            nearby = tokens(evidence.recognized_text)
            line = replace(
                line,
                canonical_log_score=evidence.canonical_log_score,
                alternative_log_score=evidence.alternative_log_score,
                acoustic_margin=evidence.margin,
                acoustic_log_odds=evidence.log_odds,
                acoustic_alternative=evidence.alternative_text,
                context_start_s=evidence.context_start_s,
                context_end_s=evidence.context_end_s,
            )
        else:
            nearby = [
                token
                for word in transcript.words
                if candidate[0].start_s
                <= (word.start_s + word.end_s) / 2
                <= candidate[-1].end_s
                for token in tokens(word.text)
            ]
        # Keep contradictory edge words, not just text between exact anchors.
        # Trimming to the matching block would turn a changed final/initial word
        # into an apparent omission and could silently publish the wrong variant.
        local = nearby
        local_matcher = SequenceMatcher(None, expected, local, autojunk=False)
        matched = sum(block.size for block in local_matcher.get_matching_blocks())
        support = matched / max(len(expected), 1)
        contradictory = any(
            tag in {"replace", "insert"}
            for tag, _, _, _, _ in local_matcher.get_opcodes()
        )
        unconfirmed = [
            word
            for tag, start, end, _, _ in local_matcher.get_opcodes()
            if tag != "equal"
            for word in expected[start:end]
        ]
        mean_score = sum(word.alignment_score or 0 for word in candidate) / len(
            candidate
        )
        acoustically_resolved = (
            evidence is not None
            and isfinite(evidence.canonical_log_score)
            and isfinite(evidence.alternative_log_score)
            and evidence.log_odds >= log(2)
            and mean_score >= 0.06
        )
        if (evidence is not None and mean_score < 0.04) or (
            (support < 2 / 3 or contradictory) and not acoustically_resolved
        ):
            lines.append(
                replace(
                    line,
                    support=support,
                    unconfirmed_words=unconfirmed,
                    recognized_variant=" ".join(local) if local != expected else None,
                    reason=(
                        "Independent recognition contains a conflicting lyric "
                        "or adlib; ASR preserved in comparison."
                        if contradictory
                        else "Forced timestamps were not corroborated "
                        "by independent local recognition."
                    ),
                )
            )
            continue
        start, end = candidate[0].start_s, candidate[-1].end_s
        accepted.append(TranscriptSegment(start, end, line.text))
        # Raw ASR agreement and a positive same-frame acoustic comparison are
        # distinct evidence. Low-emission-score provider words stay untimed,
        # even when the phrase as a whole is reference-aligned.
        supported_indices = {
            index
            for block in local_matcher.get_matching_blocks()
            for index in range(block.a, block.a + block.size)
        }
        published_indices = {
            index
            for index, word in enumerate(candidate)
            if (
                index in supported_indices
                or (acoustically_resolved and (word.alignment_score or 0) >= 0.1)
            )
            and (word.alignment_score is None or word.alignment_score >= 0.03)
        }
        unconfirmed = [
            word.text
            for index, word in enumerate(candidate)
            if index not in published_indices
        ]
        words.extend(
            replace(word, origin="reference-aligned")
            for index, word in enumerate(candidate)
            if index in published_indices
        )
        previous_end = end
        lines.append(
            replace(
                line,
                status="aligned",
                support=support,
                start_s=start,
                end_s=end,
                unconfirmed_words=unconfirmed,
                recognized_variant=" ".join(local) if local != expected else None,
                reason=(
                    "Reference-aligned after a positive whole-context acoustic "
                    "comparison against the preserved independent ASR variant. "
                    "Scores are not calibrated lyric correctness."
                    if acoustically_resolved and local != expected
                    else "Reference-aligned phrase with independent lexical "
                    "support; not proof of every canonical word. Uncorroborated "
                    "words have no published word timestamps."
                ),
            )
        )
    # Canonical text is primary, including explicitly untimed disputed lines.
    # Recording variants within reference candidate regions belong in comparison
    # provenance, not as typo-filled replacements in the primary lyric view.
    compared_regions = []
    for index, candidate in aligned.items():
        if not candidate:
            continue
        padding = (
            _LOCAL_CONTEXT_PADDING_S
            if index < len(lines) and lines[index].status == "unconfirmed"
            else 0
        )
        compared_regions.append(
            (
                candidate[0].start_s - padding,
                candidate[-1].end_s + padding,
            )
        )
    if review.provider_timing_status == "validated":
        compared_regions.extend(
            (line.provider_start_s, line.provider_end_s)
            for line in review.lines
            if line.provider_start_s is not None and line.provider_end_s is not None
        )
    extras = [
        replace(word, origin="asr-extra")
        for word in transcript.words
        if not any(
            word.start_s < end and word.end_s > start for start, end in compared_regions
        )
    ]
    asr_extras = [
        TranscriptSegment(word.start_s, word.end_s, word.text) for word in extras
    ]
    words = sorted([*words, *extras], key=lambda item: item.start_s)
    count = sum(line.status == "aligned" for line in lines)
    status = (
        "aligned"
        if count == len(lines) and lines
        else "partial"
        if count
        else "unconfirmed"
    )
    return replace(
        transcript,
        segments=accepted,
        words=words,
        asr_extras=asr_extras,
        # Failed ASR alignment remains in original provenance, not mixed into
        # the canonical reference-first primary text.
        untimed=[],
        reference=replace(
            review,
            status=status,
            lines=lines,
            alignment_model="torchaudio/MMS_FA",
            original_segments=transcript.segments,
            original_words=transcript.words,
            original_untimed=transcript.untimed,
            reason=(
                f"{count}/{len(lines)} canonical lines reference-aligned "
                "with local recognition checks. Unconfirmed lines have no "
                "timestamps. Automatic recognition/alignment cannot "
                "guarantee 100% accuracy."
            ),
        ),
    )
