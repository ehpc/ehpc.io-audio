import asyncio
import json
import uuid
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    ValidationError,
    field_validator,
)

from backend import db
from backend.models import SearchDone
from backend.session import get_session_id
from separator.song_search import (
    QUERY_MAX_LENGTH,
    SEARCH_HTTP_ERRORS,
    SEARCH_RESULT_TTL,
    SEARCH_TTL,
    normalize_query,
    query_cache_key,
)

router = APIRouter(tags=["song-search"])


class SongSearchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    query: str = Field(strict=True, max_length=QUERY_MAX_LENGTH)

    @field_validator("query")
    @classmethod
    def clean_query(cls, value: str) -> str:
        return normalize_query(value)


class SearchStarted(BaseModel):
    search_id: str
    status: Literal["pending"] = "pending"


class SearchPending(BaseModel):
    status: Literal["pending"] = "pending"


@router.post("/song-search", status_code=202)
async def start_search(
    body: SongSearchRequest,
    session_id: Annotated[str, Depends(get_session_id)],
) -> SearchStarted:
    search_id = uuid.uuid4().hex
    query_key = query_cache_key(body.query)
    cached = await asyncio.to_thread(
        db.get_cached_song_search, query_key, SEARCH_RESULT_TTL
    )
    if cached is not None:
        try:
            result = SearchDone.model_validate_json(cached["result_json"])
        except ValidationError as exc:
            raise HTTPException(502, "Song finder returned invalid output.") from exc
        await asyncio.to_thread(
            db.create_song_search,
            search_id,
            session_id,
            query_key,
            result=result.model_dump(),
            successful_at=cached["successful_at"],
        )
        return SearchStarted(search_id=search_id)
    try:
        await asyncio.to_thread(
            db.create_song_search,
            search_id,
            session_id,
            query_key,
            pending_query=body.query,
        )
    except ValueError as exc:
        raise HTTPException(429, str(exc)) from None
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
    return SearchPending()


def _search_response(result: dict) -> SearchDone:
    if isinstance(result, dict):
        if "http_error" in result:
            raise HTTPException(result["http_error"], result["detail"])
        if result.get("status") == "failed":
            code = result.get("code")
            detail = result.get("detail")
            if (
                isinstance(code, str)
                and code in SEARCH_HTTP_ERRORS
                and isinstance(detail, str)
            ):
                raise HTTPException(SEARCH_HTTP_ERRORS[code], detail)
    try:
        return SearchDone.model_validate(result)
    except ValidationError as exc:
        raise HTTPException(502, "Song finder returned invalid output.") from exc
