import subprocess
import time
from pathlib import Path

# YouTube throws these intermittently as anti-bot / rate-limit measures; a retry
# often succeeds. Other errors (404, private, DRM, unavailable) are permanent, so
# we fail fast rather than loop.
_TRANSIENT_MARKERS = ("403", "forbidden", "429", "too many requests")


def _download_error(stderr: str) -> str:
    """Pull yt-dlp's own ERROR line out of stderr for a user-facing message."""
    errors = [
        line.strip()
        for line in stderr.splitlines()
        if line.strip().startswith("ERROR:")
    ]
    detail = errors[-1].removeprefix("ERROR:").strip() if errors else "download failed"
    return f"Download failed: {detail}"


def _is_transient(message: str) -> bool:
    lowered = message.lower()
    return any(marker in lowered for marker in _TRANSIENT_MARKERS)


def download_mp3(
    url: str,
    dest_dir: str,
    *,
    max_attempts: int = 3,
    backoff_s: float = 10.0,
    metadata_path: Path | None = None,
) -> tuple[bytes, str]:
    last_error = "Download failed"
    for attempt in range(1, max(1, max_attempts) + 1):
        result = subprocess.run(
            [
                "yt-dlp",
                "-f",
                "bestaudio/best",
                "-x",
                "--audio-format",
                "mp3",
                "--audio-quality",
                "0",
                "--no-playlist",
                # "Artist - Title" when artist/creator metadata exists (yt-dlp
                # `field&replacement|default` conditionally adds the separator),
                # otherwise just the title. This name becomes the job title and
                # the original download filename.
                "-o",
                str(
                    Path(dest_dir)
                    / "%(artist,creator|)s%(artist,creator& - |)s%(title)s.%(ext)s"
                ),
                url,
                *(
                    [
                        "--print-to-file",
                        "after_move:%(.{artist,track,album,duration})j",
                        str(metadata_path),
                    ]
                    if metadata_path is not None
                    else []
                ),
            ],
            capture_output=True,
            text=True,
        )
        if result.returncode == 0:
            mp3_files = list(Path(dest_dir).glob("*.mp3"))
            if not mp3_files:
                raise RuntimeError("yt-dlp produced no MP3 file")
            path = mp3_files[0]
            return path.read_bytes(), path.name

        last_error = _download_error(result.stderr)
        # Only retry transient failures, and never after the final attempt.
        if attempt >= max_attempts or not _is_transient(last_error):
            break
        time.sleep(backoff_s * attempt)

    raise RuntimeError(last_error)
