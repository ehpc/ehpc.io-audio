"""Single local I/O worker; discovery never submits a Modal workload."""

import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress
from typing import Any

from pydantic import ValidationError

from backend import config, db
from backend.models import SearchDone
from separator.song_search import (
    SEARCH_HTTP_ERRORS,
    SEARCH_TTL,
    query_cache_key,
    run_search,
)

log = logging.getLogger(__name__)


def _validate_result(result: Any) -> dict:
    if isinstance(result, dict) and result.get("status") == "failed":
        code = result.get("code")
        if (
            isinstance(code, str)
            and code in SEARCH_HTTP_ERRORS
            and isinstance(result.get("detail"), str)
        ):
            return result
    try:
        return SearchDone.model_validate(result).model_dump()
    except ValidationError:
        return {
            "status": "failed",
            "code": "invalid_model",
            "detail": "Song finder returned invalid output.",
        }


def _complete(search: dict) -> None:
    # A queued clue may survive a deployment that changes the producer. Attribute
    # its result to the producer executing it, not the old enqueue-time identity.
    query_key = query_cache_key(search["pending_query"])
    try:
        result = _validate_result(
            run_search(
                search["pending_query"],
                str(config.DATA_DIR / "artifacts" / "song-search"),
            )
        )
    except Exception:
        # Do not expose/log provider bodies, credentials, or the pending clue.
        result = {
            "status": "failed",
            "code": "unavailable",
            "detail": "Song finder is unavailable. Try again later.",
        }
    db.finish_song_search(search["id"], result, SEARCH_TTL, query_key=query_key)


async def run_next_search() -> bool:
    search = await asyncio.to_thread(db.claim_song_search, SEARCH_TTL)
    if search is None:
        return False
    # Completion and persistence stay in the same thread, even if the caller is
    # interrupted. The normal lifespan drains this thread rather than cancelling it.
    await asyncio.to_thread(_complete, search)
    return True


async def _worker(stop: asyncio.Event) -> None:
    while not stop.is_set():
        try:
            if await run_next_search():
                continue
        except Exception:
            log.error("Song search worker could not persist queued work.")
        with suppress(TimeoutError):
            await asyncio.wait_for(stop.wait(), timeout=config.QUEUE_POLL_INTERVAL_S)


@asynccontextmanager
async def lifespan() -> AsyncIterator[asyncio.Event]:
    """One process/replica owns recovery, as with the existing audio queue."""
    await asyncio.to_thread(db.recover_song_searches, SEARCH_TTL)
    stop = asyncio.Event()
    task = asyncio.create_task(_worker(stop))
    try:
        yield stop
    finally:
        stop.set()
        # Cancelling a to_thread await would leave its HTTP request running. Stop
        # new claims and drain instead; network clients retain their bounded timeouts.
        await asyncio.shield(task)
