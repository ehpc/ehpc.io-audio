import os
import time
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from modal.exception import TimeoutError as ModalTimeoutError

from backend import modal_client
from separator.inference import InferenceRequest


@pytest.mark.parametrize("timeout", [0, -1, float("inf"), float("nan")])
def test_upload_deadline_must_be_positive_and_finite(
    monkeypatch: pytest.MonkeyPatch, timeout: float
) -> None:
    monkeypatch.setattr(
        modal_client,
        "_run_staging_upload",
        lambda *args: pytest.fail("invalid deadline started an upload"),
    )
    request = InferenceRequest("separation", b"audio", "a.wav", "a" * 64)
    with pytest.raises(ValueError, match="deadline"):
        modal_client.stage_input(request, "a" * 32, timeout=timeout)


@pytest.mark.parametrize("phase", ["enter", "commit"])
def test_stalled_upload_process_is_reaped_before_temporary_input_cleanup(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, phase: str
) -> None:
    marker = tmp_path / "child-state"
    startup = tmp_path / "sitecustomize.py"
    startup.write_text(
        """
import os,sys,time
from pathlib import Path
from backend import modal_client
class Batch:
 def __enter__(self):
  if os.environ['STAGE_TEST_PHASE']=='enter': self.stall()
  return self
 def put_file(self, source, remote): self.source=str(source)
 def __exit__(self, *args):
  if os.environ['STAGE_TEST_PHASE']=='commit': self.stall()
 def stall(self):
  Path(os.environ['STAGE_TEST_MARKER']).write_text(str(os.getpid())+'\\n'+sys.argv[1])
  while True: time.sleep(1)
class Volume:
 def batch_upload(self, force=False): return Batch()
modal_client._get_transport_volume=lambda: Volume()
"""
    )
    monkeypatch.setenv("PYTHONPATH", str(tmp_path) + os.pathsep + str(Path.cwd()))
    monkeypatch.setenv("STAGE_TEST_PHASE", phase)
    monkeypatch.setenv("STAGE_TEST_MARKER", str(marker))
    monkeypatch.setattr(modal_client.config, "DATA_DIR", tmp_path / "data")
    request = InferenceRequest("separation", b"audio", "a.wav", "a" * 64)
    started = time.monotonic()
    with pytest.raises(TimeoutError, match="before dispatch"):
        modal_client.stage_input(request, "a" * 32, timeout=3)
    assert time.monotonic() - started < 10
    pid, root = marker.read_text().splitlines()
    with pytest.raises(ProcessLookupError):
        os.kill(int(pid), 0)
    assert not Path(root).exists()


def test_upload_failure_retains_private_diagnostics_without_public_details(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (tmp_path / "sitecustomize.py").write_text(
        """
from backend import modal_client
class Batch:
 def __enter__(self): raise RuntimeError('private-provider-detail')
 def __exit__(self, *args): pass
class Volume:
 def batch_upload(self, force=False): return Batch()
modal_client._get_transport_volume=lambda: Volume()
"""
    )
    monkeypatch.setenv("PYTHONPATH", str(tmp_path) + os.pathsep + str(Path.cwd()))
    monkeypatch.setattr(modal_client.config, "DATA_DIR", tmp_path / "data")
    request = InferenceRequest("separation", b"audio", "a.wav", "a" * 64)
    with pytest.raises(RuntimeError, match="before dispatch") as error:
        modal_client.stage_input(request, "b" * 32, timeout=10)
    assert "private-provider-detail" not in str(error.value)
    logs = list(
        (tmp_path / "data" / "artifacts" / "inference-diagnostics").glob("upload-*.log")
    )
    assert len(logs) == 1
    assert "private-provider-detail" in logs[0].read_text()
    assert logs[0].stat().st_mode & 0o777 == 0o600


def test_poll_returns_none_on_builtin_timeout() -> None:
    # Regression: Modal 1.4's call.get() raises the builtin TimeoutError on a poll
    # timeout. Catching only modal.exception.TimeoutError let it escape and marked
    # every job failed after the first 5s poll.
    call = MagicMock()
    call.get.side_effect = TimeoutError()
    assert modal_client.poll(call, 5) is None


def test_poll_returns_none_on_modal_timeout() -> None:
    call = MagicMock()
    call.get.side_effect = ModalTimeoutError()
    assert modal_client.poll(call, 5) is None


def test_poll_propagates_real_errors() -> None:
    call = MagicMock()
    call.get.side_effect = RuntimeError("boom")
    with pytest.raises(RuntimeError):
        modal_client.poll(call, 5)
