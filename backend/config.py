import os
from pathlib import Path
from urllib.parse import urlsplit

DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
DB_PATH = DATA_DIR / "jobs.db"
UPLOADS_DIR = DATA_DIR / "uploads"
RESULTS_DIR = DATA_DIR / "results"

QUEUE_CONCURRENCY = int(os.environ.get("QUEUE_CONCURRENCY", "1"))
QUEUE_POLL_INTERVAL_S = float(os.environ.get("QUEUE_POLL_INTERVAL_S", "2"))
MODAL_CALL_POLL_TIMEOUT_S = float(os.environ.get("MODAL_CALL_POLL_TIMEOUT_S", "5"))

# Retry transient (403 / rate-limit) download failures a few times before giving up.
DOWNLOAD_MAX_ATTEMPTS = int(os.environ.get("DOWNLOAD_MAX_ATTEMPTS", "3"))
DOWNLOAD_RETRY_BACKOFF_S = float(os.environ.get("DOWNLOAD_RETRY_BACKOFF_S", "10"))

MODAL_ENVIRONMENT = os.environ.get("MODAL_ENVIRONMENT", "").strip() or "ehpc-audio"
MODAL_APP_NAME = os.environ.get("MODAL_APP_NAME", "audio-inference-v3")
MODEL_VOLUME_NAME = os.environ.get("MODEL_VOLUME_NAME", "audio-separator-models")
PRODUCER_MANIFEST = Path(
    os.environ.get(
        "PRODUCER_MANIFEST",
        str(
            Path(__file__).resolve().parent.parent / "separator" / "model_manifest.json"
        ),
    )
)


def prepared_models_root() -> Path:
    """Shared verification receipts, independent of private computed artifacts."""
    explicit = os.environ.get("PREPARED_MODELS_ROOT")
    return Path(explicit) if explicit else DATA_DIR / "artifacts"


# Authentication keys must be stable, distinct secrets supplied by the operator.
AUTH_OTP_SECRET = os.environ.get("AUTH_OTP_SECRET", "")
AUTH_INVITE_SECRET = os.environ.get("AUTH_INVITE_SECRET", "")
AUTH_ORIGIN = os.environ.get("AUTH_ORIGIN", "")
AUTH_ADMIN_EMAIL = os.environ.get("AUTH_ADMIN_EMAIL", "ehpc@ehpc.io").lower()
AUTH_TRUSTED_PROXY_CIDRS = os.environ.get("AUTH_TRUSTED_PROXY_CIDRS", "")
AUTH_SMTP_SOCKET = os.environ.get("AUTH_SMTP_SOCKET", "/run/audio-mail/submit.sock")


def validate_auth() -> None:
    if (
        len(AUTH_OTP_SECRET.encode()) < 32
        or len(AUTH_INVITE_SECRET.encode()) < 32
        or AUTH_OTP_SECRET == AUTH_INVITE_SECRET
    ):
        raise RuntimeError(
            "AUTH_OTP_SECRET and AUTH_INVITE_SECRET must be distinct secrets "
            "of at least 32 bytes"
        )
    origin = urlsplit(AUTH_ORIGIN)
    if (
        origin.username
        or origin.password
        or origin.path
        or origin.query
        or origin.fragment
        or not origin.hostname
        or origin.scheme not in ("http", "https")
    ):
        raise RuntimeError("AUTH_ORIGIN must be an exact HTTPS origin")
    if origin.scheme == "http" and origin.hostname not in (
        "localhost",
        "127.0.0.1",
        "::1",
    ):
        raise RuntimeError("HTTP AUTH_ORIGIN is allowed only on loopback")


def auth_cookie_secure() -> bool:
    return urlsplit(AUTH_ORIGIN).scheme == "https"
