"""End-to-end regressions for the private guided-recall document and state."""

import asyncio
import json
import threading
from concurrent.futures import ThreadPoolExecutor
from contextlib import nullcontext
from dataclasses import replace
from pathlib import Path
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient

from backend import config, db, drain, source_identity
from backend.main import JobAccess
from backend.routes import learning_progress, results
from separator.lyrics import (
    CanonicalWordPosition,
    Transcript,
    TranscriptSection,
    TranscriptSegment,
    TranscriptWord,
    UntimedRecognition,
    ordered_lyric_lines,
)
from separator.lyrics_reference import ReferenceLine, ReferenceReview
from separator.options import SeparationOptions

SOURCE = b"same synthetic audio bytes"


def transcript(
    offset: float = 0, *, changed: bool = False, sections: bool = True
) -> Transcript:
    return Transcript(
        segments=[
            TranscriptSegment(1 + offset, 2 + offset, "Again"),
            TranscriptSegment(
                3 + offset, 4 + offset, "Different" if changed else "Again"
            ),
            TranscriptSegment(8 + offset, 9 + offset, "Last line"),
        ],
        untimed=[UntimedRecognition("Unplaced line", "no alignment")],
        sections=[TranscriptSection(0, 6, "verse"), TranscriptSection(6, 20, "chorus")]
        if sections
        else [],
    )


def job(
    client: TestClient, *, source: bytes = SOURCE, document: Transcript | None = None
) -> int:
    owner = client.get("/api/auth/me").json()["id"]
    submitted = db.insert_job(owner, "upload", "song.wav", SeparationOptions())
    assert submitted.work_id is not None
    jid = submitted.work_id
    directory = config.UPLOADS_DIR / str(jid)
    directory.mkdir(parents=True)
    (directory / "song.wav").write_bytes(source)
    db.mark_done(jid, [], document if document is not None else transcript())
    return jid


def url(jid: int) -> str:
    return f"/api/jobs/{jid}/learning-progress"


def get(client: TestClient, jid: int) -> dict:
    response = client.get(url(jid))
    assert response.status_code == 200, response.text
    assert "no-store" in response.headers.get("cache-control", "")
    return response.json()


def patch(client: TestClient, jid: int, document: dict, **changes) -> dict:
    response = client.patch(
        url(jid), json={"document_version": document["document_version"], **changes}
    )
    assert response.status_code == 200, response.text
    return response.json()


def review(
    client: TestClient, jid: int, document: dict, line: str, rating: str = "forgot"
) -> dict:
    response = client.post(
        url(jid) + "/reviews",
        json={
            "document_version": document["document_version"],
            "line_id": line,
            "rating": rating,
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_order_repeated_lines_provenance_and_retiming_preserves_state(client):
    jid = job(client)
    before = get(client, jid)
    assert before["saving_available"] is True
    lines = before["lines"]
    assert [line["text"] for line in lines] == [
        "Again",
        "Again",
        "Last line",
        "Unplaced line",
    ]
    assert len({line["id"] for line in lines}) == 4
    assert [
        (line["onset_s"], line["end_s"], line["onset_source"]) for line in lines
    ] == [
        (1, 2, "acoustic"),
        (3, 4, "acoustic"),
        (8, 9, "acoustic"),
        (None, None, "unknown"),
    ]
    saved = patch(client, jid, before, hint_level="hidden", line_id=lines[1]["id"])
    saved = review(client, jid, saved, lines[1]["id"])
    assert lines[1]["id"] in saved["progress"]["difficulties"]
    db.mark_done(jid, [], transcript(offset=0.25))
    after = get(client, jid)
    assert after["document_version"] == before["document_version"]
    assert [line["id"] for line in after["lines"]] == [line["id"] for line in lines]
    assert after["lines"][0]["onset_s"] == 1.25
    assert after["progress"] == saved["progress"]


def test_same_source_is_private_and_survives_job_deletion_and_reupload(
    client, other_client
):
    first = job(client)
    second = job(client)
    foreign = job(other_client)
    initial = get(client, first)
    line = initial["lines"][0]["id"]
    saved = patch(client, first, initial, hint_level="first", line_id=line)
    saved = review(client, first, saved, line)
    assert get(client, second)["progress"] == saved["progress"]
    assert get(other_client, foreign)["progress"] != saved["progress"]
    assert other_client.get(url(first)).status_code == 404
    assert (
        other_client.patch(
            url(first),
            json={
                "document_version": initial["document_version"],
                "hint_level": "full",
            },
        ).status_code
        == 404
    )
    assert (
        other_client.post(
            url(first) + "/reviews",
            json={
                "document_version": initial["document_version"],
                "line_id": line,
                "rating": "forgot",
            },
        ).status_code
        == 404
    )
    song_id = client.get(f"/api/jobs/{first}").json()["song_id"]
    assert client.delete(f"/api/songs/{song_id}").status_code == 204
    assert client.get(url(first)).status_code == 404
    assert get(client, job(client))["progress"] == saved["progress"]


def test_stale_document_and_removed_selection_are_revalidated(client):
    jid = job(client)
    original = get(client, jid)
    selected = patch(
        client,
        jid,
        original,
        section_id=original["sections"][0]["id"],
        line_id=original["lines"][0]["id"],
    )
    assert selected["progress"]["section_id"] == original["sections"][0]["id"]
    db.mark_done(jid, [], transcript(sections=False))
    no_sections = get(client, jid)
    assert no_sections["document_version"] == original["document_version"]
    assert no_sections["progress"]["section_id"] is None
    db.mark_done(jid, [], transcript(changed=True, sections=False))
    current = get(client, jid)
    assert current["document_version"] != original["document_version"]
    stale = {"document_version": original["document_version"]}
    assert (
        client.patch(url(jid), json={**stale, "hint_level": "hidden"}).status_code
        == 409
    )
    assert (
        client.post(
            url(jid) + "/reviews",
            json={**stale, "line_id": original["lines"][0]["id"], "rating": "forgot"},
        ).status_code
        == 409
    )
    assert get(client, jid)["progress"] == current["progress"]


@pytest.mark.parametrize("problem", ["missing", "symlink"])
def test_unsafe_sources_allow_reading_but_never_saving(
    client, tmp_path: Path, problem: str
):
    jid = job(client)
    original = get(client, jid)
    source = config.UPLOADS_DIR / str(jid) / "song.wav"
    source.unlink()
    if problem == "symlink":
        target = tmp_path / "outside.wav"
        target.write_bytes(SOURCE)
        source.symlink_to(target)
    unavailable = get(client, jid)
    assert unavailable["lines"] == original["lines"]
    assert unavailable["saving_available"] is False
    version = unavailable["document_version"]
    assert (
        client.patch(
            url(jid), json={"document_version": version, "hint_level": "hidden"}
        ).status_code
        == 409
    )
    assert (
        client.post(
            url(jid) + "/reviews",
            json={
                "document_version": version,
                "line_id": unavailable["lines"][0]["id"],
                "rating": "forgot",
            },
        ).status_code
        == 409
    )


def test_changed_source_does_not_reuse_prior_progress(client):
    jid = job(client)
    first = get(client, jid)
    saved = patch(client, jid, first, hint_level="hidden")
    (config.UPLOADS_DIR / str(jid) / "song.wav").write_bytes(b"different source bytes")
    changed = get(client, jid)
    assert changed["saving_available"] is True
    assert changed["document_version"] == first["document_version"]
    assert changed["progress"] != saved["progress"]
    (config.UPLOADS_DIR / str(jid) / "song.wav").write_bytes(SOURCE)
    assert get(client, jid)["progress"] == saved["progress"]


def test_concurrent_reviews_merge_without_lost_difficulties(client):
    jid = job(client)
    initial = get(client, jid)
    lines = [line["id"] for line in initial["lines"][:2]]

    def rate(line):
        return client.post(
            url(jid) + "/reviews",
            json={
                "document_version": initial["document_version"],
                "line_id": line,
                "rating": "forgot",
            },
        )

    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(rate, lines))
    assert all(response.status_code == 200 for response in responses), [
        r.text for r in responses
    ]
    final = get(client, jid)
    assert all(line in final["progress"]["difficulties"] for line in lines)
    assert final["progress"]["line_id"] in {line["id"] for line in initial["lines"]}


def test_additive_migration_preserves_jobs_and_auth_and_retains_progress(client):
    jid = job(client)
    owner = client.get("/api/auth/me").json()["id"]
    with db._session() as conn:
        conn.execute("DROP TABLE learning_progress")
    db.init_db()
    assert client.get("/api/auth/me").json()["id"] == owner
    assert client.get(f"/api/jobs/{jid}").status_code == 200
    document = get(client, jid)
    saved = patch(client, jid, document, hint_level="partial")
    db.init_db()
    assert get(client, jid)["progress"] == saved["progress"]
    song_id = client.get(f"/api/jobs/{jid}").json()["song_id"]
    assert client.delete(f"/api/songs/{song_id}").status_code == 204
    assert get(client, job(client))["progress"] == saved["progress"]


def test_noncompleted_and_missing_transcripts_are_not_documents(client):
    jid = job(client)
    with db._session() as conn:
        conn.execute("UPDATE jobs SET status='queued' WHERE id=?", (jid,))
    assert client.get(url(jid)).status_code == 404
    db.mark_done(jid, [], None)
    assert client.get(url(jid)).status_code == 404


def test_scheduler_rotates_within_section_and_manual_unknown_selection(client):
    jid = job(client)
    document = get(client, jid)
    verse = document["sections"][0]["id"]
    first, second, outside, unknown = [line["id"] for line in document["lines"]]
    state = patch(client, jid, document, section_id=verse, line_id=first)
    seen = set()
    for _ in range(16):
        state = review(client, jid, state, state["progress"]["line_id"], "remembered")
        selected = state["progress"]["line_id"]
        assert selected in {first, second}
        seen.add(selected)
    assert seen == {first, second}
    state = patch(client, jid, state, line_id=unknown)
    assert state["progress"]["line_id"] == unknown
    assert outside not in seen


def test_invalid_inputs_cannot_change_saved_state(client):
    jid = job(client)
    document = get(client, jid)
    saved = patch(client, jid, document, hint_level="partial")
    version = document["document_version"]
    for changes in (
        {"line_id": "not-a-line"},
        {"section_id": "not-a-section"},
        {"hint_level": "invalid"},
    ):
        response = client.patch(url(jid), json={"document_version": version, **changes})
        assert 400 <= response.status_code < 500
    for line, rating in (
        ("not-a-line", "forgot"),
        (document["lines"][0]["id"], "invalid"),
    ):
        response = client.post(
            url(jid) + "/reviews",
            json={
                "document_version": version,
                "line_id": line,
                "rating": rating,
            },
        )
        assert 400 <= response.status_code < 500
    assert get(client, jid)["progress"] == saved["progress"]


def test_malformed_published_section_bounds_are_filtered(client):
    jid = job(client)
    with db._session() as conn:
        raw = conn.execute(
            "SELECT transcript_json FROM jobs WHERE id=?", (jid,)
        ).fetchone()[0]
        document = json.loads(raw)
        document["sections"] = [
            {"label": "verse", "start_s": 0, "end_s": 6},
            {"label": "chorus", "start_s": -1, "end_s": 3},
            {"label": "bridge", "start_s": 8, "end_s": 7},
            {"label": "outro", "start_s": 10, "end_s": 10},
            {"label": "intro", "start_s": float("nan"), "end_s": 3},
            {"label": "verse", "start_s": 4, "end_s": float("inf")},
            {"label": "chorus", "start_s": 6, "end_s": 20},
        ]
        conn.execute(
            "UPDATE jobs SET transcript_json=? WHERE id=?", (json.dumps(document), jid)
        )
    result = get(client, jid)
    assert [section["label"] for section in result["sections"]] == ["verse", "chorus"]
    assert [
        (section["start_s"], section["end_s"]) for section in result["sections"]
    ] == [(0, 6), (6, 20)]
    assert [line["text"] for line in result["lines"]] == [
        "Again",
        "Again",
        "Last line",
        "Unplaced line",
    ]


def test_section_restricts_timed_lines_but_allows_manual_untimed_lines(client):
    jid = job(client)
    document = get(client, jid)
    verse = document["sections"][0]["id"]
    inside, _, outside, unknown = [line["id"] for line in document["lines"]]
    selected = patch(client, jid, document, section_id=verse, line_id=inside)
    version = document["document_version"]
    response = client.patch(
        url(jid), json={"document_version": version, "line_id": outside}
    )
    assert 400 <= response.status_code < 500
    response = client.post(
        url(jid) + "/reviews",
        json={
            "document_version": version,
            "line_id": outside,
            "rating": "forgot",
        },
    )
    assert 400 <= response.status_code < 500
    assert get(client, jid)["progress"] == selected["progress"]
    manual = patch(client, jid, selected, line_id=unknown)
    assert manual["progress"]["line_id"] == unknown
    reviewed = review(client, jid, manual, unknown)
    assert unknown in reviewed["progress"]["difficulties"]
    assert reviewed["progress"]["line_id"] in {
        line["id"] for line in document["lines"][:2]
    }


def test_get_revalidates_retimed_selection_without_writing_state(client):
    jid = job(client)
    document = get(client, jid)
    selected = patch(
        client,
        jid,
        document,
        section_id=document["sections"][0]["id"],
        line_id=document["lines"][0]["id"],
        hint_level="hidden",
    )
    with db._session() as conn:
        before = conn.execute("SELECT state_json FROM learning_progress").fetchone()[0]
    db.mark_done(jid, [], transcript(offset=6))
    updated = get(client, jid)
    assert updated["document_version"] == document["document_version"]
    assert updated["progress"]["section_id"] == selected["progress"]["section_id"]
    assert updated["progress"]["line_id"] != selected["progress"]["line_id"]
    assert updated["progress"]["hint_level"] == "hidden"
    with db._session() as conn:
        after = conn.execute("SELECT state_json FROM learning_progress").fetchone()[0]
    assert after == before


@pytest.mark.parametrize("limit", ["MAX_TRANSCRIPT_BYTES", "MAX_DOCUMENT_BYTES"])
def test_oversize_document_is_rejected_by_api(client, monkeypatch, limit):
    jid = job(client)
    assert get(client, jid)["lines"]
    monkeypatch.setattr(learning_progress, limit, 1)
    response = client.get(url(jid))
    assert response.status_code == 413
    with db._session() as conn:
        assert conn.execute("SELECT COUNT(*) FROM learning_progress").fetchone()[0] == 0


def test_oversize_state_write_is_rejected_atomically(client, monkeypatch):
    jid = job(client)
    document = get(client, jid)
    patch(client, jid, document, hint_level="partial")
    with db._session() as conn:
        before = conn.execute("SELECT state_json FROM learning_progress").fetchone()[0]
    monkeypatch.setattr(learning_progress, "MAX_STATE_BYTES", 1)
    response = client.patch(
        url(jid),
        json={
            "document_version": document["document_version"],
            "hint_level": "hidden",
        },
    )
    assert response.status_code == 413
    with db._session() as conn:
        assert (
            conn.execute("SELECT state_json FROM learning_progress").fetchone()[0]
            == before
        )


def test_cache_hit_rechecks_source_before_results_consumer_binds_digest(
    client, monkeypatch
):
    jid = job(client)
    source_identity.clear_cache()
    with source_identity.open_source(jid) as identity:
        assert identity is not None
    original_valid = source_identity.SourceIdentity.valid
    source = config.UPLOADS_DIR / str(jid) / "song.wav"
    calls = 0

    def mutate_before_final_check(identity):
        nonlocal calls
        calls += 1
        if calls == 2:
            source.write_bytes(b"changed during cached lookup")
        return original_valid(identity)

    recorder = Mock()
    monkeypatch.setattr(
        source_identity.SourceIdentity, "valid", mutate_before_final_check
    )
    monkeypatch.setattr(results, "capture", lambda: nullcontext(recorder))
    stored_job = db.get_job(jid)
    assert stored_job is not None
    assert results._with_source(stored_job, lambda: "consumer ran") == "consumer ran"
    recorder.bind_digest.assert_not_called()


def test_sparse_difficulties_and_weighted_rotation_persist_across_requests(client):
    jid = job(client)
    document = get(client, jid)
    first, second = [line["id"] for line in document["lines"][:2]]
    state = patch(client, jid, document, section_id=document["sections"][0]["id"])
    state = review(client, jid, state, first, "forgot")
    state = review(client, jid, state, first, "forgot")
    assert state["progress"]["difficulties"][first] == 5
    counts = {first: 0, second: 0}
    for _ in range(30):
        selected = state["progress"]["line_id"]
        state = review(
            client,
            jid,
            state,
            selected,
            "forgot" if selected == first else "remembered",
        )
        counts[state["progress"]["line_id"]] += 1
    assert counts[first] > counts[second] > 0
    assert state["progress"]["difficulties"] == {first: 5}
    assert get(client, jid)["progress"] == state["progress"]
    with db._session() as conn:
        stored = json.loads(
            conn.execute("SELECT state_json FROM learning_progress").fetchone()[0]
        )
    assert stored["difficulties"] == {first: 5}


def test_playback_end_unique_final_word_preserves_progress(client):
    original = Transcript(
        reference=ReferenceReview(
            "matched",
            "Validated timing",
            duration_s=12,
            provider_timing_status="validated",
            lines=[
                ReferenceLine("We pretend", provider_start_s=1, provider_end_s=3),
                ReferenceLine("Next line", provider_start_s=3, provider_end_s=5),
            ],
        ),
        words=[
            TranscriptWord(3.1, 3.7, "PRETEND", origin="reference-aligned"),
            TranscriptWord(4, 4.2, "Next", origin="reference-aligned"),
            TranscriptWord(6.5, 7, "extra", origin="asr-extra"),
        ],
        canonical_word_positions=[
            CanonicalWordPosition(0, 0, 1),
            CanonicalWordPosition(1, 1, 0),
        ],
        asr_extras=[TranscriptSegment(6, 7.5, "extra")],
    )
    jid = job(client, document=original)
    before = get(client, jid)
    assert [
        (line["onset_s"], line["end_s"], line["playback_end_s"])
        for line in before["lines"]
    ] == [(1, None, 3.7), (3, None, None), (6, 7.5, 7)]
    saved = patch(
        client, jid, before, hint_level="hidden", line_id=before["lines"][0]["id"]
    )
    saved = review(client, jid, saved, before["lines"][0]["id"])
    retimed = replace(
        original, words=[replace(original.words[0], end_s=3.8), *original.words[1:]]
    )
    db.mark_done(jid, [], retimed)
    after = get(client, jid)
    assert after["lines"][0]["playback_end_s"] == 3.8
    assert after["document_version"] == before["document_version"]
    assert [line["id"] for line in after["lines"]] == [
        line["id"] for line in before["lines"]
    ]
    assert after["progress"] == saved["progress"]

    ambiguous = replace(
        retimed,
        canonical_word_positions=[
            *retimed.canonical_word_positions,
            CanonicalWordPosition(0, 0, 1),
        ],
    )
    db.mark_done(jid, [], ambiguous)
    assert get(client, jid)["lines"][0]["playback_end_s"] is None

    wrong_text = replace(
        retimed, words=[replace(retimed.words[0], text="wrong"), *retimed.words[1:]]
    )
    db.mark_done(jid, [], wrong_text)
    assert get(client, jid)["lines"][0]["playback_end_s"] is None


def test_playback_end_requires_a_timed_line_and_a_final_word_after_its_onset(client):
    document = Transcript(
        reference=ReferenceReview(
            "matched",
            "Validated timing",
            duration_s=8,
            provider_timing_status="validated",
            lines=[ReferenceLine("Early word", provider_start_s=2, provider_end_s=4)],
        ),
        words=[TranscriptWord(1, 1.5, "word")],
        canonical_word_positions=[CanonicalWordPosition(0, 0, 1)],
    )
    assert (
        get(client, job(client, document=document))["lines"][0]["playback_end_s"]
        is None
    )

    independent = Transcript(
        segments=[TranscriptSegment(1, 4, "A real ending")],
        words=[TranscriptWord(2.5, 3.2, "ending")],
    )
    line = get(client, job(client, document=independent))["lines"][0]
    assert line["onset_source"] == "acoustic"
    assert (line["end_s"], line["playback_end_s"]) == (4, 3.2)


def test_provider_and_word_retiming_versions_follow_displayed_projection(client):
    original = Transcript(
        reference=ReferenceReview(
            "matched",
            "Validated timing",
            duration_s=12,
            provider_timing_status="validated",
            lines=[
                ReferenceLine("Canonical line", provider_start_s=1, provider_end_s=3)
            ],
        ),
        asr_extras=[TranscriptSegment(5, 6, "extra phrase")],
        words=[TranscriptWord(5.1, 5.3, "loose", origin="asr-extra")],
    )
    jid = job(client, document=original)
    before = get(client, jid)
    assert (
        [line["text"] for line in before["lines"]]
        == [line.text for line in ordered_lyric_lines(original)]
        == ["Canonical line", "extra phrase"]
    )
    assert before["lines"][0]["onset_source"] == "provider-synced"
    saved = patch(
        client, jid, before, hint_level="hidden", line_id=before["lines"][1]["id"]
    )

    reference = original.reference
    assert reference is not None
    cue = replace(reference.lines[0], provider_start_s=2, provider_end_s=4)
    retimed = replace(
        original,
        reference=replace(reference, lines=[cue]),
        words=[TranscriptWord(5.4, 5.6, "loose", origin="asr-extra")],
    )
    db.mark_done(jid, [], retimed)
    unchanged = get(client, jid)
    assert (
        [line["text"] for line in unchanged["lines"]]
        == [line.text for line in ordered_lyric_lines(retimed)]
        == ["Canonical line", "extra phrase"]
    )
    assert unchanged["lines"][0]["onset_s"] == 2
    assert unchanged["document_version"] == before["document_version"]
    assert unchanged["progress"] == saved["progress"]

    moved = replace(
        retimed, words=[TranscriptWord(7, 7.2, "loose", origin="asr-extra")]
    )
    db.mark_done(jid, [], moved)
    changed = get(client, jid)
    assert (
        [line["text"] for line in changed["lines"]]
        == [line.text for line in ordered_lyric_lines(moved)]
        == ["Canonical line", "extra phrase", "loose"]
    )
    assert changed["document_version"] != before["document_version"]
    response = client.patch(
        url(jid),
        json={
            "document_version": before["document_version"],
            "hint_level": "first",
        },
    )
    assert response.status_code == 409
    assert get(client, jid)["progress"] == changed["progress"]


def test_cancelled_learning_request_holds_guard_until_hash_worker_finishes(
    client, monkeypatch
):
    jid = job(client)
    owner = client.get("/api/auth/me").json()["id"]
    source_identity.clear_cache()
    started, finish = threading.Event(), threading.Event()
    original_hash = source_identity.hashlib.file_digest

    def blocked_hash(*args, **kwargs):
        started.set()
        assert finish.wait(5)
        return original_hash(*args, **kwargs)

    monkeypatch.setattr(source_identity.hashlib, "file_digest", blocked_hash)

    async def exercise():
        async def application(scope, receive, send):
            await learning_progress._response(jid, owner, "get")

        middleware = JobAccess(application)
        task = asyncio.create_task(
            middleware(
                {"type": "http", "method": "GET", "path": url(jid)},
                None,
                None,
            )
        )
        try:
            assert await asyncio.to_thread(started.wait, 5)
            task.cancel()
            await asyncio.sleep(0)
            assert not task.done()
            assert any(not worker.done() for worker in drain.state.tracked)
            assert not middleware.begin_delete(jid)
        finally:
            finish.set()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert middleware.begin_delete(jid)
        middleware.end_delete(jid)

    asyncio.run(exercise())


@pytest.mark.parametrize("operation", ["regenerate", "delete"])
def test_learning_write_races_with_regeneration_or_deletion(
    client, monkeypatch, operation
):
    jid = job(client)
    song_id = client.get(f"/api/jobs/{jid}").json()["song_id"]
    original = get(client, jid)
    source_identity.clear_cache()
    started, finish = threading.Event(), threading.Event()
    original_hash = source_identity.hashlib.file_digest
    responses = []

    def blocked_hash(*args, **kwargs):
        started.set()
        assert finish.wait(5)
        return original_hash(*args, **kwargs)

    def write_progress():
        responses.append(
            client.patch(
                url(jid),
                json={
                    "document_version": original["document_version"],
                    "hint_level": "hidden",
                },
            )
        )

    monkeypatch.setattr(source_identity.hashlib, "file_digest", blocked_hash)
    worker = threading.Thread(target=write_progress)
    worker.start()
    try:
        assert started.wait(5)
        if operation == "regenerate":
            db.mark_done(jid, [], transcript(changed=True))
        else:
            assert client.delete(f"/api/songs/{song_id}").status_code == 409
    finally:
        finish.set()
        worker.join(timeout=5)
    assert not worker.is_alive()
    assert len(responses) == 1
    if operation == "regenerate":
        assert responses[0].status_code == 409
        assert get(client, jid)["progress"]["hint_level"] != "hidden"
        with db._session() as conn:
            assert (
                conn.execute("SELECT COUNT(*) FROM learning_progress").fetchone()[0]
                == 0
            )
    else:
        assert responses[0].status_code == 200
        assert client.delete(f"/api/songs/{song_id}").status_code == 204
        assert client.get(url(jid)).status_code == 404


def test_initial_practice_and_manual_selection_advance_to_another_line(client):
    jid = job(client)
    initial = get(client, jid)
    first, second = [line["id"] for line in initial["lines"][:2]]
    assert initial["progress"]["line_id"] == first
    advanced = review(client, jid, initial, first, "remembered")
    assert advanced["progress"]["line_id"] != first

    practiced = patch(
        client,
        jid,
        advanced,
        section_id=initial["sections"][0]["id"],
        line_id=first,
        hint_level="hidden",
    )
    assert practiced["progress"]["line_id"] == first
    advanced = review(client, jid, practiced, first, "remembered")
    assert advanced["progress"]["line_id"] == second

    manual = patch(client, jid, advanced, line_id=second)
    advanced = review(client, jid, manual, second, "remembered")
    assert advanced["progress"]["line_id"] == first


def test_unavailable_source_does_not_swallow_consumer_io_error(client):
    jid = job(client)
    (config.UPLOADS_DIR / str(jid) / "song.wav").unlink()

    def fail():
        raise OSError("consumer I/O failed")

    stored_job = db.get_job(jid)
    assert stored_job is not None
    with pytest.raises(OSError, match="consumer I/O failed"):
        results._with_source(stored_job, fail)
