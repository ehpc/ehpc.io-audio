from fastapi.testclient import TestClient


def test_health(client: TestClient) -> None:
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_submit_url_queues_job(client: TestClient) -> None:
    r = client.post("/api/jobs", data={"url": "https://example.com/x"})
    assert r.status_code == 200
    assert r.json() == {"id": 1, "status": "queued", "position": 1}


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
