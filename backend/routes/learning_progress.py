"""Private guided lyric recall, keyed by original audio and lyric document."""

import hashlib
import json
from typing import Annotated, Literal, TypedDict

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from backend import db
from backend.routes.results import _tracked_thread
from backend.session import get_session_id
from backend.source_identity import open_source
from separator.lyrics import (
    TranscriptSection,
    ordered_lyric_lines,
    transcript_from_json,
)

router = APIRouter(tags=["learning progress"])
Hint = Literal["full", "partial", "first", "hidden"]
Identifier = Annotated[str, Field(min_length=1, max_length=128)]
MAX_TRANSCRIPT_BYTES = 2 * 1024 * 1024
MAX_DOCUMENT_BYTES = 2 * 1024 * 1024
MAX_STATE_BYTES = 2 * 1024 * 1024
MAX_ITEMS = 4096


class LearningLine(TypedDict):
    id: str
    text: str
    onset_s: float | None
    end_s: float | None
    onset_source: str


class LearningSection(TypedDict):
    id: str
    label: str
    start_s: float
    end_s: float


class ProgressState(TypedDict, total=False):
    hint_level: Hint
    section_id: str | None
    line_id: str | None
    difficulties: dict[str, int]
    cursor: int
    round: int


type LearningDocument = tuple[str, list[LearningLine], list[LearningSection]]


class Preferences(BaseModel):
    model_config = ConfigDict(extra="forbid")
    document_version: Identifier
    hint_level: Hint | None = None
    section_id: Identifier | None = None
    line_id: Identifier | None = None


class Review(BaseModel):
    model_config = ConfigDict(extra="forbid")
    document_version: Identifier
    line_id: Identifier
    rating: Literal["remembered", "hesitated", "forgot"]


def _hash(value) -> str:
    return hashlib.sha256(
        json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()
    ).hexdigest()


def _document(raw: str) -> LearningDocument:
    value = json.loads(raw)
    for key in (
        "segments",
        "sections",
        "words",
        "untimed",
        "asr_extras",
        "recognition_chunks",
        "canonical_word_positions",
    ):
        if len(value.get(key, [])) > MAX_ITEMS:
            raise HTTPException(413, "Transcript is too large for learning progress")
    reference = value.get("reference")
    if isinstance(reference, dict) and len(reference.get("lines", [])) > MAX_ITEMS:
        raise HTTPException(413, "Transcript is too large for learning progress")
    published = value.pop("sections", [])
    valid_sections = []
    if isinstance(published, list):
        for index, item in enumerate(published):
            try:
                if not isinstance(item, dict) or any(
                    isinstance(item.get(key), bool)
                    or not isinstance(item.get(key), (int, float))
                    for key in ("start_s", "end_s")
                ):
                    continue
                section = TranscriptSection(**item)
            except (TypeError, ValueError):
                continue
            if valid_sections and section.start_s < valid_sections[-1][1].end_s:
                continue
            valid_sections.append((index, section))
    transcript = transcript_from_json(json.dumps(value))
    projected = ordered_lyric_lines(transcript)
    lines: list[LearningLine] = [
        {
            "id": _hash([i, line.text]),
            "text": line.text,
            "onset_s": line.onset_s,
            "end_s": line.end_s,
            "onset_source": line.onset_source,
        }
        for i, line in enumerate(projected)
    ]
    sections: list[LearningSection] = [
        {
            "id": _hash([i, section.label, section.start_s, section.end_s]),
            "label": section.label,
            "start_s": section.start_s,
            "end_s": section.end_s,
        }
        for i, section in valid_sections
    ]
    if (
        len(json.dumps([lines, sections], ensure_ascii=False).encode())
        > MAX_DOCUMENT_BYTES
    ):
        raise HTTPException(413, "Lyric document is too large for learning progress")
    return _hash([line.text for line in projected]), lines, sections


def _eligible(lines, section):
    if section is None:
        return lines
    return [
        line
        for line in lines
        if line["onset_s"] is not None
        and section["start_s"] <= line["onset_s"] < section["end_s"]
    ]


def _in_section(line: LearningLine, section: LearningSection | None) -> bool:
    return (
        section is None
        or line["onset_s"] is None
        or (section["start_s"] <= line["onset_s"] < section["end_s"])
    )


def _advance(
    state: ProgressState, lines: list[LearningLine], avoid: str | None = None
) -> str | None:
    if not lines:
        return None
    cursor = state.get("cursor", 0) % len(lines)
    round_number = state.get("round", 0) % 5
    while True:
        line = lines[cursor]
        weight = max(1, min(5, state["difficulties"].get(line["id"], 1)))
        cursor += 1
        if cursor == len(lines):
            cursor = 0
            round_number = (round_number + 1) % 5
            line_round = (round_number - 1) % 5
        else:
            line_round = round_number
        if weight > line_round and (len(lines) == 1 or line["id"] != avoid):
            state["cursor"] = cursor
            state["round"] = round_number
            return line["id"]


def _served(
    state: ProgressState, lines: list[LearningLine], line_id: str | None
) -> None:
    for index, line in enumerate(lines):
        if line["id"] == line_id:
            state["cursor"] = (index + 1) % len(lines)
            if state["cursor"] == 0:
                state["round"] = (state.get("round", 0) + 1) % 5
            return


def _operate(job_id, principal, action, body):
    # The descriptor stays open until the transaction has committed.
    with db._session() as conn:
        initial = conn.execute(
            "SELECT session_id,status,internal,"
            "length(CAST(transcript_json AS BLOB)) AS transcript_size "
            "FROM jobs WHERE id=?",
            (job_id,),
        ).fetchone()
        if (
            initial is None
            or initial["session_id"] != principal
            or initial["internal"]
            or initial["status"] != "done"
            or initial["transcript_size"] is None
        ):
            raise HTTPException(404, "Learning progress not found")
        if initial["transcript_size"] > MAX_TRANSCRIPT_BYTES:
            raise HTTPException(413, "Transcript is too large for learning progress")
    with open_source(job_id) as source, db._session() as conn:
        conn.execute("BEGIN" if action == "get" else "BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT session_id,status,internal,"
            "length(CAST(transcript_json AS BLOB)) AS transcript_size "
            "FROM jobs WHERE id=?",
            (job_id,),
        ).fetchone()
        if (
            row is None
            or row["session_id"] != principal
            or row["internal"]
            or row["status"] != "done"
            or row["transcript_size"] is None
        ):
            raise HTTPException(404, "Learning progress not found")
        if row["transcript_size"] > MAX_TRANSCRIPT_BYTES:
            raise HTTPException(413, "Transcript is too large for learning progress")
        raw = conn.execute(
            "SELECT transcript_json FROM jobs WHERE id=?", (job_id,)
        ).fetchone()[0]
        version, lines, sections = _document(raw)
        if body is not None and body.document_version != version:
            raise HTTPException(409, "Lyrics changed; reload learning progress")
        available = source is not None and source.valid()
        if action != "get" and not available:
            raise HTTPException(
                409, "Original audio is unavailable; progress cannot be saved"
            )
        saved = None
        if available:
            saved = conn.execute(
                "SELECT CASE WHEN length(CAST(state_json AS BLOB)) <= ? "
                "THEN state_json END AS state_json FROM learning_progress "
                "WHERE principal_id=? AND source_digest=? AND document_version=?",
                (MAX_STATE_BYTES, principal, source.digest, version),
            ).fetchone()
        if saved is not None and saved["state_json"] is None:
            raise HTTPException(413, "Saved learning progress is too large")
        state: ProgressState = (
            json.loads(saved["state_json"])
            if saved
            else {
                "hint_level": "full",
                "section_id": None,
                "line_id": None,
                "difficulties": {},
                "cursor": 0,
                "round": 0,
            }
        )
        ids = {line["id"] for line in lines}
        by_line = {line["id"]: line for line in lines}
        by_section = {section["id"]: section for section in sections}
        if state.get("section_id") not in by_section:
            state["section_id"] = None
        line_id = state["line_id"]
        if (
            line_id is None
            or line_id not in ids
            or not _in_section(by_line[line_id], by_section.get(state["section_id"]))
        ):
            state["line_id"] = None
        state["difficulties"] = {
            k: v for k, v in state.get("difficulties", {}).items() if k in ids
        }
        if action == "patch":
            fields = body.model_fields_set
            if "hint_level" in fields:
                if body.hint_level is None:
                    raise HTTPException(422, "Hint level cannot be null")
                state["hint_level"] = body.hint_level
            if "section_id" in fields:
                if body.section_id is not None and body.section_id not in by_section:
                    raise HTTPException(422, "Unknown section")
                if body.section_id != state["section_id"]:
                    state["line_id"] = None
                    state["cursor"] = 0
                    state["round"] = 0
                state["section_id"] = body.section_id
            if "line_id" in fields:
                if body.line_id is not None and body.line_id not in ids:
                    raise HTTPException(422, "Unknown line")
                if body.line_id is not None and not _in_section(
                    by_line[body.line_id], by_section.get(state["section_id"])
                ):
                    raise HTTPException(422, "Line is outside the selected section")
                state["line_id"] = body.line_id
                _served(
                    state,
                    _eligible(lines, by_section.get(state["section_id"])),
                    body.line_id,
                )
        elif action == "review":
            if body.line_id not in ids:
                raise HTTPException(422, "Unknown line")
            if not _in_section(
                by_line[body.line_id], by_section.get(state["section_id"])
            ):
                raise HTTPException(422, "Line is outside the selected section")
            if saved is None:
                _served(
                    state,
                    _eligible(lines, by_section.get(state["section_id"])),
                    body.line_id,
                )
            difficulty = state["difficulties"].get(body.line_id, 1)
            difficulty = max(
                1,
                min(
                    5,
                    difficulty
                    + {"remembered": -1, "hesitated": 1, "forgot": 2}[body.rating],
                ),
            )
            if difficulty == 1:
                state["difficulties"].pop(body.line_id, None)
            else:
                state["difficulties"][body.line_id] = difficulty
            state["line_id"] = _advance(
                state,
                _eligible(lines, by_section.get(state["section_id"])),
                body.line_id if body.rating == "remembered" else None,
            )
        if (
            action != "review"
            and state["line_id"] is None
            and not (action == "patch" and "line_id" in body.model_fields_set)
        ):
            candidates = _eligible(lines, by_section.get(state["section_id"]))
            state["line_id"] = candidates[0]["id"] if candidates else None
            _served(state, candidates, state["line_id"])
        if available and action != "get":
            encoded = json.dumps(state, separators=(",", ":"))
            if len(encoded.encode()) > MAX_STATE_BYTES:
                raise HTTPException(413, "Learning progress is too large")
            conn.execute(
                "INSERT INTO learning_progress VALUES (?,?,?,?) "
                "ON CONFLICT(principal_id,source_digest,document_version) "
                "DO UPDATE SET state_json=excluded.state_json",
                (principal, source.digest, version, encoded),
            )
        if available and not source.valid():
            if action != "get":
                raise HTTPException(
                    409, "Original audio changed; progress cannot be saved"
                )
            conn.rollback()
            available = False
            state = {
                "hint_level": "full",
                "section_id": None,
                "line_id": lines[0]["id"] if lines else None,
                "difficulties": {},
            }
        result = {
            "document_version": version,
            "lines": lines,
            "sections": sections,
            "saving_available": available,
            "progress": {
                key: state[key]
                for key in ("hint_level", "section_id", "line_id", "difficulties")
            },
        }
        return result


async def _response(job_id, principal, action, body=None):
    result = await _tracked_thread(_operate, job_id, principal, action, body)
    return JSONResponse(result, headers={"Cache-Control": "no-store"})


@router.get("/jobs/{job_id}/learning-progress")
async def get_progress(job_id: int, principal: Annotated[str, Depends(get_session_id)]):
    return await _response(job_id, principal, "get")


@router.patch("/jobs/{job_id}/learning-progress")
async def patch_progress(
    job_id: int, body: Preferences, principal: Annotated[str, Depends(get_session_id)]
):
    return await _response(job_id, principal, "patch", body)


@router.post("/jobs/{job_id}/learning-progress/reviews")
async def review_progress(
    job_id: int, body: Review, principal: Annotated[str, Depends(get_session_id)]
):
    return await _response(job_id, principal, "review", body)
