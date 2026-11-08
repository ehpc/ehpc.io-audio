import logging
from functools import cache

import modal
from modal.exception import TimeoutError as ModalTimeoutError

from backend import config
from separator.inference import InferenceRequest, InferenceResult

log = logging.getLogger(__name__)


@cache
def _get_function() -> modal.Function:
    return modal.Function.from_name(
        config.MODAL_APP_NAME, "infer", environment_name=config.MODAL_ENVIRONMENT
    )


def spawn(request: InferenceRequest) -> modal.functions.FunctionCall[InferenceResult]:
    call = _get_function().spawn(request)
    log.info(
        "spawned %s inference (call_id=%s producer_digest=%s)",
        request.operation,
        call.object_id,
        request.producer_digest,
    )
    return call


def resume(call_id: str) -> modal.functions.FunctionCall[InferenceResult]:
    return modal.FunctionCall.from_id(call_id)


def poll(
    call: modal.functions.FunctionCall[InferenceResult], timeout: float
) -> InferenceResult | None:
    try:
        return call.get(timeout=timeout)
    except (TimeoutError, ModalTimeoutError):
        return None
