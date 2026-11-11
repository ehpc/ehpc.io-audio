"""Private reusable originals shared by preview and jobs, never public routes."""

import io
import json
import tempfile
import zipfile
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from backend import config
from backend.cache_catalog import bind_source
from separator import cache_versions
from separator.artifact_cache import cache_key, cached_bytes
from separator.download import download_mp3


def source_identity(url: str) -> str:
    parsed = urlsplit(url)
    host = (parsed.hostname or "").lower()
    video = None
    if host in {"youtube.com", "www.youtube.com", "music.youtube.com", "m.youtube.com"}:
        if parsed.path == "/watch":
            video = parse_qs(parsed.query).get("v", [None])[0]
        elif parsed.path.startswith(("/shorts/", "/embed/", "/live/")):
            video = parsed.path.split("/")[2]
    elif host == "youtu.be":
        video = parsed.path.strip("/")
    if video and len(video) == 11 and all(c.isalnum() or c in "_-" for c in video):
        return f"youtube:{video}"
    # Never discard unknown query parameters: they may identify a recording.
    return url


def cached_download(
    url: str,
    dest_dir: str,
    *,
    max_attempts: int = 3,
    backoff_s: float = 10,
    metadata_path: Path | None = None,
    producer=download_mp3,
) -> tuple[bytes, str]:
    key = cache_key(
        cache_versions.DOWNLOAD,
        cache_versions.package_revision("yt-dlp"),
        cache_versions.binary_revision("ffmpeg"),
        source_identity(url),
    )

    def produce() -> bytes:
        with tempfile.TemporaryDirectory(prefix="source-cache-") as directory:
            metadata = Path(directory) / "metadata.json"
            audio, filename = producer(
                url,
                directory,
                max_attempts=max_attempts,
                backoff_s=backoff_s,
                metadata_path=metadata,
            )
            if (
                not audio
                or filename in {"", ".", ".."}
                or Path(filename).name != filename
            ):
                raise RuntimeError("Download produced an invalid source")
            stream = io.BytesIO()
            with zipfile.ZipFile(stream, "w") as archive:
                archive.writestr("audio", audio)
                archive.writestr("name", json.dumps(filename))
                archive.writestr(
                    "metadata", metadata.read_bytes() if metadata.exists() else b""
                )
            return stream.getvalue()

    content = cached_bytes(config.DATA_DIR / "artifacts" / "sources", key, produce)
    with zipfile.ZipFile(io.BytesIO(content)) as archive:
        audio = archive.read("audio")
        filename = json.loads(archive.read("name"))
        metadata = archive.read("metadata")
    try:
        details = json.loads(metadata.splitlines()[-1]) if metadata else {}
        if not isinstance(details, dict):
            details = {}
    except (ValueError, IndexError):
        details = {}
    bind_source(
        audio, details.get("track") or Path(filename).stem, details.get("artist")
    )
    destination = Path(dest_dir)
    destination.mkdir(parents=True, exist_ok=True)
    (destination / filename).write_bytes(audio)
    if metadata_path is not None and metadata:
        metadata_path.parent.mkdir(parents=True, exist_ok=True)
        metadata_path.write_bytes(metadata)
    return audio, filename
