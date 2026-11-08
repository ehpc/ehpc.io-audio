"""Real native cache reuse across fresh VPS-like CPU worker processes."""

import json
import os
import subprocess
import sys
from pathlib import Path

from audio_samples import tone_wav


def test_local_cache_restart_and_cancelled_waiter(tmp_path: Path) -> None:
    source = tmp_path / "source.wav"
    source.write_bytes(tone_wav((440,), 0.5))
    helper = Path(__file__).with_name("cache_process.py")
    environment = {
        **os.environ,
        "PYTHONPATH": os.pathsep.join(
            (str(helper.resolve().parents[1]), os.environ.get("PYTHONPATH", ""))
        ),
    }
    evidence = [
        json.loads(
            subprocess.run(
                [
                    sys.executable,
                    str(helper),
                    str(tmp_path),
                    str(source),
                    version,
                    str(prohibit).lower(),
                ],
                env=environment,
                capture_output=True,
                text=True,
                check=True,
                timeout=30,
            ).stdout
        )
        for version, prohibit in zip(
            ("v1", "v1", "v2", "v2"),
            (False, True, False, True),
            strict=True,
        )
    ]
    assert [item["producer_count"] for item in evidence] == [1, 1, 2, 2]
    assert len({item["process_id"] for item in evidence}) == 4
    assert all(item["sha256"] == evidence[0]["sha256"] for item in evidence)
    assert all(
        item["duration_error_samples"] <= 1 and item["cancelled_waiter_released"]
        for item in evidence
    )
    directory = Path(os.environ.get("CACHE_PROOF_DIR", str(tmp_path)))
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "native-process-cache.json").write_text(json.dumps(evidence, indent=2))
    print("CACHE_PROCESS_PROOF " + json.dumps(evidence))
