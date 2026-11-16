"""Fresh-process SIGKILL at the source-copy durability boundary."""

import os
import signal
import sys
from collections.abc import Callable
from pathlib import Path
from typing import BinaryIO
from unittest.mock import patch

from backend import config, regeneration
from backend.routes import admin_cache

copy_verified = regeneration._copy_verified


def kill_after_sidecar(
    source: BinaryIO,
    path: Path,
    expected: str,
    on_create: Callable[[Path], None] | None = None,
) -> None:
    copy_verified(source, path, expected, on_create)
    if path.parent == config.DATA_DIR / "source-metadata":
        os.kill(os.getpid(), signal.SIGKILL)


mode, identifier, owner = sys.argv[1:]
with patch.object(regeneration, "_copy_verified", kill_after_sidecar):
    if mode == "song":
        admin_cache._regenerate([identifier])
    elif mode == "retry":
        regeneration.retry(int(identifier), owner)
    else:
        raise ValueError(f"Unknown crash test mode: {mode}")
raise RuntimeError("Expected SIGKILL after source and sidecar installation")
