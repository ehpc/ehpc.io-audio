from unittest.mock import MagicMock

import pytest
from modal.exception import TimeoutError as ModalTimeoutError

from backend import modal_client


def test_poll_returns_none_on_builtin_timeout() -> None:
    # Regression: Modal 1.4's call.get() raises the builtin TimeoutError on a poll
    # timeout. Catching only modal.exception.TimeoutError let it escape and marked
    # every job failed after the first 5s poll.
    call = MagicMock()
    call.get.side_effect = TimeoutError()
    assert modal_client.poll(call, 5) is None


def test_poll_returns_none_on_modal_timeout() -> None:
    call = MagicMock()
    call.get.side_effect = ModalTimeoutError()
    assert modal_client.poll(call, 5) is None


def test_poll_propagates_real_errors() -> None:
    call = MagicMock()
    call.get.side_effect = RuntimeError("boom")
    with pytest.raises(RuntimeError):
        modal_client.poll(call, 5)
