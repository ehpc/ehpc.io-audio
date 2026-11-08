"""Filesystem-backed private Volume operations; no Modal resources or model mocks."""

import shutil
import tempfile
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path, PurePosixPath
from typing import BinaryIO

from separator.inference import InferenceRequest
from separator.inference_transport import load_request, publish_file


class LocalVolume:
    """Use the same mounted files for producer and streamed client operations."""

    def __init__(self, root: Path, *, chunk_size: int = 65536) -> None:
        if chunk_size <= 0:
            raise ValueError("chunk_size must be positive")
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)
        self.chunk_size = chunk_size
        self.batches: list[bool] = []
        self.uploads: list[str] = []
        self.reads: list[str] = []
        self.read_chunks: list[tuple[str, int]] = []
        self.removals: list[tuple[str, bool]] = []
        self.reloads = 0
        self.commits: list[dict[str, bytes]] = []

    def _path(self, name: str) -> Path:
        relative = PurePosixPath(str(name).lstrip("/"))
        if ".." in relative.parts or "\\" in str(name):
            raise ValueError("Volume path escapes private root")
        path = self.root.joinpath(*relative.parts)
        current = self.root
        for part in relative.parts:
            current /= part
            if current.is_symlink():
                raise ValueError("Volume path cannot follow a symlink")
        return path

    @contextmanager
    def batch_upload(self, *, force: bool = False) -> Iterator["_UploadBatch"]:
        self.batches.append(force)
        yield _UploadBatch(self, force)

    def read_file(self, path: str) -> Iterator[bytes]:
        self.reads.append(path)
        with self._path(path).open("rb") as source:
            while chunk := source.read(self.chunk_size):
                self.read_chunks.append((path, len(chunk)))
                yield chunk

    def remove_file(self, path: str, *, recursive: bool = False) -> None:
        self.removals.append((path, recursive))
        target = self._path(path)
        if target.is_dir() and recursive:
            shutil.rmtree(target)
        else:
            target.unlink()

    def reload(self) -> None:
        self.reloads += 1

    def commit(self) -> None:
        self.commits.append(self.snapshot())

    def snapshot(self) -> dict[str, bytes]:
        return {
            path.relative_to(self.root).as_posix(): path.read_bytes()
            for path in sorted(self.root.rglob("*"))
            if path.is_file() and not path.is_symlink()
        }


class _UploadBatch:
    def __init__(self, volume: LocalVolume, force: bool) -> None:
        self.volume = volume
        self.force = force

    def put_file(self, source: str | Path | BinaryIO, remote_path: str) -> None:
        destination = self.volume._path(remote_path)
        destination.parent.mkdir(parents=True, exist_ok=True)
        mode = "wb" if self.force else "xb"
        with destination.open(mode) as output:
            if isinstance(source, (str, Path)):
                with Path(source).open("rb") as input_file:
                    shutil.copyfileobj(input_file, output)
            else:
                shutil.copyfileobj(source, output)
        self.volume.uploads.append(remote_path)


def produce_result(
    volume: LocalVolume,
    output_id: str,
    producer: Callable[[InferenceRequest], bytes],
) -> str:
    """Consume staged bytes and publish a real completion, returning only its token."""
    request = load_request(volume.root, output_id)
    data = producer(request)
    with tempfile.TemporaryDirectory() as directory:
        source = Path(directory) / "result.bin"
        source.write_bytes(data)
        publish_file(volume.root, output_id, request, source)
    return output_id
