"""Credible song identity for optional reference lyrics, never filename guesses."""

import io
import json
from math import isfinite
from pathlib import Path

import mutagen

from separator.lyrics_reference import ReferenceMetadata


def reference_metadata(
    audio_bytes: bytes, *, downloaded_metadata: Path | None = None
) -> ReferenceMetadata | None:
    """Use explicit artist/track tags or yt-dlp's structured music fields only.

    A video's title/uploader/creator is not a reliable song identification.
    Download sidecars live outside the original-audio directory and are never
    returned by the original endpoint. Missing or malformed metadata just skips
    the optional comparison; it must not turn successful ASR into a failed job.
    """
    if downloaded_metadata is not None:
        try:
            value = json.loads(downloaded_metadata.read_text("utf-8").splitlines()[-1])
            artist, title, duration = (
                value.get("artist"),
                value.get("track"),
                value.get("duration"),
            )
            album = value.get("album")
            if (
                isinstance(artist, str)
                and artist.strip()
                and isinstance(title, str)
                and title.strip()
                and type(duration) in (float, int)
                and isfinite(duration)
                and duration > 0
            ):
                return ReferenceMetadata(
                    artist.strip(),
                    title.strip(),
                    float(duration),
                    album.strip() if isinstance(album, str) and album.strip() else None,
                )
        except (OSError, ValueError, IndexError, AttributeError):
            pass
        # A downloaded MP3 may carry yt-dlp's uploader-derived artist/title tags.
        # Never promote those tags into a song identity when structured data lacks it.
        return None
    try:
        audio = mutagen.File(io.BytesIO(audio_bytes), easy=True)
        if audio is None or audio.tags is None:
            return None
        artist = audio.tags.get("artist", [None])[0]
        title = audio.tags.get("title", [None])[0]
        album = audio.tags.get("album", [None])[0]
        duration = audio.info.length
        if (
            not isinstance(artist, str)
            or not artist.strip()
            or not isinstance(title, str)
            or not title.strip()
            or not isfinite(duration)
            or duration <= 0
        ):
            return None
        return ReferenceMetadata(
            artist.strip(),
            title.strip(),
            duration,
            album.strip() if isinstance(album, str) and album.strip() else None,
        )
    except (mutagen.MutagenError, OSError, ValueError, AttributeError, IndexError):
        return None
