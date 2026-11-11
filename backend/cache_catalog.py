"""Durable, private source-to-reusable-artifact lineage.

Only exact producer namespaces are eligible for eviction. Source identities are
content hashes internally; clients receive independent random identifiers.
"""

import hashlib
import json
import os
import sqlite3
import stat
import uuid
import zipfile
from contextlib import contextmanager
from pathlib import Path
from typing import TypedDict

from backend import config
from separator.artifact_cache import lineage_recorder, lineage_stack


class CacheSong(TypedDict):
    id: str
    title: str | None
    artist: str | None
    bytes: int


class CacheSnapshot(TypedDict):
    songs: list[CacheSong]
    unattributed_bytes: int
    selective_ready: bool
    unsafe: bool


_DIRECTORIES = {
    "sources": {".bin"},
    "key-decode": {".bin"},
    "keys": {".bin"},
    "transforms": {".bin"},
    "inference": {".bin"},
    "stems/mixes": {".bin"},
    "stems/versioned/outputs": {".bin"},
    "transcripts": {".bin"},
    "analysis-results/lyrics": {".bin"},
    "analysis-results/pitch": {".bin"},
    "analysis-results/structure": {".bin"},
    "qwen-asr/results/recognition": {".bin"},
    "qwen-asr/results/recognition-alignment": {".bin"},
    "recognition-info": {".json"},
    "lyrics-references": {".json"},
    "playback": {".json", ".mp4"},
    "song-search/results": {".bin"},
}


@contextmanager
def _connection():
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(config.DATA_DIR / "cache-catalog.sqlite", timeout=30)
    db.execute("PRAGMA foreign_keys=ON")
    db.executescript("""
        CREATE TABLE IF NOT EXISTS songs (
            digest TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE,
            title TEXT, artist TEXT
        );
        CREATE TABLE IF NOT EXISTS paths (
            digest TEXT NOT NULL REFERENCES songs(digest) ON DELETE CASCADE,
            path TEXT NOT NULL, PRIMARY KEY(digest, path)
        );
        CREATE TABLE IF NOT EXISTS source_fingerprints (
            path TEXT PRIMARY KEY, device INTEGER NOT NULL, inode INTEGER NOT NULL,
            size INTEGER NOT NULL, mtime_ns INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS complete_paths (path TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS dependencies (
            parent TEXT NOT NULL, child TEXT NOT NULL,
            PRIMARY KEY(parent, child)
        );
    """)
    try:
        with db:
            yield db
    finally:
        db.close()


def _safe_file(path: Path) -> bool:
    """Reject symlinks in every component, including the artifact root."""
    root = config.DATA_DIR / "artifacts"
    try:
        relative = path.relative_to(root)
        if not relative.parts or any(part in (".", "..") for part in relative.parts):
            return False
        current = root
        if not stat.S_ISDIR(current.lstat().st_mode):
            return False
        for part in relative.parts[:-1]:
            current = current / part
            if not stat.S_ISDIR(current.lstat().st_mode):
                return False
        return stat.S_ISREG((current / relative.parts[-1]).lstat().st_mode)
    except (OSError, ValueError):
        return False


def _allowed(relative: str) -> bool:
    path = Path(relative)
    suffixes = _DIRECTORIES.get(path.parent.as_posix())
    return bool(
        suffixes
        and path.suffix in suffixes
        and len(path.stem) == 64
        and all(c in "0123456789abcdef" for c in path.stem)
    )


def _name(path: Path) -> str | None:
    try:
        relative = path.relative_to(config.DATA_DIR / "artifacts").as_posix()
    except ValueError:
        return None
    return relative if _allowed(relative) else None


def _relative(path: Path) -> str | None:
    relative = _name(path)
    return relative if relative is not None and _safe_file(path) else None


def _scan_cache() -> tuple[set[str], bool]:
    root = config.DATA_DIR / "artifacts"
    found = set()
    unsafe = False
    for directory in _DIRECTORIES:
        parent = root / directory
        try:
            current = root
            if not stat.S_ISDIR(current.lstat().st_mode):
                unsafe = True
                continue
            for part in Path(directory).parts:
                current = current / part
                if not stat.S_ISDIR(current.lstat().st_mode):
                    raise NotADirectoryError("unsafe cache directory")
            with os.scandir(parent) as entries:
                for entry in entries:
                    relative = f"{directory}/{entry.name}"
                    if _allowed(relative):
                        if entry.is_file(follow_symlinks=False):
                            found.add(relative)
                        else:
                            unsafe = True
        except FileNotFoundError:
            continue
        except OSError:
            unsafe = True
    return found, unsafe


def all_paths() -> set[str]:
    paths, unsafe = _scan_cache()
    if unsafe:
        raise ValueError("Unsafe cache path")
    return paths


def _clean(value):
    return value.strip()[:300] if isinstance(value, str) and value.strip() else None


def _song(db, digest, title=None, artist=None):
    db.execute(
        "INSERT OR IGNORE INTO songs VALUES (?, ?, ?, ?)",
        (digest, uuid.uuid4().hex, _clean(title), _clean(artist)),
    )
    db.execute(
        "UPDATE songs SET title=COALESCE(title, ?), "
        "artist=COALESCE(artist, ?) WHERE digest=?",
        (_clean(title), _clean(artist), digest),
    )


def _associate(digest, paths, title=None, artist=None):
    with _connection() as db:
        _song(db, digest, title, artist)
        for path in paths:
            db.execute(
                """
                WITH RECURSIVE reachable(path) AS (
                    VALUES (?) UNION
                    SELECT child FROM dependencies
                    JOIN reachable ON parent = reachable.path
                )
                INSERT OR IGNORE INTO paths SELECT ?, path FROM reachable
            """,
                (path, digest),
            )


class _Recorder:
    def __init__(self):
        self.digest = None
        self.pending = set()

    def bind(self, audio: bytes, title: str | None = None, artist: str | None = None):
        self.bind_digest(hashlib.sha256(audio).hexdigest(), title, artist)

    def bind_digest(
        self, digest: str, title: str | None = None, artist: str | None = None
    ):
        self.digest = digest
        _associate(self.digest, self.pending, title, artist)
        self.pending.clear()

    def begin(self, path: Path):
        relative = _name(path)
        if relative is not None:
            with _connection() as db:
                db.execute("DELETE FROM complete_paths WHERE path=?", (relative,))
                db.execute("DELETE FROM dependencies WHERE parent=?", (relative,))

    def complete(self, path: Path, *, leaf: bool):
        relative = _relative(path)
        if relative is not None:
            with _connection() as db:
                if leaf:
                    db.execute("DELETE FROM dependencies WHERE parent=?", (relative,))
                db.execute(
                    "INSERT OR IGNORE INTO complete_paths VALUES (?)", (relative,)
                )

    def record(self, path: Path):
        relative = _relative(path)
        if relative is None:
            return
        for parent in reversed(lineage_stack.get()):
            parent_name = _name(parent)
            if parent_name is not None and parent_name != relative:
                with _connection() as db:
                    db.execute(
                        "INSERT OR IGNORE INTO dependencies VALUES (?, ?)",
                        (parent_name, relative),
                    )
                break
        if self.digest is None:
            self.pending.add(relative)
        else:
            _associate(self.digest, {relative})


@contextmanager
def capture():
    recorder = _Recorder()
    token = lineage_recorder.set(recorder)
    try:
        yield recorder
    finally:
        lineage_recorder.reset(token)


def bind_source(
    audio: bytes, title: str | None = None, artist: str | None = None
) -> None:
    recorder = lineage_recorder.get()
    if recorder is not None:
        recorder.bind(audio, title, artist)


def record_path(path: Path) -> None:
    recorder = lineage_recorder.get()
    if recorder is not None:
        recorder.record(path)


def _fingerprint(info):
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns


@contextmanager
def _source_file(relative):
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    root = os.open(config.DATA_DIR / "artifacts", flags)
    try:
        directory = os.open("sources", flags, dir_fd=root)
        try:
            name = Path(relative).name
            descriptor = os.open(
                name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory
            )
            with os.fdopen(descriptor, "rb") as stream:
                info = os.fstat(stream.fileno())
                if not stat.S_ISREG(info.st_mode):
                    raise ValueError("Unsafe source archive")
                yield stream, directory, name, _fingerprint(info)
        finally:
            os.close(directory)
    finally:
        os.close(root)


def _legacy_sources(paths):
    """Backfill verified source ZIPs only; never trust a changed fingerprint."""
    for relative in paths:
        if not relative.startswith("sources/"):
            continue
        try:
            with _source_file(relative) as (stream, directory, filename, fingerprint):
                with _connection() as db:
                    previous = db.execute(
                        "SELECT device, inode, size, mtime_ns "
                        "FROM source_fingerprints WHERE path=?",
                        (relative,),
                    ).fetchone()
                    associated = db.execute(
                        "SELECT 1 FROM paths WHERE path=? LIMIT 1", (relative,)
                    ).fetchone()
                    if (
                        previous == fingerprint
                        and associated
                        and fingerprint
                        == _fingerprint(
                            os.stat(filename, dir_fd=directory, follow_symlinks=False)
                        )
                    ):
                        db.execute(
                            "INSERT OR IGNORE INTO complete_paths VALUES (?)",
                            (relative,),
                        )
                        continue
                    db.execute("DELETE FROM paths WHERE path=?", (relative,))
                    db.execute(
                        "DELETE FROM source_fingerprints WHERE path=?", (relative,)
                    )
                    db.execute("DELETE FROM complete_paths WHERE path=?", (relative,))
                with zipfile.ZipFile(stream) as archive:
                    audio_info = archive.getinfo("audio")
                    if (
                        audio_info.file_size <= 0
                        or audio_info.compress_type != zipfile.ZIP_STORED
                        or audio_info.file_size > fingerprint[2]
                        or archive.getinfo("name").file_size > 4096
                        or archive.getinfo("metadata").file_size > 1024 * 1024
                    ):
                        continue
                    hasher = hashlib.sha256()
                    with archive.open("audio") as audio:
                        while block := audio.read(1024 * 1024):
                            hasher.update(block)
                    digest = hasher.hexdigest()
                    name = json.loads(archive.read("name"))
                    raw = archive.read("metadata")
                if not isinstance(name, str) or Path(name).name != name:
                    continue
                if fingerprint != _fingerprint(
                    os.fstat(stream.fileno())
                ) or fingerprint != _fingerprint(
                    os.stat(filename, dir_fd=directory, follow_symlinks=False)
                ):
                    continue
                try:
                    metadata = json.loads(raw.splitlines()[-1]) if raw else {}
                    if not isinstance(metadata, dict):
                        metadata = {}
                except (ValueError, IndexError):
                    metadata = {}
                with _connection() as db:
                    _song(
                        db,
                        digest,
                        metadata.get("track") or Path(name).stem,
                        metadata.get("artist"),
                    )
                    db.execute(
                        "INSERT OR IGNORE INTO paths VALUES (?, ?)", (digest, relative)
                    )
                    db.execute(
                        "INSERT OR REPLACE INTO source_fingerprints "
                        "VALUES (?, ?, ?, ?, ?)",
                        (relative, *fingerprint),
                    )
                    db.execute(
                        "INSERT OR IGNORE INTO complete_paths VALUES (?)", (relative,)
                    )
        except (OSError, ValueError, KeyError, zipfile.BadZipFile, RuntimeError):
            with _connection() as db:
                db.execute("DELETE FROM paths WHERE path=?", (relative,))
                db.execute("DELETE FROM source_fingerprints WHERE path=?", (relative,))
                db.execute("DELETE FROM complete_paths WHERE path=?", (relative,))


def unsafe_paths() -> bool:
    _, unsafe_cache = _scan_cache()
    return unsafe_cache


def _associations(db):
    return db.execute("""
        WITH RECURSIVE reachable(digest, path) AS (
            SELECT digest, path FROM paths UNION
            SELECT reachable.digest, dependencies.child
            FROM reachable JOIN dependencies ON dependencies.parent = reachable.path
        )
        SELECT digest, path FROM reachable
    """).fetchall()


def snapshot() -> CacheSnapshot:
    paths, unsafe_cache = _scan_cache()
    _legacy_sources(paths)
    sizes = {}
    for relative in paths:
        path = config.DATA_DIR / "artifacts" / relative
        if _safe_file(path):
            sizes[relative] = path.stat().st_size
    with _connection() as db:
        songs = db.execute("SELECT digest, id, title, artist FROM songs").fetchall()
        associations = _associations(db)
        complete = {path for (path,) in db.execute("SELECT path FROM complete_paths")}
    by_song = {}
    attributed = set()
    for digest, path in associations:
        if path in sizes:
            by_song.setdefault(digest, set()).add(path)
            attributed.add(path)
    unknown = {
        path
        for path in sizes
        if (path not in attributed or path not in complete)
        and not path.startswith("song-search/")
    }
    return {
        "songs": [
            {
                "id": ident,
                "title": title,
                "artist": artist,
                "bytes": sum(sizes[p] for p in by_song.get(digest, set())),
            }
            for digest, ident, title, artist in songs
            if digest in by_song
        ],
        "unattributed_bytes": sum(sizes[p] for p in unknown),
        "selective_ready": not unsafe_cache and not unknown,
        "unsafe": unsafe_cache,
    }


def select_paths(ids: list[str]) -> set[str]:
    with _connection() as db:
        songs = {
            ident: digest
            for digest, ident in db.execute("SELECT digest, id FROM songs")
        }
        if any(ident not in songs for ident in ids):
            raise ValueError("Unknown song ID")
        selected = {songs[ident] for ident in ids}
        paths = {path for digest, path in _associations(db) if digest in selected}
    return paths & all_paths()


def forget_paths(paths: set[str]) -> None:
    with _connection() as db:
        db.executemany("DELETE FROM paths WHERE path=?", ((path,) for path in paths))
        db.executemany(
            "DELETE FROM source_fingerprints WHERE path=?", ((path,) for path in paths)
        )
        db.executemany(
            "DELETE FROM complete_paths WHERE path=?", ((path,) for path in paths)
        )
        db.executemany(
            "DELETE FROM dependencies WHERE parent=?", ((path,) for path in paths)
        )
        db.execute(
            "DELETE FROM songs WHERE NOT EXISTS "
            "(SELECT 1 FROM paths WHERE paths.digest=songs.digest)"
        )
