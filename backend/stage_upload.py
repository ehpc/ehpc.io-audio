"""Upload an already serialized private inference request before GPU dispatch."""

import sys
from pathlib import Path

from backend import modal_client
from separator.inference_transport import validate_output_id


def upload(root: Path, output_id: str) -> None:
    validate_output_id(output_id)
    with modal_client._get_transport_volume().batch_upload(force=True) as batch:
        for name in ("input.bin", "request.json"):
            batch.put_file(root / output_id / name, f"/{output_id}/{name}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("Expected staging directory and transfer ID")
    upload(Path(sys.argv[1]), sys.argv[2])
