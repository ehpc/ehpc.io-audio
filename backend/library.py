"""Owner-scoped song identity and immutable processing-attempt membership."""

import sqlite3

from backend import db, source_cache, source_identity


def merge_songs(conn: sqlite3.Connection, first: int, second: int) -> int:
    """Merge verified aliases, retaining the oldest stable song ID and all work."""
    keep, remove = sorted((first, second))
    if keep == remove:
        return keep
    owners = conn.execute(
        "SELECT id, session_id, open_count FROM library_songs WHERE id IN (?, ?)",
        (keep, remove),
    ).fetchall()
    if len(owners) != 2 or owners[0]["session_id"] != owners[1]["session_id"]:
        raise ValueError("Cannot merge songs belonging to different owners")
    count = sum(row["open_count"] for row in owners)
    conn.execute("UPDATE library_songs SET open_count=? WHERE id=?", (count, keep))
    conn.execute(
        "UPDATE library_song_jobs SET song_id=? WHERE song_id=?", (keep, remove)
    )
    conn.execute(
        "UPDATE library_song_sources SET song_id=? WHERE song_id=?", (keep, remove)
    )
    conn.execute("DELETE FROM library_songs WHERE id=?", (remove,))
    return keep


def attach_source(
    conn: sqlite3.Connection, song_id: int, owner: str, kind: str, identity: str
) -> int:
    row = conn.execute(
        "SELECT song_id FROM library_song_sources "
        "WHERE session_id=? AND kind=? AND identity=?",
        (owner, kind, identity),
    ).fetchone()
    if row is not None:
        return merge_songs(conn, song_id, row["song_id"])
    conn.execute(
        "INSERT INTO library_song_sources(session_id,kind,identity,song_id) "
        "VALUES (?,?,?,?)",
        (owner, kind, identity, song_id),
    )
    return song_id


def migrate_jobs(conn: sqlite3.Connection) -> None:
    """Attach legacy rows once; never infer identity from a filename or title."""
    rows = conn.execute(
        "SELECT j.id,j.session_id,j.source_type,j.source_value,j.open_count "
        "FROM jobs j LEFT JOIN library_song_jobs m ON m.job_id=j.id "
        "WHERE j.internal=0 AND m.job_id IS NULL ORDER BY j.id"
    ).fetchall()
    for row in rows:
        job_id, owner = row["id"], row["session_id"]
        conn.execute(
            "INSERT INTO library_songs(id,session_id,open_count) VALUES (?,?,?)",
            (job_id, owner, row["open_count"]),
        )
        conn.execute(
            "INSERT INTO library_song_jobs(job_id,song_id) VALUES (?,?)",
            (job_id, job_id),
        )
        if row["source_type"] == "url":
            job_id = attach_source(
                conn,
                job_id,
                owner,
                "url",
                source_cache.source_identity(row["source_value"]),
            )
        with source_identity.open_source(row["id"]) as source:
            if source is not None:
                attach_source(conn, job_id, owner, "sha256", source.digest)


def bind_digest(job_id: int, digest: str) -> int | None:
    """Attach a verified downloaded source to its owner's library identity."""
    with db._session() as conn:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT m.song_id,j.session_id FROM library_song_jobs m "
            "JOIN jobs j ON j.id=m.job_id WHERE j.id=? AND j.internal=0",
            (job_id,),
        ).fetchone()
        if row is None:
            return None
        return attach_source(conn, row["song_id"], row["session_id"], "sha256", digest)


def reassign_owner(conn: sqlite3.Connection, old_owner: str, new_owner: str) -> None:
    """Move a legacy principal's songs and merge matching owned aliases atomically."""
    songs = conn.execute(
        "SELECT id FROM library_songs WHERE session_id=? ORDER BY id", (old_owner,)
    ).fetchall()
    for song in songs:
        song_id = song["id"]
        conn.execute(
            "UPDATE library_songs SET session_id=? WHERE id=?", (new_owner, song_id)
        )
        sources = conn.execute(
            "SELECT kind,identity FROM library_song_sources "
            "WHERE session_id=? AND song_id=?",
            (old_owner, song_id),
        ).fetchall()
        for source in sources:
            kind, identity = source["kind"], source["identity"]
            existing = conn.execute(
                "SELECT song_id FROM library_song_sources "
                "WHERE session_id=? AND kind=? AND identity=?",
                (new_owner, kind, identity),
            ).fetchone()
            if existing is None:
                conn.execute(
                    "UPDATE library_song_sources SET session_id=? "
                    "WHERE session_id=? AND kind=? AND identity=?",
                    (new_owner, old_owner, kind, identity),
                )
            else:
                conn.execute(
                    "DELETE FROM library_song_sources "
                    "WHERE session_id=? AND kind=? AND identity=?",
                    (old_owner, kind, identity),
                )
                song_id = merge_songs(conn, song_id, existing["song_id"])


def song_for_work(job_id: int, owner: str) -> int | None:
    with db._session() as conn:
        row = conn.execute(
            "SELECT m.song_id FROM library_song_jobs m "
            "JOIN library_songs s ON s.id=m.song_id "
            "WHERE m.job_id=? AND s.session_id=?",
            (job_id, owner),
        ).fetchone()
        return row["song_id"] if row is not None else None


def song_work_ids(owner: str, song_id: int) -> list[int] | None:
    with db._session() as conn:
        if (
            conn.execute(
                "SELECT 1 FROM library_songs WHERE id=? AND session_id=?",
                (song_id, owner),
            ).fetchone()
            is None
        ):
            return None
        return [
            row["job_id"]
            for row in conn.execute(
                "SELECT job_id FROM library_song_jobs WHERE song_id=? ORDER BY job_id",
                (song_id,),
            )
        ]


def find_song(
    owner: str, source_type: str, value: str, digest: str | None
) -> int | None:
    aliases = []
    if source_type == "url":
        aliases.append(("url", source_cache.source_identity(value)))
    if digest is not None:
        aliases.append(("sha256", digest))
    with db._session() as conn:
        for kind, identity in aliases:
            row = conn.execute(
                "SELECT song_id FROM library_song_sources "
                "WHERE session_id=? AND kind=? AND identity=?",
                (owner, kind, identity),
            ).fetchone()
            if row is not None:
                return row["song_id"]
    return None


def older_running_work(song_id: int, work_id: int) -> bool:
    with db._session() as conn:
        return (
            conn.execute(
                "SELECT 1 FROM library_song_jobs m JOIN jobs j ON j.id=m.job_id "
                "WHERE m.song_id=? AND j.id<? AND j.status='running' LIMIT 1",
                (song_id, work_id),
            ).fetchone()
            is not None
        )
