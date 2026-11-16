"""Private output-clock listening audio, separate from public result manifests."""

from backend import config
from backend.models import JobRecord, result_directory
from separator.artifact_cache import atomic_write
from separator.audio import transform_audio


def persist_pitch_vocals(job: JobRecord, data: bytes) -> None:
    audio = transform_audio(data, job.options, config.DATA_DIR / "artifacts")
    atomic_write(result_directory(job) / ".pitch-vocals.mp3", audio)
