"""Seek-indexed listening copies; original downloads and analysis stay untouched."""

import json
import os
import subprocess
import tempfile
from pathlib import Path
from typing import TypedDict

from backend.cache_catalog import record_path
from separator import cache_versions
from separator.artifact_cache import atomic_write, cache_key, complete_path, locked

_PREPARATION_TIMEOUT_S = 120


class AudioFormat(TypedDict):
    container: str
    codec: str
    sample_rate: int


type CachedPlayback = tuple[AudioFormat, str | None]


def _run(command: list[str]) -> bytes:
    # Malformed media can emit extensive diagnostics; retain only a bounded tail
    # in memory. No audio is passed through Python or captured on stdout.
    with tempfile.TemporaryFile() as errors:
        try:
            result = subprocess.run(
                command,
                check=True,
                stdout=subprocess.PIPE,
                stderr=errors,
                timeout=_PREPARATION_TIMEOUT_S,
            )
        except subprocess.TimeoutExpired as exc:
            raise RuntimeError("Listening audio preparation timed out") from exc
        except subprocess.CalledProcessError as exc:
            errors.seek(max(0, errors.tell() - 4096))
            detail = errors.read().decode(errors="replace").strip()
            raise RuntimeError(f"Listening audio preparation failed: {detail}") from exc
        except FileNotFoundError as exc:
            raise RuntimeError(f"Required audio tool not found: {command[0]}") from exc
    return result.stdout


def _probe(source: Path) -> AudioFormat:
    value = json.loads(
        _run(
            [
                "ffprobe",
                "-v",
                "error",
                "-protocol_whitelist",
                "file,pipe",
                "-select_streams",
                "a:0",
                "-show_entries",
                "format=format_name:stream=codec_name,sample_rate",
                "-of",
                "json",
                str(source),
            ]
        )
    )
    stream = next(iter(value.get("streams", [])), {})
    return {
        "container": value.get("format", {}).get("format_name", ""),
        "codec": stream.get("codec_name", ""),
        "sample_rate": int(stream.get("sample_rate", 0)),
    }


def _eligible(audio: AudioFormat) -> bool:
    # Preserve the existing behavior for low-rate MP3 and non-MP3 inputs.
    # Eligible conversion errors remain visible instead of serving a raw fallback.
    return (
        audio["container"] == "mp3"
        and audio["codec"] == "mp3"
        and audio["sample_rate"] >= 16000
    )


def _cached(path: Path) -> CachedPlayback | None:
    try:
        envelope = json.loads(path.read_text())
        value = envelope["value"]
        if envelope["checksum"] != cache_key(value):
            return None
        audio = value["audio"]
        if (
            not isinstance(audio["container"], str)
            or not isinstance(audio["codec"], str)
            or type(audio["sample_rate"]) is not int
        ):
            return None
        checksum = value["output_sha256"]
        if _eligible(audio):
            if not isinstance(checksum, str) or len(checksum) != 64:
                return None
        elif checksum is not None:
            return None
        return audio, checksum
    except (OSError, ValueError, KeyError, TypeError):
        return None


def listening_path(source: Path, root: Path) -> Path | None:
    """Return a private indexed copy, or None for unchanged format behavior.

    Call only after the route's ownership and source-availability checks, in a
    worker thread: hashing, the process lock, probing and encoding are blocking.
    The tiny checksummed manifest also caches *ineligible* format decisions, so
    subsequent Range requests do not repeatedly spawn native processes.
    """
    source_revision = cache_versions.file_revision(source)
    key = cache_key(
        cache_versions.PLAYBACK,
        source_revision,
        cache_versions.binary_revision("ffmpeg"),
        cache_versions.binary_revision("ffprobe"),
    )
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    output = root / f"{key}.mp4"
    manifest = root / f"{key}.json"
    with locked(root / f"{key}.lock"):
        record_path(manifest)
        record_path(output)
        cached = _cached(manifest)
        if cached is not None:
            audio, checksum = cached
            if not _eligible(audio):
                return None
            if output.is_file() and cache_versions.file_revision(output) == checksum:
                return output

        audio = _probe(source)
        output_sha256 = None
        if _eligible(audio):
            descriptor, name = tempfile.mkstemp(dir=root, prefix=".pending-playback-")
            temporary = Path(name)
            os.close(descriptor)
            try:
                _run(
                    [
                        "ffmpeg",
                        "-nostdin",
                        "-v",
                        "error",
                        "-y",
                        "-protocol_whitelist",
                        "file,pipe",
                        "-i",
                        str(source),
                        "-map",
                        "0:a:0",
                        "-c:a",
                        "aac",
                        "-b:a",
                        "256k",
                        "-map_metadata",
                        "-1",
                        "-movflags",
                        "+faststart",
                        "-use_editlist",
                        "1",
                        "-movie_timescale",
                        str(audio["sample_rate"]),
                        "-f",
                        "mp4",
                        str(temporary),
                    ]
                )
                produced = _probe(temporary)
                if (
                    "mp4" not in produced["container"].split(",")
                    or produced["codec"] != "aac"
                    or produced["sample_rate"] != audio["sample_rate"]
                ):
                    raise RuntimeError("Invalid indexed listening audio")
                if cache_versions.file_revision(source) != source_revision:
                    raise RuntimeError(
                        "Audio source changed during playback preparation"
                    )
                with temporary.open("rb") as handle:
                    os.fsync(handle.fileno())
                temporary.replace(output)
                record_path(output)
                complete_path(output)
                output_sha256 = cache_versions.file_revision(output)
            finally:
                temporary.unlink(missing_ok=True)
        elif cache_versions.file_revision(source) != source_revision:
            raise RuntimeError("Audio source changed during playback preparation")

        value = {"audio": audio, "output_sha256": output_sha256}
        atomic_write(
            manifest,
            json.dumps({"value": value, "checksum": cache_key(value)}).encode(),
        )
        return output if output_sha256 is not None else None
