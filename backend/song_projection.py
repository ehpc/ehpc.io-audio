"""Bounded library projections; full analysis is fetched by work ID on demand."""

import json
from collections import defaultdict
from dataclasses import dataclass, field

from backend import config, coverage, db
from backend.models import (
    JobStatus,
    ResultManifestEntry,
    SongAvailability,
    SongDetail,
    SongOutputRef,
    SongSummary,
    SongVariant,
    download_filename,
)

type WorkRef = tuple[int, str | None]


@dataclass
class VariantGroup:
    outputs: dict[str, SongOutputRef] = field(default_factory=dict)
    karaoke: WorkRef | None = None
    lyrics: WorkRef | None = None
    pitched: WorkRef | None = None


def _rows(conn, song_ids: list[int]):
    if not song_ids:
        return []
    placeholders = ",".join("?" for _ in song_ids)
    return conn.execute(
        "SELECT m.song_id,j.id,j.source_type,j.source_value,j.title,j.created_at,"
        "j.status,j.options_json,j.result_manifest_json,j.result_generation,"
        "j.original_key,j.transcript_json IS NOT NULL AS has_transcript,"
        "j.pitch_json IS NOT NULL AS has_pitch "
        "FROM library_song_jobs m JOIN jobs j ON j.id=m.job_id "
        f"WHERE m.song_id IN ({placeholders}) ORDER BY j.id",
        song_ids,
    ).fetchall()


def _original(work_id: int) -> bool:
    directory = config.UPLOADS_DIR / str(work_id)
    return directory.is_dir() and any(path.is_file() for path in directory.iterdir())


def _summary(song, rows) -> SongSummary:
    first, latest = rows[0], rows[-1]
    active = next(
        (row for row in reversed(rows) if row["status"] in ("queued", "running")), None
    )
    completed = [row for row in rows if row["status"] == "done"]
    available = SongAvailability()
    for row in completed:
        options = db._load_options(row["options_json"])
        available.audio |= bool(
            row["result_manifest_json"] and json.loads(row["result_manifest_json"])
        )
        available.karaoke |= bool(row["has_pitch"] and options.detect_pitch)
        available.lyrics |= bool(row["has_transcript"] and options.extract_lyrics)
        available.pitched_lyrics |= bool(
            row["has_pitch"]
            and row["has_transcript"]
            and (options.detect_pitch or options.extract_pitched_lyrics)
        )
    original = next((row["id"] for row in rows if _original(row["id"])), None)
    available.audio |= original is not None
    return SongSummary(
        id=song["id"],
        title=next((row["title"] for row in rows if row["title"]), None),
        source_type=first["source_type"],
        source_value=first["source_value"],
        created_at=first["created_at"],
        open_count=song["open_count"],
        has_original=original is not None,
        original_work_id=original,
        original_key=next(
            (row["original_key"] for row in rows if row["original_key"]), None
        ),
        status=JobStatus(
            active["status"] if active else "done" if completed else latest["status"]
        ),
        latest_work_id=latest["id"],
        active_work_ids=[
            row["id"] for row in rows if row["status"] in ("queued", "running")
        ],
        active_work_id=active["id"] if active else None,
        availability=available,
    )


def summaries(
    owner: str, sort: db.JobSort = "usage", limit: int = 50
) -> list[SongSummary]:
    order = (
        "s.open_count DESC, first_created DESC, s.id DESC"
        if sort == "usage"
        else "first_created DESC, s.id DESC"
    )
    with db._session() as conn:
        songs = conn.execute(
            "SELECT s.*, (SELECT j.created_at FROM library_song_jobs m "
            "JOIN jobs j ON j.id=m.job_id WHERE m.song_id=s.id "
            "ORDER BY j.id LIMIT 1) AS first_created FROM library_songs s "
            "WHERE s.session_id=? AND first_created IS NOT NULL "
            f"ORDER BY {order} LIMIT ?",
            (owner, limit),
        ).fetchall()
        rows = _rows(conn, [song["id"] for song in songs])
    grouped = defaultdict(list)
    for row in rows:
        grouped[row["song_id"]].append(row)
    return [_summary(song, grouped[song["id"]]) for song in songs]


def current(owner: str) -> SongSummary | None:
    with db._session() as conn:
        song = conn.execute(
            "SELECT s.* FROM library_songs s "
            "JOIN library_song_jobs m ON m.song_id=s.id "
            "JOIN jobs j ON j.id=m.job_id WHERE s.session_id=? "
            "ORDER BY j.id DESC LIMIT 1",
            (owner,),
        ).fetchone()
        if song is None:
            return None
        rows = _rows(conn, [song["id"]])
    return _summary(song, rows)


def detail(owner: str, song_id: int) -> SongDetail | None:
    with db._session() as conn:
        song = conn.execute(
            "SELECT * FROM library_songs WHERE id=? AND session_id=?", (song_id, owner)
        ).fetchone()
        if song is None:
            return None
        rows = _rows(conn, [song_id])
    groups: dict[tuple[float, float], VariantGroup] = {}
    for row in rows:
        if row["status"] != "done":
            continue
        options = db._load_options(row["options_json"])
        key = (options.pitch_semitones, options.tempo_percent)
        if key not in groups:
            groups[key] = VariantGroup()
        group = groups[key]
        for raw in json.loads(row["result_manifest_json"] or "[]"):
            entry = ResultManifestEntry.model_validate(raw)
            identity = coverage.output_identity(entry.label, options)
            name = coverage.output_display_name(entry.label, options)
            entry = entry.model_copy(
                update={
                    "display_name": name,
                    "download_name": download_filename(
                        row["title"],
                        row["id"],
                        entry.label,
                        options,
                        row["original_key"],
                    ),
                }
            )
            group.outputs[identity] = SongOutputRef(
                identity=identity,
                label=entry.label,
                display_name=name,
                work_id=row["id"],
                revision=row["result_generation"],
                manifest=entry,
            )
        reference = (row["id"], row["result_generation"])
        if row["has_pitch"] and options.detect_pitch:
            group.karaoke = reference
        if row["has_transcript"] and options.extract_lyrics:
            group.lyrics = reference
        if (
            row["has_pitch"]
            and row["has_transcript"]
            and (options.detect_pitch or options.extract_pitched_lyrics)
        ):
            group.pitched = reference
    variants = []
    for (pitch, tempo), group in groups.items():
        karaoke = group.karaoke or (None, None)
        lyrics = group.lyrics or (None, None)
        pitched = group.pitched or (None, None)
        variants.append(
            SongVariant(
                pitch_semitones=pitch,
                tempo_percent=tempo,
                outputs=list(group.outputs.values()),
                karaoke_work_id=karaoke[0],
                karaoke_revision=karaoke[1],
                lyrics_work_id=lyrics[0],
                lyrics_revision=lyrics[1],
                pitched_lyrics_work_id=pitched[0],
                pitched_lyrics_revision=pitched[1],
            )
        )
    return SongDetail(summary=_summary(song, rows), variants=variants)
