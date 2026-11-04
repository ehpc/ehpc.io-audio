import asyncio
import json
import uuid
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from backend import db, modal_client
from backend.session import get_session_id
from separator.song_search import QUERY_MAX_LENGTH, SEARCH_TTL, normalize_query

router = APIRouter(tags=["song-search"])
_ERRORS = {
    "no_match": 404,
    "ambiguous": 422,
    "invalid_model": 502,
    "catalog_unavailable": 502,
    "unavailable": 503,
}


class SongSearchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    query: str = Field(strict=True, max_length=QUERY_MAX_LENGTH)

    @field_validator("query")
    @classmethod
    def clean_query(cls, value: str) -> str:
        return normalize_query(value)


class Song(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str = Field(min_length=1)
    artists: list[str]
    url: str = Field(
        pattern=r"^https://music\.youtube\.com/watch\?v=[A-Za-z0-9_-]{11}$"
    )
    duration_seconds: float | None = Field(ge=0, allow_inf_nan=False)


class SearchStarted(BaseModel):
    search_id: str
    status: Literal["pending"] = "pending"


class SearchPending(BaseModel):
    status: Literal["pending"] = "pending"


class SearchDone(BaseModel):
    model_config = ConfigDict(extra="forbid")
    status: Literal["done"] = "done"
    song: Song


@router.post("/song-search", status_code=202)
async def start_search(
    body: SongSearchRequest,
    session_id: Annotated[str, Depends(get_session_id)],
) -> SearchStarted:
    try:
        call_id = await asyncio.wait_for(
            modal_client.spawn_song_search(body.query), timeout=15
        )
    except Exception as exc:
        raise HTTPException(
            503, "Song finder is unavailable. Try again later."
        ) from exc
    search_id = uuid.uuid4().hex
    await asyncio.to_thread(db.create_song_search, search_id, session_id, call_id)
    return SearchStarted(search_id=search_id)


@router.get("/song-search/{search_id}")
async def get_search(
    search_id: str,
    session_id: Annotated[str, Depends(get_session_id)],
) -> SearchPending | SearchDone:
    row = await asyncio.to_thread(db.get_song_search, search_id, session_id, SEARCH_TTL)
    if row is None:
        raise HTTPException(404, "Song search not found or expired.")
    if row["result_json"] is not None:
        return _search_response(json.loads(row["result_json"]))
    try:
        result = await asyncio.wait_for(
            modal_client.poll_song_search(row["modal_call_id"]), timeout=5
        )
    except Exception:
        result = {
            "status": "failed",
            "code": "unavailable",
            "detail": "Song finder is unavailable. Try again later.",
        }
    if result is None:
        return SearchPending()
    try:
        response = _search_response(result)
    except HTTPException as exc:
        result = {"http_error": exc.status_code, "detail": exc.detail}
        await asyncio.to_thread(db.finish_song_search, search_id, result)
        raise
    await asyncio.to_thread(db.finish_song_search, search_id, result)
    return response


def _search_response(result: dict) -> SearchDone:
    if isinstance(result, dict):
        if "http_error" in result:
            raise HTTPException(result["http_error"], result["detail"])
        if result.get("status") == "failed":
            code = result.get("code")
            detail = result.get("detail")
            if isinstance(code, str) and code in _ERRORS and isinstance(detail, str):
                raise HTTPException(_ERRORS[code], detail)
    try:
        return SearchDone.model_validate(result)
    except ValidationError as exc:
        raise HTTPException(502, "Song finder returned invalid output.") from exc
