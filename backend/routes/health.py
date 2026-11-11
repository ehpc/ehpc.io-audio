import asyncio

from fastapi import APIRouter, HTTPException

from backend import db, drain

router = APIRouter(tags=["health"])


@router.get("/health")
async def health() -> dict:
    await asyncio.to_thread(db.health_check)
    return {"status": "ok"}


@router.get("/ready")
async def ready() -> dict:
    if drain.state.draining:
        raise HTTPException(503, "Server is draining")
    await asyncio.to_thread(db.health_check)
    return {"status": "ok"}
