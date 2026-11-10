import json
import re
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    JsonValue,
    PrivateAttr,
    ValidationInfo,
    computed_field,
    field_serializer,
    field_validator,
)

from backend import config
from separator.audio import modification_suffix, transposed_key
from separator.lyrics import (
    CanonicalWordPosition,
    RecognitionChunk,
    Transcript,
    TranscriptSection,
    TranscriptSegment,
    TranscriptWord,
    UntimedRecognition,
    transcript_export_text,
)
from separator.lyrics_reference import ReferenceReview
from separator.options import SeparationOptions
from separator.pitch import PitchAnalysis, pitch_from_json, pitch_to_json
from separator.pitched_lyrics import PitchedLyricsTrack, pitched_lyrics_tracks
from separator.song_search import MAX_PLAY_COUNT, RESULT_LIMIT, trusted_thumbnail_url

_AUDIO_EXT = re.compile(r"\.(mp3|wav|flac|m4a|ogg|aac|opus|webm)$", re.IGNORECASE)
_UNSAFE_FILENAME = re.compile(r'[/\\:*?"<>|\x00-\x1f]')


def _clean_title(title: str | None) -> str:
    return _UNSAFE_FILENAME.sub("", _AUDIO_EXT.sub("", title or "")).strip()


def header_title(title: str | None) -> str | None:
    """Presentation title for lyric identity lines (no job-id placeholder)."""
    return _clean_title(title) or None


def _download_base(title: str | None, job_id: int) -> str:
    return _clean_title(title) or str(job_id)


def download_filename(
    title: str | None,
    job_id: int,
    label: str,
    options: SeparationOptions,
    original_key: str | None = None,
) -> str:
    """Canonical presentation name; source key never follows stem pitch shifts."""
    base = _download_base(title, job_id)
    key_suffix = (
        f" - source-key-{original_key.replace(' ', '-')}" if original_key else ""
    )
    display = options.display_name(label)
    if any(mix.id == label for mix in options.mixes):
        display = f"{_UNSAFE_FILENAME.sub('', display).strip() or 'Mix'} [{label}]"
    return f"{base} - {display}{key_suffix}{modification_suffix(options)}.mp3"


def original_filename(title: str | None, job_id: int, suffix: str) -> str:
    """Download name for the original source audio, keeping its real extension."""
    return f"{_download_base(title, job_id)} - original{suffix or '.mp3'}"


def lyrics_filename(title: str | None, job_id: int) -> str:
    return f"{_download_base(title, job_id)} - lyrics.txt"


def pitched_lyrics_filename(
    title: str | None, job_id: int, label: str, options: SeparationOptions
) -> str:
    return (
        f"{_download_base(title, job_id)} - {label} - lyrics-with-pitches"
        f"{modification_suffix(options)}.txt"
    )


class JobStatus(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    DONE = "done"
    FAILED = "failed"


class ResultManifestEntry(BaseModel):
    label: str
    filename: str
    size_bytes: int
    duration_s: float
    download_name: str = ""
    display_name: str = ""


class TranscriptDTO(BaseModel):
    segments: list[TranscriptSegment]
    language: str | None
    status: Literal["recognized", "empty"]
    timestamp_reference: Literal["original"]
    sections: list[TranscriptSection]
    structure_model: str | None
    words: list[TranscriptWord]
    reference: ReferenceReview | None
    asr_model: str | None
    word_alignment: str | None
    recognition_chunks: list[RecognitionChunk]
    untimed: list[UntimedRecognition]
    asr_extras: list[TranscriptSegment]
    canonical_word_positions: list[CanonicalWordPosition]
    _title: str | None = PrivateAttr(default=None)

    @computed_field
    @property
    def timestamped_text(self) -> str:
        return transcript_export_text(
            Transcript(
                segments=self.segments,
                sections=self.sections,
                reference=self.reference,
                untimed=self.untimed,
                asr_extras=self.asr_extras,
            ),
            title=self._title,
        )

    @computed_field
    @property
    def original_timestamped_text(self) -> str | None:
        if self.reference is None:
            return None
        return transcript_export_text(
            Transcript(
                segments=self.reference.original_segments,
                sections=self.sections,
                untimed=self.reference.original_untimed,
            )
        )

    @classmethod
    def from_transcript(
        cls, transcript: Transcript, *, title: str | None = None
    ) -> "TranscriptDTO":
        dto = cls(
            segments=transcript.segments,
            language=transcript.language,
            status=transcript.status,
            timestamp_reference=transcript.timestamp_reference,
            sections=transcript.sections,
            structure_model=transcript.structure_model,
            words=transcript.words,
            reference=transcript.reference,
            asr_model=transcript.asr_model,
            word_alignment=transcript.word_alignment,
            recognition_chunks=transcript.recognition_chunks,
            untimed=transcript.untimed,
            asr_extras=transcript.asr_extras,
            canonical_word_positions=transcript.canonical_word_positions,
        )
        dto._title = title
        return dto


@dataclass
class JobRecord:
    """Raw row shape as stored in sqlite — see backend/db.py for (de)serialization."""

    id: int
    session_id: str
    status: JobStatus
    source_type: str
    source_value: str
    title: str | None
    options: SeparationOptions
    modal_call_id: str | None
    result_manifest: list[ResultManifestEntry] | None
    error_message: str | None
    created_at: int
    started_at: int | None
    finished_at: int | None
    original_key: str | None = None
    transcript: Transcript | None = None
    pitch_json: str | None = None
    active_stage_key: str | None = None


class JobDTO(BaseModel):
    """API-facing job shape — must match the frontend's JobDTO contract exactly."""

    id: int
    status: JobStatus
    position: int | None
    source_type: str
    source_value: str
    title: str | None
    options: SeparationOptions
    manifest: list[ResultManifestEntry] | None
    error_message: str | None
    created_at: int
    has_original: bool
    original_key: str | None
    output_key: str | None
    transcript: TranscriptDTO | None = None
    pitch: PitchAnalysis | None = None
    pitched_lyrics: list[PitchedLyricsTrack] | None = None
    has_pitch_vocals: bool = False

    @field_serializer("pitch")
    def serialize_pitch(self, pitch: PitchAnalysis | None) -> JsonValue:
        # Pydantic's dataclass path omits init=False derived note labels/cents.
        # Keep the browser, history/SSE, and download on one canonical schema.
        return json.loads(pitch_to_json(pitch)) if pitch is not None else None


def _has_original(job_id: int) -> bool:
    """True once the source audio is on disk (uploads always; URLs after download)."""
    directory = config.UPLOADS_DIR / str(job_id)
    return directory.is_dir() and any(directory.iterdir())


def pitch_vocals_path(job: JobRecord) -> Path | None:
    """Resolve only persisted, output-clock full vocals for a completed timeline."""
    if job.status != JobStatus.DONE or job.pitch_json is None:
        return None
    directory = config.RESULTS_DIR / str(job.id)
    for entry in job.result_manifest or []:
        if entry.label == "vocals":
            path = directory / entry.filename
            if path.is_file():
                return path
    private = directory / ".pitch-vocals.mp3"
    return private if private.is_file() else None


def pitched_lyrics_available(job: JobRecord) -> bool:
    """Saved karaoke data and explicitly requested pitched text share exports."""
    return (
        job.status == JobStatus.DONE
        and (job.options.detect_pitch or job.options.extract_pitched_lyrics)
        and job.transcript is not None
        and job.pitch_json is not None
    )


def job_to_dto(job: JobRecord, position: int | None) -> JobDTO:
    pitch = pitch_from_json(job.pitch_json) if job.pitch_json else None
    title = header_title(job.title)
    output_key = transposed_key(job.original_key, job.options.pitch_semitones)
    return JobDTO(
        id=job.id,
        status=job.status,
        position=position if job.status == JobStatus.QUEUED else None,
        source_type=job.source_type,
        source_value=job.source_value,
        title=job.title,
        options=job.options,
        manifest=(
            [
                entry.model_copy(
                    update={
                        "display_name": job.options.display_name(entry.label),
                        "download_name": download_filename(
                            job.title,
                            job.id,
                            entry.label,
                            job.options,
                            job.original_key,
                        ),
                    }
                )
                for entry in job.result_manifest
            ]
            if job.result_manifest is not None
            else None
        ),
        error_message=job.error_message,
        created_at=job.created_at,
        has_original=_has_original(job.id),
        original_key=job.original_key,
        output_key=output_key,
        transcript=(
            TranscriptDTO.from_transcript(job.transcript, title=title)
            if job.transcript
            else None
        ),
        pitch=pitch,
        has_pitch_vocals=pitch_vocals_path(job) is not None,
        pitched_lyrics=(
            pitched_lyrics_tracks(
                job.transcript, pitch, title=title, output_key=output_key
            )
            if pitched_lyrics_available(job)
            and job.transcript is not None
            and pitch is not None
            else None
        ),
    )


class DiskUsage(BaseModel):
    total_bytes: int
    used_bytes: int
    free_bytes: int
    results_bytes: int
    db_bytes: int


class RecentJob(BaseModel):
    """Lightweight job row for the status list — no per-job filesystem lookups."""

    id: int
    status: JobStatus
    title: str | None
    source_value: str
    created_at: int


class StatusDTO(BaseModel):
    """Ops overview shown at /status — spans all sessions, no auth."""

    total_jobs: int
    counts: dict[str, int]
    queue_concurrency: int
    disk: DiskUsage
    recent: list[RecentJob]
    modal_app: str


class SongMatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str = Field(min_length=1)
    artists: list[str]
    url: str = Field(
        pattern=r"^https://music\.youtube\.com/watch\?v=[A-Za-z0-9_-]{11}$"
    )
    duration_seconds: float | None = Field(ge=0, allow_inf_nan=False)
    thumbnail_url: str | None = Field(strict=True)
    play_count: int | None = Field(strict=True, ge=0, le=MAX_PLAY_COUNT)
    play_count_approximate: bool = Field(strict=True)

    @field_validator("thumbnail_url")
    @classmethod
    def trusted_artwork(cls, value: str | None) -> str | None:
        if value is not None and trusted_thumbnail_url(value) is None:
            raise ValueError("Artwork must use a trusted HTTPS image provider.")
        return value

    @field_validator("play_count_approximate")
    @classmethod
    def known_approximation(cls, value: bool, info: ValidationInfo) -> bool:
        if value and info.data.get("play_count") is None:
            raise ValueError("Unavailable plays cannot be approximate.")
        return value


class SearchDone(BaseModel):
    model_config = ConfigDict(extra="forbid")
    status: Literal["done"] = "done"
    songs: list[SongMatch] = Field(min_length=1, max_length=RESULT_LIMIT)

    @field_validator("songs")
    @classmethod
    def unique_versions(cls, songs: list[SongMatch]) -> list[SongMatch]:
        if len({song.url for song in songs}) != len(songs):
            raise ValueError("Song versions must have distinct catalog IDs.")
        return songs
