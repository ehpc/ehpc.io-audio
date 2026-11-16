import json
import sqlite3
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import asdict, fields
from typing import TYPE_CHECKING, NamedTuple, TypedDict

from backend import auth_store, config
from backend.models import JobRecord, JobStatus, ResultManifestEntry
from separator.lyrics import Transcript, transcript_from_json
from separator.options import SeparationOptions
from separator.song_search import SEARCH_TTL

if TYPE_CHECKING:
    from backend.regeneration import PreparedRegeneration, PreparedSong

_OPTION_FIELDS = {f.name for f in fields(SeparationOptions)}
# Renamed options in older stored jobs → current field names.
_RENAMED_OPTIONS = {"chorus": "genders", "vocalists": "lead_backing"}

type CompletedStage = tuple[str, str | None]
type RetiringStage = tuple[int, str, str]
type StageOwner = tuple[int, str | None, str | None]


class InferenceStageClaim(NamedTuple):
    owner: JobRecord
    newly_claimed: bool


class UncompletedInferenceStage(ValueError):
    """The job still owns a different unresolved inference stage."""


def _load_options(options_json: str) -> SeparationOptions:
    """Deserialize options tolerantly: map renamed keys, drop any unknown ones,
    so jobs written by an older schema still load."""
    data = json.loads(options_json)
    for old, new in _RENAMED_OPTIONS.items():
        if old in data:
            data.setdefault(new, data.pop(old))
    return SeparationOptions(**{k: v for k, v in data.items() if k in _OPTION_FIELDS})


_SEARCH_SCHEMA = """
CREATE TABLE IF NOT EXISTS song_searches (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    modal_call_id TEXT,
    result_json TEXT,
    created_at INTEGER NOT NULL,
    query_key TEXT,
    successful_at REAL,
    pending_query TEXT,
    claimed_at REAL,
    activity_query TEXT
);
"""

_SCHEMA = f"""
CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued','running','done','failed')),
    source_type TEXT NOT NULL CHECK (source_type IN ('url','upload')),
    source_value TEXT NOT NULL,
    title TEXT,
    original_key TEXT,
    options_json TEXT NOT NULL,
    modal_call_id TEXT,
    active_stage_key TEXT,
    result_manifest_json TEXT,
    transcript_json TEXT,
    pitch_json TEXT,
    error_message TEXT,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_jobs_status_id ON jobs(status, id);
CREATE INDEX IF NOT EXISTS idx_jobs_session_id ON jobs(session_id, id DESC);
{_SEARCH_SCHEMA}
CREATE TABLE IF NOT EXISTS job_source_snapshots (
    job_id INTEGER PRIMARY KEY,
    source_job_id INTEGER NOT NULL,
    song_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    source_sha256 TEXT NOT NULL,
    ready INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS song_regeneration_operations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    song_id TEXT NOT NULL,
    title TEXT,
    digest TEXT NOT NULL,
    status TEXT NOT NULL,
    error_message TEXT,
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS song_regeneration_items (
    operation_id INTEGER NOT NULL REFERENCES song_regeneration_operations(id),
    original_job_id INTEGER NOT NULL,
    work_job_id INTEGER NOT NULL UNIQUE,
    state TEXT NOT NULL DEFAULT 'pending',
    PRIMARY KEY(operation_id, original_job_id)
);
"""


def _migrate(conn: sqlite3.Connection) -> None:
    columns = {row["name"] for row in conn.execute("PRAGMA table_info(jobs)")}
    if "title" not in columns:
        conn.execute("ALTER TABLE jobs ADD COLUMN title TEXT")
    if "active_stage_key" not in columns:
        conn.execute("ALTER TABLE jobs ADD COLUMN active_stage_key TEXT")
    if "original_key" not in columns:
        conn.execute("ALTER TABLE jobs ADD COLUMN original_key TEXT")
    if "transcript_json" not in columns:
        conn.execute("ALTER TABLE jobs ADD COLUMN transcript_json TEXT")
    if "pitch_json" not in columns:
        conn.execute("ALTER TABLE jobs ADD COLUMN pitch_json TEXT")
    if "result_generation" not in columns:
        conn.execute("ALTER TABLE jobs ADD COLUMN result_generation TEXT")
    if "internal" not in columns:
        conn.execute("ALTER TABLE jobs ADD COLUMN internal INTEGER NOT NULL DEFAULT 0")
    snapshot_columns = {
        row["name"] for row in conn.execute("PRAGMA table_info(job_source_snapshots)")
    }
    if "ready" not in snapshot_columns:
        conn.execute(
            "ALTER TABLE job_source_snapshots "
            "ADD COLUMN ready INTEGER NOT NULL DEFAULT 1"
        )
    if conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='regenerations'"
    ).fetchone():
        conn.execute(
            "INSERT OR IGNORE INTO job_source_snapshots "
            "(job_id,source_job_id,song_id,filename,source_sha256) "
            "SELECT job_id, source_job_id, song_id, filename, source_sha256 "
            "FROM regenerations"
        )
        conn.execute("DROP TABLE regenerations")
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_active_stage_key "
        "ON jobs(active_stage_key) WHERE active_stage_key IS NOT NULL"
    )
    search_columns = {
        row["name"]: row for row in conn.execute("PRAGMA table_info(song_searches)")
    }
    if "query_key" not in search_columns:
        conn.execute("ALTER TABLE song_searches ADD COLUMN query_key TEXT")
    if "successful_at" not in search_columns:
        conn.execute("ALTER TABLE song_searches ADD COLUMN successful_at REAL")
    if "pending_query" not in search_columns:
        conn.execute("ALTER TABLE song_searches ADD COLUMN pending_query TEXT")
    if "claimed_at" not in search_columns:
        conn.execute("ALTER TABLE song_searches ADD COLUMN claimed_at REAL")
    if "activity_query" not in search_columns:
        conn.execute("ALTER TABLE song_searches ADD COLUMN activity_query TEXT")
        conn.execute("UPDATE song_searches SET activity_query=pending_query")
    if search_columns["modal_call_id"]["notnull"]:
        # SQLite cannot relax NOT NULL in place. Preserve historical IDs and raw
        # payloads, including expired NULL-result rows; new local work has no call ID.
        schema_objects = [
            row["sql"]
            for row in conn.execute(
                "SELECT sql FROM sqlite_schema WHERE tbl_name = 'song_searches' "
                "AND type IN ('index', 'trigger') AND sql IS NOT NULL "
                "ORDER BY type, name"
            )
        ]
        conn.execute("ALTER TABLE song_searches RENAME TO song_searches_before_local")
        conn.execute(_SEARCH_SCHEMA)
        conn.execute(
            "INSERT INTO song_searches "
            "(rowid, id, session_id, modal_call_id, result_json, created_at, "
            "query_key, successful_at, pending_query, claimed_at, activity_query) "
            "SELECT rowid, id, session_id, modal_call_id, result_json, created_at, "
            "query_key, successful_at, pending_query, claimed_at, activity_query "
            "FROM song_searches_before_local"
        )
        conn.execute("DROP TABLE song_searches_before_local")
        for statement in schema_objects:
            conn.execute(statement)
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_song_search_query_success "
        "ON song_searches(query_key, successful_at DESC)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_song_search_pending "
        "ON song_searches(created_at) WHERE pending_query IS NOT NULL"
    )
    # Prior to explicit extraction, every job always requested both base stems.
    # Persist that intent once so history and retries retain the old behavior.
    for row in conn.execute("SELECT id, options_json FROM jobs").fetchall():
        options = json.loads(row["options_json"])
        before = json.dumps(options)
        options.pop("no_cache", None)
        if "extract_vocals" not in options and "extract_instruments" not in options:
            options.update(extract_vocals=True, extract_instruments=True)
        mixes = options.setdefault("mixes", [])
        for component in ("female", "male", "backing", "lead"):
            if options.pop(f"mix_{component}_instruments", False):
                mix_id = f"mix-legacy-{component}"
                mixes.append(
                    {
                        "id": mix_id,
                        "name": f"{component.title()} vocals + Instruments",
                        "components": [component, "instruments"],
                    }
                )
        if json.dumps(options) != before:
            conn.execute(
                "UPDATE jobs SET options_json = ? WHERE id = ?",
                (json.dumps(options), row["id"]),
            )


@contextmanager
def _session() -> Iterator[sqlite3.Connection]:
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(config.DB_PATH, timeout=30)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db() -> None:
    with _session() as conn:
        conn.executescript(_SCHEMA)
        conn.execute("BEGIN IMMEDIATE")
        _migrate(conn)
    auth_store.initialize()


def health_check() -> None:
    with _session() as conn:
        conn.execute("SELECT 1")


def _check_queue_capacity(conn: sqlite3.Connection, session_id: str) -> None:
    counts = conn.execute(
        "SELECT COUNT(*) total, SUM(session_id = ?) own FROM ("
        "SELECT session_id FROM jobs WHERE status IN ('queued','running') "
        "UNION ALL SELECT 'internal:song-regeneration' "
        "FROM song_regeneration_operations WHERE status IN ('preparing','clearing') "
        "UNION ALL SELECT session_id FROM song_searches "
        "WHERE pending_query IS NOT NULL AND created_at > ?)",
        (session_id, int(time.time()) - SEARCH_TTL),
    ).fetchone()
    if (counts["own"] or 0) >= auth_store.setting(conn, "user_queue", 5) or counts[
        "total"
    ] >= auth_store.setting(conn, "global_queue", 50):
        raise ValueError("Queue limit reached")


def create_song_search(
    search_id: str,
    session_id: str,
    query_key: str,
    *,
    pending_query: str | None = None,
    activity_query: str | None = None,
    result: dict | None = None,
    successful_at: float | None = None,
) -> None:
    with _session() as conn:
        if pending_query is not None and session_id.startswith("acct:"):
            conn.execute("BEGIN IMMEDIATE")
            _check_queue_capacity(conn, session_id)
        conn.execute(
            "INSERT INTO song_searches "
            "(id, session_id, created_at, query_key, pending_query, "
            "result_json, successful_at, activity_query) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                search_id,
                session_id,
                int(time.time()),
                query_key,
                pending_query,
                json.dumps(result) if result is not None else None,
                successful_at,
                activity_query if activity_query is not None else pending_query,
            ),
        )


def get_cached_song_search(query_key: str, max_age: int) -> dict | None:
    with _session() as conn:
        row = conn.execute(
            "SELECT result_json, successful_at FROM song_searches "
            "WHERE query_key = ? AND successful_at > ? "
            "ORDER BY successful_at DESC LIMIT 1",
            (query_key, time.time() - max_age),
        ).fetchone()
        return dict(row) if row is not None else None


def get_song_search(search_id: str, session_id: str, max_age: int) -> dict | None:
    with _session() as conn:
        row = conn.execute(
            "SELECT result_json, created_at FROM song_searches "
            "WHERE id = ? AND session_id = ?",
            (search_id, session_id),
        ).fetchone()
        if row is None:
            return None
        if row["created_at"] <= int(time.time()) - max_age:
            conn.execute(
                "UPDATE song_searches SET pending_query = NULL, claimed_at = NULL "
                "WHERE id = ? AND pending_query IS NOT NULL",
                (search_id,),
            )
            return None
        return {"result_json": row["result_json"]}


def _expire_song_searches(conn: sqlite3.Connection, max_age: int) -> None:
    conn.execute(
        "UPDATE song_searches SET pending_query = NULL, claimed_at = NULL "
        "WHERE pending_query IS NOT NULL AND created_at <= ?",
        (int(time.time()) - max_age,),
    )


def recover_song_searches(max_age: int) -> None:
    """Restart only local work; historical Modal rows never become queue entries."""
    with _session() as conn:
        conn.execute("BEGIN IMMEDIATE")
        _expire_song_searches(conn, max_age)
        conn.execute(
            "UPDATE song_searches SET claimed_at = NULL "
            "WHERE pending_query IS NOT NULL AND result_json IS NULL"
        )


def claim_song_search(max_age: int) -> dict | None:
    with _session() as conn:
        conn.execute("BEGIN IMMEDIATE")
        _expire_song_searches(conn, max_age)
        row = conn.execute(
            "SELECT id, pending_query FROM song_searches "
            "WHERE pending_query IS NOT NULL AND result_json IS NULL "
            "AND claimed_at IS NULL ORDER BY created_at, rowid LIMIT 1"
        ).fetchone()
        if row is None:
            return None
        conn.execute(
            "UPDATE song_searches SET claimed_at = ? WHERE id = ?",
            (time.time(), row["id"]),
        )
        return dict(row)


def finish_song_search(
    search_id: str, result: dict, max_age: int, *, query_key: str
) -> None:
    with _session() as conn:
        conn.execute("BEGIN IMMEDIATE")
        _expire_song_searches(conn, max_age)
        conn.execute(
            "UPDATE song_searches SET result_json = ?, successful_at = ?, "
            "pending_query = NULL, claimed_at = NULL, query_key = ? "
            "WHERE id = ? AND result_json IS NULL AND pending_query IS NOT NULL",
            (
                json.dumps(result),
                time.time() if result.get("status") == "done" else None,
                query_key,
                search_id,
            ),
        )


def _row_to_job(row: sqlite3.Row) -> JobRecord:
    manifest_json = row["result_manifest_json"]
    return JobRecord(
        id=row["id"],
        session_id=row["session_id"],
        status=JobStatus(row["status"]),
        source_type=row["source_type"],
        source_value=row["source_value"],
        title=row["title"],
        original_key=row["original_key"],
        options=_load_options(row["options_json"]),
        modal_call_id=row["modal_call_id"],
        active_stage_key=row["active_stage_key"],
        result_manifest=(
            [
                ResultManifestEntry.model_validate(entry)
                for entry in json.loads(manifest_json)
            ]
            if manifest_json
            else None
        ),
        error_message=row["error_message"],
        created_at=row["created_at"],
        started_at=row["started_at"],
        finished_at=row["finished_at"],
        transcript=(
            transcript_from_json(row["transcript_json"])
            if row["transcript_json"] is not None
            else None
        ),
        pitch_json=row["pitch_json"],
        result_generation=row["result_generation"],
    )


def insert_job(
    session_id: str, source_type: str, source_value: str, options: SeparationOptions
) -> int:
    # An upload's filename is already a usable title; a URL's title is only known
    # once the worker downloads it (see set_title), so it starts NULL.
    title = source_value if source_type == "upload" else None
    with _session() as conn:
        if session_id.startswith("acct:"):
            conn.execute("BEGIN IMMEDIATE")
            _check_queue_capacity(conn, session_id)
        cursor = conn.execute(
            """
            INSERT INTO jobs
                (session_id, status, source_type, source_value, title,
                 options_json, created_at)
            VALUES (?, 'queued', ?, ?, ?, ?, ?)
            """,
            (
                session_id,
                source_type,
                source_value,
                title,
                json.dumps(asdict(options)),
                int(time.time()),
            ),
        )
        assert cursor.lastrowid is not None
        return cursor.lastrowid


class SourceJob(NamedTuple):
    id: int
    session_id: str
    source_type: str
    source_value: str
    title: str | None
    options_json: str

    @property
    def options(self) -> SeparationOptions:
        return _load_options(self.options_json)


class RegenerationStatus(TypedDict):
    operation_id: int
    song_id: str
    title: str | None
    status: str
    completed_jobs: int
    total_jobs: int
    error_message: str | None


_SOURCE_COLUMNS = "id, session_id, source_type, source_value, title, options_json"


def completed_jobs() -> list[SourceJob]:
    with _session() as conn:
        return [
            SourceJob(*row)
            for row in conn.execute(
                f"SELECT {_SOURCE_COLUMNS} FROM jobs "
                "WHERE status='done' AND internal=0 ORDER BY id DESC"
            )
        ]


def source_job(job_id: int, *, completed: bool = True) -> SourceJob | None:
    with _session() as conn:
        row = conn.execute(
            f"SELECT {_SOURCE_COLUMNS} FROM jobs WHERE id=? AND internal=0"
            + (" AND status='done'" if completed else ""),
            (job_id,),
        ).fetchone()
        return SourceJob(*row) if row else None


def regeneration_snapshot(job_id: int) -> tuple[str, str] | None:
    with _session() as conn:
        row = conn.execute(
            "SELECT filename, source_sha256 FROM job_source_snapshots WHERE job_id=?",
            (job_id,),
        ).fetchone()
        return tuple(row) if row else None


def regeneration_origin(job_id: int) -> tuple[str, str] | None:
    with _session() as conn:
        row = conn.execute(
            "SELECT song_id, source_sha256 FROM job_source_snapshots WHERE job_id=?",
            (job_id,),
        ).fetchone()
        return (row["song_id"], row["source_sha256"]) if row else None


def regeneration_status() -> list[RegenerationStatus]:
    with _session() as conn:
        rows = conn.execute("""
            SELECT o.id AS operation_id, o.song_id, o.title,
                   CASE WHEN o.status='preparing' THEN 'clearing' ELSE o.status END
                       AS status, o.error_message,
                   COUNT(i.work_job_id) AS total_jobs,
                   SUM(CASE WHEN i.state='done' THEN 1 ELSE 0 END) AS completed_jobs
            FROM song_regeneration_operations o
            LEFT JOIN song_regeneration_items i ON i.operation_id=o.id
            WHERE o.status IN ('preparing','queued','clearing','running') OR o.id IN (
                SELECT id FROM song_regeneration_operations ORDER BY id DESC LIMIT 50
            )
            GROUP BY o.id ORDER BY o.id DESC
        """).fetchall()
        return [
            RegenerationStatus(
                operation_id=row["operation_id"],
                song_id=row["song_id"],
                title=row["title"],
                status=row["status"],
                completed_jobs=row["completed_jobs"],
                total_jobs=row["total_jobs"],
                error_message=row["error_message"],
            )
            for row in rows
        ]


def enqueue_snapshot_retry(
    items: list["PreparedRegeneration"],
    install: Callable[[int, "PreparedRegeneration"], None],
) -> list[int]:
    """Validate the complete batch before installing files or publishing jobs."""
    with _session() as conn:
        conn.execute("BEGIN IMMEDIATE")
        total = (
            conn.execute(
                "SELECT COUNT(*) FROM jobs WHERE status IN ('queued','running')"
            ).fetchone()[0]
            + conn.execute(
                "SELECT COUNT(*) FROM song_searches "
                "WHERE pending_query IS NOT NULL AND created_at > ?",
                (int(time.time()) - SEARCH_TTL,),
            ).fetchone()[0]
            + conn.execute(
                "SELECT COUNT(*) FROM song_regeneration_operations "
                "WHERE status IN ('preparing','clearing')"
            ).fetchone()[0]
        )
        global_limit = auth_store.setting(conn, "global_queue", 50)
        user_limit = auth_store.setting(conn, "user_queue", 5)
        additions = {}
        for item in items:
            job = item.job
            row = conn.execute(
                f"SELECT {_SOURCE_COLUMNS} FROM jobs WHERE id=? AND internal=0",
                (job.id,),
            ).fetchone()
            if row is None or SourceJob(*row) != job:
                raise ValueError("Original job changed")
            additions[job.session_id] = additions.get(job.session_id, 0) + 1
        if total + len(items) > global_limit:
            raise ValueError("Queue limit reached")
        for session_id, count in additions.items():
            if not session_id.startswith("acct:"):
                continue
            own = (
                conn.execute(
                    "SELECT COUNT(*) FROM jobs WHERE session_id=? "
                    "AND status IN ('queued','running')",
                    (session_id,),
                ).fetchone()[0]
                + conn.execute(
                    "SELECT COUNT(*) FROM song_searches WHERE session_id=? "
                    "AND pending_query IS NOT NULL AND created_at > ?",
                    (session_id, int(time.time()) - SEARCH_TTL),
                ).fetchone()[0]
            )
            if own + count > user_limit:
                raise ValueError("Queue limit reached")
        ids = []
        for item in items:
            job = item.job
            cursor = conn.execute(
                "INSERT INTO jobs (session_id,status,source_type,source_value,"
                "title,options_json,created_at,internal) "
                "VALUES ('internal:snapshot-retry','queued',?,?,?,?,?,1)",
                (
                    job.source_type,
                    job.source_value,
                    job.title,
                    job.options_json,
                    int(time.time()),
                ),
            )
            new_id = cursor.lastrowid
            assert new_id is not None
            conn.execute(
                "INSERT INTO job_source_snapshots "
                "(job_id,source_job_id,song_id,filename,source_sha256,ready) "
                "VALUES (?,?,?,?,?,0)",
                (new_id, job.id, item.song_id, item.filename, item.digest),
            )
            ids.append(new_id)
    try:
        for new_id, item in zip(ids, items, strict=True):
            install(new_id, item)
        with _session() as conn:
            conn.execute("BEGIN IMMEDIATE")
            for new_id, item in zip(ids, items, strict=True):
                conn.execute(
                    "UPDATE job_source_snapshots SET ready=1 WHERE job_id=?", (new_id,)
                )
                conn.execute(
                    "UPDATE jobs SET internal=0,session_id=? WHERE id=?",
                    (item.job.session_id, new_id),
                )
    except BaseException:
        with _session() as conn:
            conn.executemany(
                "UPDATE jobs SET status='failed' WHERE id=? AND internal=1",
                ((new_id,) for new_id in ids),
            )
        raise
    return ids


def prepare_song_regenerations(
    songs: list["PreparedSong"],
    install: Callable[[int, "PreparedRegeneration"], None],
) -> list[int]:
    """Persist private work and its source snapshots before any cache eviction."""
    with _session() as conn:
        conn.execute("BEGIN IMMEDIATE")
        total = (
            conn.execute(
                "SELECT COUNT(*) FROM jobs WHERE status IN ('queued','running')"
            ).fetchone()[0]
            + conn.execute(
                "SELECT COUNT(*) FROM song_searches WHERE pending_query IS NOT NULL "
                "AND created_at > ?",
                (int(time.time()) - SEARCH_TTL,),
            ).fetchone()[0]
            + conn.execute(
                "SELECT COUNT(*) FROM song_regeneration_operations "
                "WHERE status IN ('preparing','clearing')"
            ).fetchone()[0]
        )
        if total + len(songs) > auth_store.setting(conn, "global_queue", 50):
            raise ValueError("Queue limit reached")
        for song in songs:
            if conn.execute(
                "SELECT 1 FROM song_regeneration_operations WHERE song_id=? "
                "AND status IN ('preparing','queued','clearing','running')",
                (song.song_id,),
            ).fetchone():
                raise ValueError("Song is already being regenerated")
            for item in song.items:
                row = conn.execute(
                    f"SELECT {_SOURCE_COLUMNS} FROM jobs "
                    "WHERE id=? AND status='done' AND internal=0",
                    (item.job.id,),
                ).fetchone()
                if row is None or SourceJob(*row) != item.job:
                    raise ValueError("Original job changed")
        operations = []
        for song in songs:
            cursor = conn.execute(
                "INSERT INTO song_regeneration_operations "
                "(song_id,title,digest,status,created_at) VALUES (?,?,?,'preparing',?)",
                (song.song_id, song.title, song.digest, int(time.time())),
            )
            operation_id = cursor.lastrowid
            assert operation_id is not None
            operations.append(operation_id)
            for item in song.items:
                job = item.job
                cursor = conn.execute(
                    "INSERT INTO jobs (session_id,status,source_type,source_value,"
                    "title,options_json,created_at,internal) VALUES "
                    "('internal:song-regeneration','done',?,?,?,?,?,1)",
                    (
                        job.source_type,
                        job.source_value,
                        job.title,
                        job.options_json,
                        int(time.time()),
                    ),
                )
                work_id = cursor.lastrowid
                assert work_id is not None
                conn.execute(
                    "INSERT INTO job_source_snapshots "
                    "(job_id,source_job_id,song_id,filename,source_sha256,ready) "
                    "VALUES (?,?,?,?,?,0)",
                    (work_id, job.id, song.song_id, item.filename, item.digest),
                )
                conn.execute(
                    "INSERT INTO song_regeneration_items "
                    "(operation_id,original_job_id,work_job_id) VALUES (?,?,?)",
                    (operation_id, job.id, work_id),
                )
    try:
        for operation_id, song in zip(operations, songs, strict=True):
            with _session() as conn:
                work_ids = [
                    row["work_job_id"]
                    for row in conn.execute(
                        "SELECT work_job_id FROM song_regeneration_items "
                        "WHERE operation_id=? ORDER BY work_job_id",
                        (operation_id,),
                    )
                ]
            for work_id, item in zip(work_ids, song.items, strict=True):
                install(work_id, item)
        with _session() as conn:
            conn.execute("BEGIN IMMEDIATE")
            for operation_id in operations:
                conn.execute(
                    "UPDATE job_source_snapshots SET ready=1 WHERE job_id IN "
                    "(SELECT work_job_id FROM song_regeneration_items "
                    "WHERE operation_id=?)",
                    (operation_id,),
                )
                conn.execute(
                    "UPDATE song_regeneration_operations SET status='clearing' "
                    "WHERE id=? AND status='preparing'",
                    (operation_id,),
                )
    except BaseException:
        fail_song_clear(
            operations, "Source preparation failed; saved results are unchanged"
        )
        raise
    return operations


def fail_interrupted_source_preparations() -> None:
    """Never clear cache or run a job whose source copies were interrupted."""
    with _session() as conn:
        conn.execute("BEGIN IMMEDIATE")
        conn.execute(
            "UPDATE song_regeneration_operations SET status='failed',error_message=? "
            "WHERE status='preparing'",
            ("Source preparation interrupted; saved results are unchanged",),
        )
        conn.execute(
            "UPDATE jobs SET status='failed' WHERE internal=1 AND status='queued' "
            "AND EXISTS (SELECT 1 FROM job_source_snapshots s "
            "WHERE s.job_id=jobs.id AND s.ready=0)"
        )


def pending_song_clears() -> list[tuple[int, str]]:
    with _session() as conn:
        return [
            tuple(row)
            for row in conn.execute(
                "SELECT id,song_id FROM song_regeneration_operations "
                "WHERE status='clearing'"
            )
        ]


def _sources_ready(conn: sqlite3.Connection, operation_id: int) -> bool:
    row = conn.execute(
        "SELECT COUNT(*) AS total, "
        "SUM(CASE WHEN s.ready=1 THEN 0 ELSE 1 END) AS missing "
        "FROM song_regeneration_items i LEFT JOIN job_source_snapshots s "
        "ON s.job_id=i.work_job_id WHERE i.operation_id=?",
        (operation_id,),
    ).fetchone()
    return row["total"] > 0 and row["missing"] == 0


def require_regeneration_sources(operation_ids: list[int]) -> None:
    with _session() as conn:
        if any(
            not _sources_ready(conn, operation_id) for operation_id in operation_ids
        ):
            raise ValueError("Regeneration sources are not ready")


def activate_song_regenerations(operation_ids: list[int]) -> None:
    with _session() as conn:
        conn.execute("BEGIN IMMEDIATE")
        for operation_id in operation_ids:
            if not _sources_ready(conn, operation_id):
                raise ValueError("Regeneration sources are not ready")
            changed = conn.execute(
                "UPDATE song_regeneration_operations SET status='queued' "
                "WHERE id=? AND status='clearing'",
                (operation_id,),
            ).rowcount
            if changed != 1:
                raise ValueError("Regeneration is not awaiting cache clear")
            next_item = conn.execute(
                "SELECT work_job_id FROM song_regeneration_items "
                "WHERE operation_id=? AND state='pending' ORDER BY work_job_id LIMIT 1",
                (operation_id,),
            ).fetchone()
            if next_item is not None:
                conn.execute(
                    "UPDATE jobs SET status='queued' WHERE id=?", (next_item[0],)
                )
                conn.execute(
                    "UPDATE song_regeneration_items SET state='queued' "
                    "WHERE work_job_id=?",
                    (next_item[0],),
                )


def fail_song_clear(operation_ids: list[int], message: str) -> None:
    with _session() as conn:
        conn.executemany(
            "UPDATE song_regeneration_operations SET status='failed',error_message=? "
            "WHERE id=? AND status IN ('preparing','clearing')",
            ((message, operation_id) for operation_id in operation_ids),
        )


def regeneration_work(job_id: int) -> tuple[int, int] | None:
    with _session() as conn:
        row = conn.execute(
            "SELECT operation_id, original_job_id FROM song_regeneration_items "
            "WHERE work_job_id=?",
            (job_id,),
        ).fetchone()
        return (row["operation_id"], row["original_job_id"]) if row else None


def _finish_regeneration_work(conn, job_id: int, message: str | None) -> None:
    row = conn.execute(
        "SELECT operation_id FROM song_regeneration_items "
        "WHERE work_job_id=? AND state='running'",
        (job_id,),
    ).fetchone()
    if row is None:
        return
    op = row["operation_id"]
    conn.execute(
        "UPDATE song_regeneration_items SET state=? WHERE work_job_id=?",
        ("failed" if message else "done", job_id),
    )
    if message:
        conn.execute(
            "UPDATE song_regeneration_operations "
            "SET error_message=COALESCE(error_message,?) WHERE id=?",
            (message, op),
        )
    remaining = conn.execute(
        "SELECT COUNT(*) FROM song_regeneration_items WHERE operation_id=? "
        "AND state NOT IN ('done','failed')",
        (op,),
    ).fetchone()[0]
    if not remaining:
        conn.execute(
            "UPDATE song_regeneration_operations SET status=CASE "
            "WHEN error_message IS NULL THEN 'done' ELSE 'failed' END WHERE id=?",
            (op,),
        )
    else:
        next_item = conn.execute(
            "SELECT work_job_id FROM song_regeneration_items "
            "WHERE operation_id=? AND state='pending' ORDER BY work_job_id LIMIT 1",
            (op,),
        ).fetchone()
        if next_item is not None:
            conn.execute("UPDATE jobs SET status='queued' WHERE id=?", (next_item[0],))
            conn.execute(
                "UPDATE song_regeneration_items SET state='queued' WHERE work_job_id=?",
                (next_item[0],),
            )


def publish_regeneration(
    work_id: int,
    original_id: int,
    generation: str,
    manifest: list[ResultManifestEntry],
    transcript: Transcript | None,
    pitch_json: str | None,
    original_key: str | None,
) -> None:
    with _session() as conn:
        conn.execute("BEGIN IMMEDIATE")
        changed = conn.execute(
            "UPDATE jobs SET result_generation=?,result_manifest_json=?,"
            "transcript_json=?,pitch_json=?,original_key=? "
            "WHERE id=? AND status='done' AND internal=0 AND EXISTS ("
            "SELECT 1 FROM song_regeneration_items WHERE work_job_id=? "
            "AND original_job_id=jobs.id AND state='running')",
            (
                generation,
                json.dumps([entry.model_dump() for entry in manifest]),
                json.dumps(asdict(transcript), ensure_ascii=False)
                if transcript
                else None,
                pitch_json,
                original_key,
                original_id,
                work_id,
            ),
        ).rowcount
        if changed != 1:
            raise ValueError("Original job changed during regeneration")
        conn.execute(
            "UPDATE jobs SET status='done',finished_at=? WHERE id=? AND internal=1",
            (int(time.time()), work_id),
        )
        _finish_regeneration_work(conn, work_id, None)


def set_title(job_id: int, title: str) -> None:
    with _session() as conn:
        conn.execute("UPDATE jobs SET title = ? WHERE id = ?", (title, job_id))


def set_original_key(job_id: int, original_key: str | None) -> None:
    with _session() as conn:
        conn.execute(
            "UPDATE jobs SET original_key = ? WHERE id = ?", (original_key, job_id)
        )


def get_job(job_id: int) -> JobRecord | None:
    with _session() as conn:
        row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
        return _row_to_job(row) if row else None


def delete_completed_job(
    job_id: int,
    session_id: str,
    expected_stage: tuple[str | None, str | None],
    remove_files: Callable[[list[StageOwner]], list[int]],
) -> bool:
    """Delete a finished owned job only if its dispatch ownership is unchanged."""
    with _session() as conn:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT session_id, status, active_stage_key, modal_call_id "
            "FROM jobs WHERE id = ?",
            (job_id,),
        ).fetchone()
        if row is None or row["session_id"] != session_id:
            return False
        if (
            row["status"] != JobStatus.DONE
            or (row["active_stage_key"], row["modal_call_id"]) != expected_stage
        ):
            raise ValueError("Job is not ready for deletion")
        if conn.execute(
            "SELECT 1 FROM song_regeneration_items i "
            "JOIN song_regeneration_operations o ON o.id=i.operation_id "
            "WHERE i.original_job_id=? "
            "AND o.status IN ('preparing','queued','clearing','running')",
            (job_id,),
        ).fetchone():
            raise ValueError("Job is being regenerated")
        work = [
            tuple(row)
            for row in conn.execute(
                "SELECT j.id,j.active_stage_key,j.modal_call_id "
                "FROM song_regeneration_items i JOIN jobs j ON j.id=i.work_job_id "
                "JOIN job_source_snapshots s ON s.job_id=j.id "
                "AND s.source_job_id=i.original_job_id "
                "WHERE i.original_job_id=? AND j.internal=1 "
                "AND j.session_id='internal:song-regeneration' "
                "AND j.status IN ('done','failed')",
                (job_id,),
            )
        ]
        removed_work = remove_files(work)
        conn.executemany(
            "DELETE FROM job_source_snapshots WHERE job_id=?",
            ((work_id,) for work_id in removed_work),
        )
        conn.execute("DELETE FROM job_source_snapshots WHERE job_id = ?", (job_id,))
        conn.execute("DELETE FROM jobs WHERE id = ?", (job_id,))
        return True


def list_jobs_for_session(session_id: str, limit: int = 50) -> list[JobRecord]:
    with _session() as conn:
        rows = conn.execute(
            "SELECT * FROM jobs WHERE session_id = ? AND internal=0 "
            "ORDER BY id DESC LIMIT ?",
            (session_id, limit),
        ).fetchall()
        return [_row_to_job(row) for row in rows]


def get_latest_job_for_session(session_id: str) -> JobRecord | None:
    jobs = list_jobs_for_session(session_id, limit=1)
    return jobs[0] if jobs else None


def list_recent_jobs(limit: int = 50) -> list[JobRecord]:
    """All jobs across every session, newest first — for the ops status page."""
    with _session() as conn:
        rows = conn.execute(
            "SELECT * FROM jobs WHERE internal=0 ORDER BY id DESC LIMIT ?", (limit,)
        ).fetchall()
        return [_row_to_job(row) for row in rows]


def status_counts() -> dict[str, int]:
    with _session() as conn:
        rows = conn.execute(
            "SELECT status, COUNT(*) AS n FROM jobs "
            "WHERE internal=0 OR status IN ('queued','running') GROUP BY status"
        ).fetchall()
        return {row["status"]: row["n"] for row in rows}


def total_result_bytes() -> int:
    """Sum of stem sizes across all manifests — from the DB, no filesystem walk."""
    with _session() as conn:
        row = conn.execute(
            """
            SELECT COALESCE(SUM(json_extract(entry.value, '$.size_bytes')), 0) AS total
            FROM jobs, json_each(COALESCE(jobs.result_manifest_json, '[]')) AS entry
            """
        ).fetchone()
        return int(row["total"])


def queue_position(job_id: int) -> int:
    """1-based position among queued jobs (a job with no one ahead of it is #1)."""
    with _session() as conn:
        row = conn.execute(
            "SELECT COUNT(*) AS n FROM jobs WHERE status = 'queued' AND id < ?",
            (job_id,),
        ).fetchone()
        return row["n"] + 1


def claim_oldest_queued() -> JobRecord | None:
    with _session() as conn:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT id FROM jobs WHERE status = 'queued' AND NOT EXISTS "
            "(SELECT 1 FROM job_source_snapshots s WHERE s.job_id=jobs.id "
            "AND s.ready=0) ORDER BY id LIMIT 1"
        ).fetchone()
        if row is None:
            return None
        job_id = row["id"]
        conn.execute(
            "UPDATE jobs SET status = 'running', started_at = ? WHERE id = ?",
            (int(time.time()), job_id),
        )
        conn.execute(
            "UPDATE song_regeneration_items SET state='running' WHERE work_job_id=?",
            (job_id,),
        )
        conn.execute(
            "UPDATE song_regeneration_operations SET status='running' "
            "WHERE id=(SELECT operation_id FROM song_regeneration_items "
            "WHERE work_job_id=?)",
            (job_id,),
        )
        return _row_to_job(
            conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
        )


def claim_inference_stage(
    job_id: int, stage_key: str, completed_stage: CompletedStage | None = None
) -> InferenceStageClaim:
    """Claim a stage without discarding another uncompleted dispatch."""
    with _session() as conn:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT * FROM jobs WHERE active_stage_key = ?", (stage_key,)
        ).fetchone()
        if row is not None:
            return InferenceStageClaim(_row_to_job(row), False)
        owner = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
        if owner is None:
            raise ValueError("Job not found.")
        previous = owner["active_stage_key"]
        if (
            previous is not None
            and (previous, owner["modal_call_id"]) != completed_stage
        ):
            raise UncompletedInferenceStage(
                "Job has another uncompleted inference stage"
            )
        conn.execute(
            "UPDATE jobs SET active_stage_key = ?, modal_call_id = NULL WHERE id = ?",
            (stage_key, job_id),
        )
        row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
        if row is None:
            raise ValueError("Job not found.")
        return InferenceStageClaim(_row_to_job(row), True)


def set_active_stage(job_id: int, stage_key: str, call_id: str | None) -> None:
    with _session() as conn:
        conn.execute(
            "UPDATE jobs SET active_stage_key = ?, modal_call_id = ? WHERE id = ?",
            (stage_key, call_id, job_id),
        )


def release_inference_stage(job_id: int, stage_key: str) -> bool:
    """Operator-only release; a recorded remote call must never be discarded."""
    with _session() as conn:
        return (
            conn.execute(
                "UPDATE jobs SET active_stage_key = NULL "
                "WHERE id = ? AND active_stage_key = ? AND modal_call_id IS NULL",
                (job_id, stage_key),
            ).rowcount
            == 1
        )


def cache_work_state(
    *, clearing_operations: tuple[int, ...] = ()
) -> tuple[bool, list[StageOwner]]:
    """Return work and durable stage owners while cache admission is gated."""
    with _session() as conn:
        busy = conn.execute(
            "SELECT EXISTS(SELECT 1 FROM jobs WHERE status IN ('queued','running')) "
            "OR EXISTS(SELECT 1 FROM song_searches "
            "WHERE pending_query IS NOT NULL OR claimed_at IS NOT NULL)"
        ).fetchone()[0]
        busy = busy or any(
            row["status"] == "preparing" or row["id"] not in clearing_operations
            for row in conn.execute(
                "SELECT id,status FROM song_regeneration_operations "
                "WHERE status IN ('preparing','clearing')"
            )
        )
        owners = conn.execute(
            "SELECT id, active_stage_key, modal_call_id FROM jobs "
            "WHERE active_stage_key IS NOT NULL OR modal_call_id IS NOT NULL"
        ).fetchall()
        return bool(busy), [tuple(row) for row in owners]


def retire_cache_stages(
    owners: list[RetiringStage], *, invalidate_search: bool = False
) -> None:
    """Atomically release validated owners and invalidate global search reuse."""
    if not owners and not invalidate_search:
        return
    with _session() as conn:
        conn.execute("BEGIN IMMEDIATE")
        for job_id, key, call_id in owners:
            changed = conn.execute(
                "UPDATE jobs SET active_stage_key = NULL, modal_call_id = NULL "
                "WHERE id = ? AND active_stage_key = ? AND modal_call_id = ? "
                "AND status NOT IN ('queued','running')",
                (job_id, key, call_id),
            ).rowcount
            if changed != 1:
                raise ValueError("Inference ownership changed")
        if invalidate_search:
            conn.execute("UPDATE song_searches SET successful_at = NULL")


def update_result_size(
    job_id: int, label: str, size_bytes: int, *, expected_generation: str | None = None
) -> None:
    """Refresh one migrated result without losing concurrent manifest updates."""
    with _session() as conn:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT result_manifest_json FROM jobs "
            "WHERE id = ? AND result_generation IS ?",
            (job_id, expected_generation),
        ).fetchone()
        if row is None or row["result_manifest_json"] is None:
            return
        manifest = json.loads(row["result_manifest_json"])
        for entry in manifest:
            if entry["label"] == label:
                entry["size_bytes"] = size_bytes
                conn.execute(
                    "UPDATE jobs SET result_manifest_json = ? WHERE id = ?",
                    (json.dumps(manifest), job_id),
                )
                break


def mark_done(
    job_id: int,
    manifest: list[ResultManifestEntry],
    transcript: Transcript | None = None,
    pitch_json: str | None = None,
) -> None:
    with _session() as conn:
        conn.execute(
            "UPDATE jobs SET status = 'done', result_manifest_json = ?, "
            "transcript_json = ?, pitch_json = ?, finished_at = ? WHERE id = ?",
            (
                json.dumps([entry.model_dump() for entry in manifest]),
                json.dumps(asdict(transcript), ensure_ascii=False)
                if transcript
                else None,
                pitch_json,
                int(time.time()),
                job_id,
            ),
        )


def mark_failed(job_id: int, error_message: str) -> None:
    with _session() as conn:
        conn.execute(
            "UPDATE jobs SET status = 'failed', error_message = ?, "
            "finished_at = ? WHERE id = ?",
            (error_message, int(time.time()), job_id),
        )
        _finish_regeneration_work(conn, job_id, error_message)


def requeue_job(job_id: int) -> None:
    """Defer a running job without altering its durable inference ownership."""
    with _session() as conn:
        conn.execute(
            "UPDATE jobs SET status = 'queued', started_at = NULL "
            "WHERE id = ? AND status = 'running'",
            (job_id,),
        )
        conn.execute(
            "UPDATE song_regeneration_items SET state='queued' "
            "WHERE work_job_id=? AND state='running'",
            (job_id,),
        )
        conn.execute(
            "UPDATE song_regeneration_operations SET status='queued' WHERE id=("
            "SELECT operation_id FROM song_regeneration_items WHERE work_job_id=?) "
            "AND NOT EXISTS (SELECT 1 FROM song_regeneration_items "
            "WHERE operation_id=song_regeneration_operations.id AND state='running')",
            (job_id,),
        )


def reap_running_to_queued() -> None:
    with _session() as conn:
        conn.execute(
            "UPDATE jobs SET status = 'queued', started_at = NULL "
            "WHERE status = 'running'"
        )
        conn.execute(
            "UPDATE song_regeneration_items SET state='queued' WHERE state='running'"
        )
        conn.execute(
            "UPDATE song_regeneration_operations SET status='queued' "
            "WHERE status='running'"
        )
