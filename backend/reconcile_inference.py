"""Reconcile an uncertain private model dispatch with audio admission drained."""

import argparse
import json

from backend import config, db, modal_client
from separator.inference import InferenceResult


def reconcile(
    job_id: int, *, call_id: str | None = None, verified_not_dispatched: bool = False
) -> str:
    """Never infer a missing call or retry paid work automatically.

    Stop/drain the old audio worker and start with QUEUE_CONCURRENCY=0 first.
    A known call is attached only after its completed result proves the recorded
    request fingerprint. Releasing an intent requires operator evidence that no
    call was accepted, not merely an absent call ID or a timeout.
    """
    if config.QUEUE_CONCURRENCY != 0:
        raise RuntimeError("Drain model admission and set QUEUE_CONCURRENCY=0 first")
    if bool(call_id) == verified_not_dispatched:
        raise ValueError("Choose a completed call or verified non-dispatch")
    job = db.get_job(job_id)
    if job is None or job.active_stage_key is None:
        raise ValueError("Job has no model dispatch intent")
    if job.modal_call_id is not None:
        raise ValueError("Job already has a recorded model call; resume it normally")
    key = job.active_stage_key
    if len(key) != 64 or any(character not in "0123456789abcdef" for character in key):
        raise ValueError("Invalid recorded semantic stage identity")
    if verified_not_dispatched:
        if not db.release_inference_stage(job_id, key):
            raise RuntimeError("Dispatch ownership changed; intent was not released")
        return "released-verified-non-dispatch"
    assert call_id is not None
    receipt_path = config.DATA_DIR / "artifacts" / "inference-requests" / f"{key}.json"
    receipt = json.loads(receipt_path.read_bytes())
    result = modal_client.poll(
        modal_client.resume(call_id), config.MODAL_CALL_POLL_TIMEOUT_S
    )
    if result is None:
        raise RuntimeError(
            "Call is not complete; request binding cannot yet be verified"
        )
    if (
        not isinstance(result, InferenceResult)
        or result.request_fingerprint != receipt["request_fingerprint"]
        or not isinstance(result.data, bytes)
        or not result.data
    ):
        raise ValueError("Completed call does not match the recorded model request")
    db.set_active_stage(job_id, key, call_id)
    return "attached-verified-completed-call"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--job-id", required=True, type=int)
    parser.add_argument("--admission-drained", required=True, action="store_true")
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--call-id")
    action.add_argument("--verified-not-dispatched", action="store_true")
    arguments = parser.parse_args()
    result = reconcile(
        arguments.job_id,
        call_id=arguments.call_id,
        verified_not_dispatched=arguments.verified_not_dispatched,
    )
    print(json.dumps({"job_id": arguments.job_id, "result": result}))


if __name__ == "__main__":
    main()
