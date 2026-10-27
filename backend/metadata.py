"""Lossless title updates for generated MP3 downloads, including old results."""

import os
import shutil
import tempfile
from pathlib import Path

from mutagen.id3 import ID3, TIT2, ID3NoHeaderError


def ensure_download_title(path: Path, download_name: str) -> int:
    """Publish a tagged copy atomically and return its size; skip correct titles.

    Only the title is derived here: all presentation formatting belongs to the
    canonical download filename. Replacing, rather than editing, the file keeps
    concurrent downloads/range requests on a complete, stable inode.
    """
    title = download_name.removesuffix(".mp3")
    try:
        tags = ID3(path, translate=False)
    except ID3NoHeaderError:
        tags = ID3()
    if tags.getall("TIT2") and tags.getall("TIT2")[0].text == [title]:
        return path.stat().st_size
    version = 3 if tags.version[1] == 3 else 4
    tags.setall("TIT2", [TIT2(encoding=3, text=[title])])
    descriptor, temporary = tempfile.mkstemp(prefix=".title-", dir=path.parent)
    os.close(descriptor)
    replacement = Path(temporary)
    try:
        shutil.copyfile(path, replacement)
        tags.save(replacement, v2_version=version)
        replacement.replace(path)
    finally:
        replacement.unlink(missing_ok=True)
    return path.stat().st_size
