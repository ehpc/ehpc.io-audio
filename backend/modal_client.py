import modal
from modal.exception import TimeoutError as ModalTimeoutError

from backend import config
from separator.options import SeparationOptions
from separator.stems import SeparationResult

_function: modal.Function | None = None


def _get_function() -> modal.Function:
    global _function
    if _function is None:
        _function = modal.Function.from_name(
            config.MODAL_APP_NAME, config.MODAL_FUNCTION_NAME
        )
    return _function


def spawn(
    audio_bytes: bytes, filename: str, options: SeparationOptions
) -> modal.functions.FunctionCall:
    return _get_function().spawn(audio_bytes, filename, options)


def poll(call: modal.functions.FunctionCall, timeout: float) -> SeparationResult | None:
    """Returns the result once ready, or None if it's not done within `timeout`."""
    try:
        return call.get(timeout=timeout)
    except (TimeoutError, ModalTimeoutError):
        # A poll timeout means "not done yet", not a failure. Modal 1.4 raises the
        # builtin TimeoutError here; other versions have used the (unrelated,
        # same-named) modal.exception.TimeoutError, so catch both.
        return None
