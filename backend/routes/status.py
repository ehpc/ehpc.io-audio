import asyncio
import shutil

from fastapi import APIRouter

from backend import config, db
from backend.models import DiskUsage, RecentJob, StatusDTO

router = APIRouter(tags=["status"])


def _disk_usage() -> DiskUsage:
    usage = shutil.disk_usage(config.DATA_DIR)
    return DiskUsage(
        total_bytes=usage.total,
        used_bytes=usage.used,
        free_bytes=usage.free,
        # From the DB (manifest sizes), not a filesystem walk — keeps this fast.
        results_bytes=db.total_result_bytes(),
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
        recent=[
            RecentJob(
                id=job.id,
                status=job.status,
                title=job.title,
                source_value=job.source_value,
                created_at=job.created_at,
            )
            for job in recent
        ],
        modal_app=config.MODAL_APP_NAME,
    )
