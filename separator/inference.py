"""Private, finite model-stage wire contract; orchestration lives on the VPS."""

import hashlib
import json
from dataclasses import dataclass, field
from pathlib import PurePath
from typing import Literal, get_args

type JSONValue = (
    bool | int | float | str | list[JSONValue] | dict[str, JSONValue] | None
)
type Operation = Literal["separation", "recognition", "alignment", "pitch", "structure"]
OPERATIONS = frozenset(get_args(Operation.__value__))


@dataclass(frozen=True)
class InferenceRequest:
    operation: Operation
    audio_bytes: bytes
    filename: str
    producer_digest: str
    parameters: dict[str, JSONValue] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.operation not in OPERATIONS:
            raise ValueError("Unsupported inference operation")
        if not isinstance(self.audio_bytes, bytes) or not self.audio_bytes:
            raise ValueError("Inference requires nonempty audio")
        if not isinstance(self.parameters, dict):
            raise ValueError("Inference parameters must be an object")
        if (
            not self.filename
            or PurePath(self.filename).name != self.filename
            or "\\" in self.filename
            or "\x00" in self.filename
            or self.filename in {".", ".."}
        ):
            raise ValueError("Inference filename must be a basename")
        if len(self.producer_digest) != 64 or any(
            character not in "0123456789abcdef" for character in self.producer_digest
        ):
            raise ValueError("Inference requires a verified producer identity")

    def fingerprint(self) -> str:
        """Bind a resumed result to the exact acoustic input and producer request."""
        return hashlib.sha256(
            json.dumps(
                {
                    "operation": self.operation,
                    "source_sha256": hashlib.sha256(self.audio_bytes).hexdigest(),
                    "producer_digest": self.producer_digest,
                    "parameters": self.parameters,
                },
                sort_keys=True,
                separators=(",", ":"),
                allow_nan=False,
            ).encode()
        ).hexdigest()
