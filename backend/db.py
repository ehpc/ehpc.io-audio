import json
import sqlite3
import time
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import asdict, fields

from backend import config
from backend.models import JobRecord, JobStatus, ResultManifestEntry
from separator.options import SeparationOptions

_OPTION_FIELDS = {f.name for f in fields(SeparationOptions)}
# Renamed options in older stored jobs → current field names.
_RENAMED_OPTIONS = {"chorus": "genders", "vocalists": "lead_backing"}


def _load_options(options_json: str) -> SeparationOptions:
    """Deserialize options tolerantly: map renamed keys, drop any unknown ones,
    so jobs written by an older schema still load."""
    data = json.loads(options_json)
    for old, new in _RENAMED_OPTIONS.items():
        if old in data:
            data.setdefault(new, data.pop(old))
    return SeparationOptions(**{k: v for k, v in data.items() if k in _OPTION_FIELDS})


_SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued','running','done','failed')),
    source_type TEXT NOT NULL CHECK (source_type IN ('url','upload')),
    source_value TEXT NOT NULL,
    title TEXT,
    options_json TEXT NOT NULL,
    modal_call_id TEXT,
    result_manifest_json TEXT,
    error_message TEXT,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_jobs_status_id ON jobs(status, id);
CREATE INDEX IF NOT EXISTS idx_jobs_session_id ON jobs(session_id, id DESC);
"""


def _migrate(conn: sqlite3.Connection) -> None:
    columns = {row["name"] for row in conn.execute("PRAGMA table_info(jobs)")}
    if "title" not in columns:
        conn.execute("ALTER TABLE jobs ADD COLUMN title TEXT")


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
        _migrate(conn)


def health_check() -> None:
    with _session() as conn:
        conn.execute("SELECT 1")


def _row_to_job(row: sqlite3.Row) -> JobRecord:
    manifest_json = row["result_manifest_json"]
    return JobRecord(
        id=row["id"],
        session_id=row["session_id"],
        status=JobStatus(row["status"]),
        source_type=row["source_type"],
        source_value=row["source_value"],
        title=row["title"],
        options=_load_options(row["options_json"]),
        modal_call_id=row["modal_call_id"],
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
    )


def insert_job(
    session_id: str, source_type: str, source_value: str, options: SeparationOptions
) -> int:
    # An upload's filename is already a usable title; a URL's title is only known
    # once the worker downloads it (see set_title), so it starts NULL.
    title = source_value if source_type == "upload" else None
    with _session() as conn:
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


def set_title(job_id: int, title: str) -> None:
    with _session() as conn:
        conn.execute("UPDATE jobs SET title = ? WHERE id = ?", (title, job_id))


def get_job(job_id: int) -> JobRecord | None:
    with _session() as conn:
        row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
        return _row_to_job(row) if row else None


def list_jobs_for_session(session_id: str, limit: int = 50) -> list[JobRecord]:
    with _session() as conn:
        rows = conn.execute(
            "SELECT * FROM jobs WHERE session_id = ? ORDER BY id DESC LIMIT ?",
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
            "SELECT * FROM jobs ORDER BY id DESC LIMIT ?", (limit,)
        ).fetchall()
        return [_row_to_job(row) for row in rows]


def status_counts() -> dict[str, int]:
    with _session() as conn:
        rows = conn.execute(
            "SELECT status, COUNT(*) AS n FROM jobs GROUP BY status"
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
        row = conn.execute(
            "SELECT id FROM jobs WHERE status = 'queued' ORDER BY id LIMIT 1"
        ).fetchone()
        if row is None:
            return None
        job_id = row["id"]
        conn.execute(
            "UPDATE jobs SET status = 'running', started_at = ? WHERE id = ?",
            (int(time.time()), job_id),
        )
        return _row_to_job(
            conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
        )


def set_modal_call_id(job_id: int, call_id: str) -> None:
    with _session() as conn:
        conn.execute(
            "UPDATE jobs SET modal_call_id = ? WHERE id = ?", (call_id, job_id)
        )


def mark_done(job_id: int, manifest: list[ResultManifestEntry]) -> None:
    with _session() as conn:
        conn.execute(
            "UPDATE jobs SET status = 'done', result_manifest_json = ?, "
            "finished_at = ? WHERE id = ?",
            (
                json.dumps([entry.model_dump() for entry in manifest]),
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


def reap_running_to_queued() -> None:
    with _session() as conn:
        conn.execute(
            "UPDATE jobs SET status = 'queued', started_at = NULL "
            "WHERE status = 'running'"
        )
