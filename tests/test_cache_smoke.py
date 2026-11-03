"""New FUSE cache behavior only: private ephemeral volume, CPU, no models."""

import json
import os
import uuid
from pathlib import Path

import modal
import pytest
from audio_samples import tone_wav
from cache_rpc import isolated_cache

pytestmark = pytest.mark.smoke


def test_private_volume_commit_reload_and_cancelled_waiter(tmp_path):
    app = modal.App(f"artifact-cache-proof-{uuid.uuid4().hex[:12]}")
    image = (
        modal.Image.debian_slim(python_version="3.13")
        .apt_install("ffmpeg")
        .add_local_python_source("separator", "cache_rpc")
    )
    with modal.Volume.ephemeral() as volume:
        functions = [
            app.function(
                image=image,
                name=f"cache-{phase}",
                timeout=120,
                volumes={"/private-cache": volume},
            )(isolated_cache)
            for phase in ("fresh", "restart", "version", "repeat")
        ]
        with modal.enable_output(), app.run():
            evidence = [
                json.loads(
                    function.remote(volume, tone_wav((440,), 0.5), version, prohibit)
                )
                for function, version, prohibit in zip(
                    functions,
                    ("v1", "v1", "v2", "v2"),
                    (False, True, False, True),
                    strict=True,
                )
            ]
    assert [item["producer_count"] for item in evidence] == [1, 1, 2, 2]
    assert len({item["container"] for item in evidence}) == 4
    assert all(item["sha256"] == evidence[0]["sha256"] for item in evidence)
    assert all(
        item["duration_error_samples"] <= 1 and item["cancelled_waiter_released"]
        for item in evidence
    )
    directory = Path(os.environ.get("CACHE_PROOF_DIR", str(tmp_path)))
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "modal-volume.json").write_text(json.dumps(evidence, indent=2))
    print("CACHE_VOLUME_PROOF " + json.dumps(evidence))
