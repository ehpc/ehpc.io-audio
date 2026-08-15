import asyncio

from fastapi import APIRouter

from backend import db

router = APIRouter(tags=["health"])


@router.get("/health")
async def health() -> dict:
    await asyncio.to_thread(db.health_check)
    return {"status": "ok"}
