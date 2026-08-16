import asyncio
import shutil
from pathlib import Path

from fastapi import APIRouter

from backend import config, db
from backend.models import DiskUsage, StatusDTO, job_to_dto

router = APIRouter(tags=["status"])


def _dir_size(path: Path) -> int:
    if not path.is_dir():
        return 0
    return sum(f.stat().st_size for f in path.rglob("*") if f.is_file())


def _disk_usage() -> DiskUsage:
    usage = shutil.disk_usage(config.DATA_DIR)
    return DiskUsage(
        total_bytes=usage.total,
        used_bytes=usage.used,
        free_bytes=usage.free,
        uploads_bytes=_dir_size(config.UPLOADS_DIR),
        results_bytes=_dir_size(config.RESULTS_DIR),
        db_bytes=config.DB_PATH.stat().st_size if config.DB_PATH.is_file() else 0,
    )


@router.get("/status")
async def get_status() -> StatusDTO:
    counts = await asyncio.to_thread(db.status_counts)
    recent = await asyncio.to_thread(db.list_recent_jobs, 50)
    disk = await asyncio.to_thread(_disk_usage)
    return StatusDTO(
        total_jobs=sum(counts.values()),
        counts=counts,
        queue_concurrency=config.QUEUE_CONCURRENCY,
        disk=disk,
        recent=[job_to_dto(job, None) for job in recent],
        modal_app=config.MODAL_APP_NAME,
    )
