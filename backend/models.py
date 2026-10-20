import re
from dataclasses import dataclass
from enum import StrEnum

from pydantic import BaseModel

from backend import config
from separator.audio import modification_suffix, transposed_key
from separator.options import SeparationOptions

_AUDIO_EXT = re.compile(r"\.(mp3|wav|flac|m4a|ogg|aac|opus|webm)$", re.IGNORECASE)
_UNSAFE_FILENAME = re.compile(r'[/\\:*?"<>|\x00-\x1f]')


def _download_base(title: str | None, job_id: int) -> str:
    base = _UNSAFE_FILENAME.sub("", _AUDIO_EXT.sub("", title or "")).strip()
    return base or str(job_id)


def download_filename(
    title: str | None,
    job_id: int,
    label: str,
    options: SeparationOptions,
) -> str:
    """Canonical user-facing stem name, including any audio transformations."""
    base = _download_base(title, job_id)
    return f"{base} - {label}{modification_suffix(options)}.mp3"


def original_filename(title: str | None, job_id: int, suffix: str) -> str:
    """Download name for the original source audio, keeping its real extension."""
    return f"{_download_base(title, job_id)} - original{suffix or '.mp3'}"


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


def _has_original(job_id: int) -> bool:
    """True once the source audio is on disk (uploads always; URLs after download)."""
    directory = config.UPLOADS_DIR / str(job_id)
    return directory.is_dir() and any(directory.iterdir())


def job_to_dto(job: JobRecord, position: int | None) -> JobDTO:
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
                        "download_name": download_filename(
                            job.title, job.id, entry.label, job.options
                        )
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
        output_key=transposed_key(job.original_key, job.options.pitch_semitones),
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
