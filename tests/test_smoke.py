import modal
import pytest

from backend import config

pytestmark = pytest.mark.smoke


def test_deployed_container_can_import_separator_package() -> None:
    # Regression for the deploy packaging bug: the deployed function crash-looped
    # with `ModuleNotFoundError: No module named 'separator'` until the image
    # included the package. If healthcheck returns, the container imported it.
    # Opt-in (marker `smoke`); needs Modal auth + a prior `make deploy-modal`.
    fn = modal.Function.from_name(config.MODAL_APP_NAME, "healthcheck")
    assert fn.remote() == "ok"
