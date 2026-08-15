import subprocess
from pathlib import Path

import pytest

from separator import download
from separator.download import _download_error, download_mp3

FORBIDDEN = "ERROR: unable to download video data: HTTP Error 403: Forbidden\n"
NOT_FOUND = (
    "ERROR: [generic] x: Unable to download webpage: HTTP Error 404: Not Found\n"
)


def test_download_error_extracts_ytdlp_message() -> None:
    stderr = (
        "[youtube] Extracting URL: https://...\n"
        "ERROR: [youtube] abc: HTTP Error 403: Forbidden\n"
    )
    assert (
        _download_error(stderr)
        == "Download failed: [youtube] abc: HTTP Error 403: Forbidden"
    )


def test_download_error_uses_last_error_line() -> None:
    stderr = "ERROR: first\nsome noise\nERROR: last one\n"
    assert _download_error(stderr) == "Download failed: last one"


def test_download_error_falls_back_when_no_error_line() -> None:
    assert (
        _download_error("just some progress output\n")
        == "Download failed: download failed"
    )


def _fake_runner(fail_times: int, stderr: str) -> tuple[object, dict]:
    state = {"calls": 0}

    def fake_run(
        cmd: list[str], capture_output: bool, text: bool
    ) -> subprocess.CompletedProcess:
        state["calls"] += 1
        dest = Path(cmd[cmd.index("-o") + 1]).parent
        if state["calls"] <= fail_times:
            return subprocess.CompletedProcess(cmd, 1, "", stderr)
        (dest / "song.mp3").write_bytes(b"audio")
        return subprocess.CompletedProcess(cmd, 0, "", "")

    return fake_run, state


def test_retries_transient_403_then_succeeds(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    fake_run, state = _fake_runner(fail_times=1, stderr=FORBIDDEN)
    monkeypatch.setattr(download.subprocess, "run", fake_run)

    data, name = download_mp3("https://x", str(tmp_path), max_attempts=3, backoff_s=0)
    assert data == b"audio" and name == "song.mp3"
    assert state["calls"] == 2  # failed once, retried, succeeded


def test_does_not_retry_permanent_404(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    fake_run, state = _fake_runner(fail_times=99, stderr=NOT_FOUND)
    monkeypatch.setattr(download.subprocess, "run", fake_run)

    with pytest.raises(RuntimeError, match="404"):
        download_mp3("https://x", str(tmp_path), max_attempts=3, backoff_s=0)
    assert state["calls"] == 1  # permanent error -> no retry


def test_caps_retries_for_persistent_403(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    fake_run, state = _fake_runner(fail_times=99, stderr=FORBIDDEN)
    monkeypatch.setattr(download.subprocess, "run", fake_run)

    with pytest.raises(RuntimeError, match="403"):
        download_mp3("https://x", str(tmp_path), max_attempts=3, backoff_s=0)
    assert state["calls"] == 3  # capped at max_attempts, no infinite loop
