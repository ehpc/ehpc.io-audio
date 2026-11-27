"""Owner-scoped library metadata, independent of physical processing work."""

import asyncio
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException

from backend import db, song_projection
from backend.models import SongDetail, SongSummary
from backend.session import get_session_id

router = APIRouter(tags=["songs"])


@router.get("/songs", response_model=list[SongSummary])
async def list_songs(
    session_id: Annotated[str, Depends(get_session_id)], sort: db.JobSort = "usage"
) -> list[SongSummary]:
    return await asyncio.to_thread(song_projection.summaries, session_id, sort)


@router.get("/songs/current", response_model=SongSummary | None)
async def current_song(
    session_id: Annotated[str, Depends(get_session_id)],
) -> SongSummary | None:
    return await asyncio.to_thread(song_projection.current, session_id)


@router.get("/songs/{song_id}", response_model=SongDetail)
async def get_song(
    song_id: int, session_id: Annotated[str, Depends(get_session_id)]
) -> SongDetail:
    song = await asyncio.to_thread(song_projection.detail, session_id, song_id)
    if song is None:
        raise HTTPException(404, "song not found")
    return song


@router.post("/songs/{song_id}/open")
async def open_song(
    song_id: int, session_id: Annotated[str, Depends(get_session_id)]
) -> dict[str, int]:
    count = await asyncio.to_thread(db.record_song_open, song_id, session_id)
    if count is None:
        raise HTTPException(404, "song not found")
    return {"id": song_id, "open_count": count}
