import os
import subprocess
import sys

import pytest

from separator import modal_app

_REJECTED_DEPLOYMENT_PROBE = """
import socket
import modal

def forbidden(*args, **kwargs):
    raise AssertionError("Deployment validation must not allocate remote resources")

socket.socket.connect = forbidden
socket.create_connection = forbidden
modal.App = forbidden
modal.Volume.from_name = forbidden

try:
    from separator import modal_app
except ValueError:
    pass
else:
    raise AssertionError("Unsafe deployment settings were not rejected")
"""


def assert_deployment_rejected(
    gpu: str | None,
    target: str | None,
    browser_target: str | None,
    *,
    idle_seconds: str | None = None,
) -> None:
    environment = os.environ.copy()
    for name, value in (
        ("MODAL_TEST_GPU", gpu),
        ("MODAL_APP_NAME", target),
        ("E2E_MODAL_APP_NAME", browser_target),
        ("MODAL_GPU_IDLE_SECONDS", idle_seconds),
    ):
        environment.pop(name, None)
        if value is not None:
            environment[name] = value
    subprocess.run(
        [sys.executable, "-c", _REJECTED_DEPLOYMENT_PROBE],
        env=environment,
        capture_output=True,
        text=True,
        check=True,
        timeout=30,
    )


@pytest.mark.parametrize(
    ("gpu", "target", "browser_target"),
    [
        *[
            (gpu, target, None)
            for gpu in ("L4", "L40S", "L40S,A100-80GB")
            for target in (
                None,
                "",
                " ",
                "audio-separator",
                "audio-separator-v2",
                "audio-inference-v3",
                " audio-inference-v3 ",
                " audio-separator-v2 ",
                " audio-separator-dev-owned ",
            )
        ],
        *[
            (gpu, "audio-separator-ci-owned", None)
            for gpu in ("", "T4", "A10", "A100", "A100-80GB", "L4:2", "l4")
        ],
        *[
            (gpu, "audio-separator-ci-owned", browser_target)
            for gpu in ("L4", "L40S")
            for browser_target in (
                "audio-separator-v2",
                "audio-inference-v3",
                "audio-separator-ci-other",
                "",
            )
        ],
    ],
)
def test_test_gpu_rejects_unsafe_deployment_before_resource_declarations(
    gpu, target, browser_target
):
    assert_deployment_rejected(gpu, target, browser_target)


@pytest.mark.parametrize(
    ("target", "browser_target"),
    [
        ("audio-separator-ci-owned", None),
        ("audio-separator-ci-12-1-structure", None),
        ("audio-separator-ci-12-1-smoke-extra", None),
        ("audio-separator-ci-12-1-smoke", "audio-inference-v3"),
        ("audio-separator-ci-12-1-l40s", "audio-separator-ci-12-1-smoke"),
    ],
)
def test_fallback_pool_rejects_non_ci_and_mismatched_browser_targets_before_resources(
    target: str, browser_target: str | None
) -> None:
    assert_deployment_rejected("L40S,A100-80GB", target, browser_target)


def test_missing_ci_hardware_probe_fails_instead_of_assuming_a_gpu(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("PATH", str(tmp_path))
    monkeypatch.setenv("AUDIO_CI_GPU_EVIDENCE", "1")
    modal_app._record_ci_gpu.cache_clear()
    try:
        with pytest.raises(FileNotFoundError):
            modal_app._record_ci_gpu()
    finally:
        modal_app._record_ci_gpu.cache_clear()


@pytest.mark.parametrize(
    "idle_seconds", ["0", "-1", "NaN", "1.5", "", " ", " 60", "60 "]
)
def test_invalid_idle_window_rejected_before_resource_declarations(
    idle_seconds: str,
) -> None:
    assert_deployment_rejected(None, None, None, idle_seconds=idle_seconds)
