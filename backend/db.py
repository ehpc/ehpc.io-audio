import json
import sqlite3
import time
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import asdict, fields
from typing import NamedTuple

from backend import auth_store, config
from backend.models import JobRecord, JobStatus, ResultManifestEntry
from separator.lyrics import Transcript, transcript_from_json
from separator.options import SeparationOptions
from separator.song_search import SEARCH_TTL

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
        conn.execute("BEGIN IMMEDIATE")
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


def cache_work_state() -> tuple[bool, list[StageOwner]]:
    """Return work and durable stage owners while cache admission is gated."""
    with _session() as conn:
        busy = conn.execute(
            "SELECT EXISTS(SELECT 1 FROM jobs WHERE status IN ('queued','running')) "
            "OR EXISTS(SELECT 1 FROM song_searches "
            "WHERE pending_query IS NOT NULL OR claimed_at IS NOT NULL)"
        ).fetchone()[0]
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


def update_result_size(job_id: int, label: str, size_bytes: int) -> None:
    """Refresh one migrated result without losing concurrent manifest updates."""
    with _session() as conn:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT result_manifest_json FROM jobs WHERE id = ?", (job_id,)
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


def requeue_job(job_id: int) -> None:
    """Defer a running job without altering its durable inference ownership."""
    with _session() as conn:
        conn.execute(
            "UPDATE jobs SET status = 'queued', started_at = NULL "
            "WHERE id = ? AND status = 'running'",
            (job_id,),
        )


def reap_running_to_queued() -> None:
    with _session() as conn:
        conn.execute(
            "UPDATE jobs SET status = 'queued', started_at = NULL "
            "WHERE status = 'running'"
        )
