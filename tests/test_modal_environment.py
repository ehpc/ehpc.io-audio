import os
import subprocess
import sys

import pytest

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
            ("L4", target, None)
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
            for gpu in ("", "T4", "A10", "L40S", "L4:2", "l4")
        ],
        (
            "L4",
            "audio-separator-ci-owned",
            "audio-separator-v2",
        ),
        (
            "L4",
            "audio-separator-ci-owned",
            "audio-inference-v3",
        ),
        (
            "L4",
            "audio-separator-ci-owned",
            "",
        ),
    ],
)
def test_test_gpu_rejects_unsafe_deployment_before_resource_declarations(
    gpu, target, browser_target
):
    assert_deployment_rejected(gpu, target, browser_target)


@pytest.mark.parametrize(
    "idle_seconds", ["0", "-1", "NaN", "1.5", "", " ", " 60", "60 "]
)
def test_invalid_idle_window_rejected_before_resource_declarations(
    idle_seconds: str,
) -> None:
    assert_deployment_rejected(None, None, None, idle_seconds=idle_seconds)
