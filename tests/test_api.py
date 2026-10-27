import json
import shutil
import sqlite3
import subprocess

import pytest
from audio_samples import tone_wav
from fastapi.testclient import TestClient

from backend import config, db


def test_health(client: TestClient) -> None:
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_submit_url_queues_job(client: TestClient) -> None:
    r = client.post("/api/jobs", data={"url": "https://example.com/x"})
    assert r.status_code == 200
    assert r.json() == {"id": 1, "status": "queued", "position": 1}
    options = client.get("/api/jobs/1").json()["options"]
    assert options["extract_vocals"] is False
    assert options["extract_instruments"] is False
    assert options["mix_female_instruments"] is False
    assert options["mix_male_instruments"] is False
    assert options["mix_backing_instruments"] is False
    assert options["mix_lead_instruments"] is False


def test_submit_requires_exactly_one_source(client: TestClient) -> None:
    assert client.post("/api/jobs", data={}).status_code == 400
    both = client.post(
        "/api/jobs",
        data={"url": "https://example.com/x"},
        files={"file": ("a.mp3", b"x", "audio/mpeg")},
    )
    assert both.status_code == 400


def test_current_and_get_by_id(client: TestClient) -> None:
    jid = client.post("/api/jobs", data={"url": "https://example.com/x"}).json()["id"]
    current = client.get("/api/jobs/current").json()
    assert current["id"] == jid
    assert current["status"] == "queued"
    assert client.get(f"/api/jobs/{jid}").json()["id"] == jid


def test_list_newest_first(client: TestClient) -> None:
    client.post("/api/jobs", data={"url": "https://example.com/1"})
    client.post("/api/jobs", data={"url": "https://example.com/2"})
    assert [j["id"] for j in client.get("/api/jobs").json()] == [2, 1]


def test_queue_positions_increment(client: TestClient) -> None:
    first = client.post("/api/jobs", data={"url": "https://example.com/1"}).json()
    second = client.post("/api/jobs", data={"url": "https://example.com/2"}).json()
    assert first["position"] == 1
    assert second["position"] == 2


def test_ownership_isolation(client: TestClient, other_client: TestClient) -> None:
    jid = client.post("/api/jobs", data={"url": "https://example.com/x"}).json()["id"]
    assert other_client.get(f"/api/jobs/{jid}").status_code == 404
    assert other_client.get("/api/jobs/current").json() is None
    assert other_client.get("/api/jobs").json() == []


def test_retry_creates_new_job(client: TestClient) -> None:
    jid = client.post("/api/jobs", data={"url": "https://example.com/x"}).json()["id"]
    retried = client.post(f"/api/jobs/{jid}/retry")
    assert retried.status_code == 200
    assert retried.json()["id"] != jid
    assert len(client.get("/api/jobs").json()) == 2


def test_retry_requires_ownership(client: TestClient, other_client: TestClient) -> None:
    jid = client.post("/api/jobs", data={"url": "https://example.com/x"}).json()["id"]
    assert other_client.post(f"/api/jobs/{jid}/retry").status_code == 404


def test_original_download_for_upload(client: TestClient) -> None:
    jid = client.post(
        "/api/jobs", files={"file": ("My Song.mp3", b"rawaudio", "audio/mpeg")}
    ).json()["id"]
    resp = client.get(f"/api/jobs/{jid}/original")
    assert resp.status_code == 200
    assert resp.content == b"rawaudio"
    assert "original.mp3" in resp.headers["content-disposition"]


@pytest.mark.skipif(
    not (shutil.which("ffmpeg") and shutil.which("keyfinder-cli")),
    reason="native ffmpeg and keyfinder-cli required",
)
@pytest.mark.parametrize("content_type", ["audio/mpeg", "application/octet-stream", ""])
def test_native_mp3_upload_analysis_and_original_ignore_provider_mime(
    client: TestClient, content_type: str
) -> None:
    encoded = subprocess.run(
        [
            "ffmpeg",
            "-nostdin",
            "-v",
            "error",
            "-i",
            "pipe:0",
            "-c:a",
            "libmp3lame",
            "-f",
            "mp3",
            "pipe:1",
        ],
        input=tone_wav((261.6256, 329.6276, 391.9954), duration_s=8, channels=2),
        capture_output=True,
        check=True,
    ).stdout
    files = {"file": ("Native MP3.MP3", encoded, content_type)}
    analysis = client.post("/api/key-analysis", files=files)
    assert analysis.status_code == 200, analysis.text
    assert analysis.json() == {"original_key": "C major"}
    assert client.get("/api/jobs").json() == []

    submitted = client.post("/api/jobs", files=files)
    assert submitted.status_code == 200, submitted.text
    job_id = submitted.json()["id"]
    job = client.get(f"/api/jobs/{job_id}").json()
    assert job["source_type"] == "upload"
    assert job["source_value"] == "Native MP3.MP3"
    original = client.get(f"/api/jobs/{job_id}/original")
    assert original.status_code == 200
    assert original.content == encoded


def test_original_404_when_not_downloaded_yet(client: TestClient) -> None:
    # Workers are disabled, so a URL job has no downloaded original.
    jid = client.post("/api/jobs", data={"url": "https://example.com/x"}).json()["id"]
    assert client.get(f"/api/jobs/{jid}/original").status_code == 404


def test_original_requires_ownership(
    client: TestClient, other_client: TestClient
) -> None:
    jid = client.post(
        "/api/jobs", files={"file": ("s.mp3", b"x", "audio/mpeg")}
    ).json()["id"]
    assert other_client.get(f"/api/jobs/{jid}/original").status_code == 404


def test_status_aggregates_all_sessions(
    client: TestClient, other_client: TestClient
) -> None:
    client.post("/api/jobs", data={"url": "https://example.com/1"})
    other_client.post("/api/jobs", data={"url": "https://example.com/2"})

    # No cookie needed — status is unauthenticated and spans every session.
    body = TestClient(client.app).get("/api/status").json()
    assert body["total_jobs"] == 2
    assert body["counts"]["queued"] == 2
    assert len(body["recent"]) == 2
    assert body["queue_concurrency"] == 0  # workers disabled in tests
    assert set(body["disk"]) == {
        "total_bytes",
        "used_bytes",
        "free_bytes",
        "results_bytes",
        "db_bytes",
    }


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("pitch_semitones", "nan"),
        ("pitch_semitones", "inf"),
        ("tempo_percent", "nan"),
        ("tempo_percent", "inf"),
        ("tempo_percent", "0"),
        ("tempo_percent", "-10"),
    ],
)
def test_invalid_audio_settings_do_not_queue_jobs(
    client: TestClient, field: str, value: str
) -> None:
    response = client.post(
        "/api/jobs", data={"url": "https://example.com/song", field: value}
    )
    assert response.status_code == 422
    assert client.get("/api/jobs").json() == []


def test_old_jobs_survive_key_metadata_migration(client: TestClient) -> None:
    job_id = client.post(
        "/api/jobs", files={"file": ("old.mp3", b"original", "audio/mpeg")}
    ).json()["id"]
    with sqlite3.connect(config.DB_PATH) as conn:
        conn.execute("ALTER TABLE jobs DROP COLUMN original_key")
        conn.execute(
            "UPDATE jobs SET status = 'done', options_json = '{}', "
            "result_manifest_json = ? WHERE id = ?",
            (
                json.dumps(
                    [
                        {
                            "label": "vocals",
                            "filename": "vocals.mp3",
                            "size_bytes": 3,
                            "duration_s": 1.0,
                        }
                    ]
                ),
                job_id,
            ),
        )
    directory = config.RESULTS_DIR / str(job_id)
    directory.mkdir(parents=True)
    (directory / "vocals.mp3").write_bytes(b"old")

    db.init_db()
    job = client.get(f"/api/jobs/{job_id}").json()
    assert job["original_key"] is None
    assert job["output_key"] is None
    assert job["manifest"][0]["download_name"] == "old - vocals.mp3"
    assert client.get(f"/api/jobs/{job_id}/results/vocals").content.endswith(b"old")
    assert job["options"]["extract_vocals"] is True
    assert job["options"]["extract_instruments"] is True
    assert job["options"]["mix_lead_instruments"] is False
    retried_id = client.post(f"/api/jobs/{job_id}/retry").json()["id"]
    retried = client.get(f"/api/jobs/{retried_id}").json()
    assert retried["options"]["extract_vocals"] is True
    assert retried["options"]["extract_instruments"] is True
    assert retried["options"]["mix_lead_instruments"] is False


def test_explicit_outputs_survive_submission_and_retry(client: TestClient) -> None:
    selected = {
        "extract_vocals": True,
        "extract_instruments": False,
        "mix_female_instruments": True,
        "mix_male_instruments": True,
        "mix_backing_instruments": True,
        "mix_lead_instruments": True,
    }
    job_id = client.post(
        "/api/jobs",
        data={
            "url": "https://example.com/song",
            **{name: str(value).lower() for name, value in selected.items()},
        },
    ).json()["id"]
    db.init_db()
    options = client.get(f"/api/jobs/{job_id}").json()["options"]
    assert {name: options[name] for name in selected} == selected
    retry_id = client.post(f"/api/jobs/{job_id}/retry").json()["id"]
    assert client.get(f"/api/jobs/{retry_id}").json()["options"] == options


def test_historical_explicit_mix_options_do_not_enable_lead_on_retry(
    client: TestClient,
) -> None:
    job_id = client.post(
        "/api/jobs",
        data={"url": "https://example.com/song"},
    ).json()["id"]
    historical_options = {
        "extract_vocals": False,
        "extract_instruments": False,
        "mix_backing_instruments": True,
    }
    with sqlite3.connect(config.DB_PATH) as conn:
        conn.execute(
            "UPDATE jobs SET options_json = ? WHERE id = ?",
            (json.dumps(historical_options), job_id),
        )
    db.init_db()
    stored = db.get_job(job_id)
    assert stored is not None
    assert stored.options.mix_lead_instruments is False
    assert stored.options.output_labels == ["backing-instruments"]
    options = client.get(f"/api/jobs/{job_id}").json()["options"]
    assert options["mix_backing_instruments"] is True
    assert options["mix_lead_instruments"] is False
    retry_id = client.post(f"/api/jobs/{job_id}/retry").json()["id"]
    assert client.get(f"/api/jobs/{retry_id}").json()["options"] == options
