import asyncio
import tempfile
from pathlib import Path
from typing import Annotated
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from backend import config, drain
from backend.cache_catalog import capture
from backend.session import get_session_id
from backend.source_cache import cached_download
from separator.audio import detect_key
from separator.download import download_mp3

router = APIRouter(tags=["audio"])


class KeyAnalysisResponse(BaseModel):
    original_key: str | None


def _analyze_source(data: bytes | None, filename: str, url: str | None) -> str | None:
    # The worker owns the directory, including if the HTTP request is cancelled.
    # A cancelled to_thread await cannot stop yt-dlp: keep its files alive until
    # it exits, then the context manager cleans them on both success and error.
    with (
        capture() as recorder,
        tempfile.TemporaryDirectory(prefix="vocals-key-preview-") as directory,
    ):
        if url is not None:
            data, filename = cached_download(
                url,
                directory,
                max_attempts=config.DOWNLOAD_MAX_ATTEMPTS,
                backoff_s=config.DOWNLOAD_RETRY_BACKOFF_S,
                producer=download_mp3,
            )
        assert data is not None
        if url is None:
            recorder.bind(data, Path(filename).stem)
        return detect_key(data, filename, config.DATA_DIR / "artifacts")


@router.post("/key-analysis")
async def analyze_key(
    _session_id: Annotated[str, Depends(get_session_id)],
    url: Annotated[str | None, Form()] = None,
    file: Annotated[UploadFile | None, File()] = None,
) -> KeyAnalysisResponse:
    source_url = url.strip() if url else None
    has_file = file is not None and bool(file.filename)
    if bool(source_url) == has_file:
        raise HTTPException(400, "Provide exactly one URL or audio file.")
    if source_url:
        try:
            parsed = urlsplit(source_url)
            valid_url = parsed.scheme in ("http", "https") and bool(parsed.netloc)
        except ValueError:
            valid_url = False
        if not valid_url:
            raise HTTPException(400, "Use an absolute HTTP or HTTPS audio/video URL.")
    data = await file.read() if has_file and file is not None else None
    filename = file.filename if has_file and file is not None else "original.mp3"
    task = asyncio.create_task(
        asyncio.to_thread(_analyze_source, data, filename or "original.mp3", source_url)
    )
    drain.state.track(task)
    try:
        key = await asyncio.shield(task)
    except RuntimeError as exc:
        raise HTTPException(422, str(exc)) from exc
    return KeyAnalysisResponse(original_key=key)
