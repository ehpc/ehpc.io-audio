"""Lightweight transcript contract shared by the GPU worker and web API."""

import json
from dataclasses import dataclass, field
from math import isfinite
from typing import Literal


@dataclass(frozen=True)
class TranscriptSegment:
    start_s: float
    end_s: float
    text: str

    def __post_init__(self) -> None:
        if (
            not isfinite(self.start_s)
            or not isfinite(self.end_s)
            or self.start_s < 0
            or self.end_s < self.start_s
        ):
            raise ValueError("Invalid transcript segment timestamps")


@dataclass(frozen=True)
class Transcript:
    segments: list[TranscriptSegment] = field(default_factory=list)
    language: str | None = None
    timestamp_reference: Literal["original"] = "original"

    status: Literal["recognized", "empty"] = field(init=False, default="empty")

    def __post_init__(self) -> None:
        object.__setattr__(self, "status", "recognized" if self.segments else "empty")
        if any(
            right.start_s < left.end_s
            for left, right in zip(self.segments, self.segments[1:], strict=False)
        ):
            raise ValueError("Transcript segments must be ordered and non-overlapping")


def format_timestamp(seconds: float) -> str:
    milliseconds = round(seconds * 1000)
    minutes, milliseconds = divmod(milliseconds, 60_000)
    seconds, milliseconds = divmod(milliseconds, 1000)
    return f"{minutes:02d}:{seconds:02d}.{milliseconds:03d}"


def transcript_text(segments: list[TranscriptSegment]) -> str:
    """UTF-8-compatible TXT, with timestamps on the unchanged source clock."""
    return "".join(
        f"[{format_timestamp(segment.start_s)} --> "
        f"{format_timestamp(segment.end_s)}] {segment.text}\n"
        for segment in segments
    )


def transcript_from_json(data: str) -> Transcript:
    value = json.loads(data)
    return Transcript(
        segments=[TranscriptSegment(**segment) for segment in value["segments"]],
        language=value["language"],
        timestamp_reference=value["timestamp_reference"],
    )
