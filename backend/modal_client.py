from functools import cache

import modal
from modal.exception import TimeoutError as ModalTimeoutError

from backend import config
from separator.lyrics_reference import ReferenceMetadata
from separator.options import SeparationOptions
from separator.processing import ProcessingResult
from separator.stems import SeparationResult

LYRICS_FUNCTION_NAME = "separate_with_lyrics"


@cache
def _get_function(name: str) -> modal.Function:
    return modal.Function.from_name(config.MODAL_APP_NAME, name)


def spawn(
    audio_bytes: bytes, filename: str, options: SeparationOptions
) -> modal.functions.FunctionCall[SeparationResult]:
    return _get_function(config.MODAL_FUNCTION_NAME).spawn(
        audio_bytes, filename, options
    )


def spawn_with_lyrics(
    audio_bytes: bytes,
    filename: str,
    options: SeparationOptions,
    reference_metadata: ReferenceMetadata | None = None,
) -> modal.functions.FunctionCall[ProcessingResult]:
    function = _get_function(LYRICS_FUNCTION_NAME)
    if reference_metadata is None:
        return function.spawn(audio_bytes, filename, options)
    return function.spawn(audio_bytes, filename, options, reference_metadata)


def poll[T](call: modal.functions.FunctionCall[T], timeout: float) -> T | None:
    """Returns the result once ready, or None if it's not done within `timeout`."""
    try:
        return call.get(timeout=timeout)
    except (TimeoutError, ModalTimeoutError):
        # A poll timeout means "not done yet", not a failure. Modal 1.4 raises the
        # builtin TimeoutError here; other versions have used the (unrelated,
        # same-named) modal.exception.TimeoutError, so catch both.
        return None
