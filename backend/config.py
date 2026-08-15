import os
from pathlib import Path

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

MODAL_APP_NAME = os.environ.get("MODAL_APP_NAME", "audio-separator")
MODAL_FUNCTION_NAME = os.environ.get("MODAL_FUNCTION_NAME", "separate")

SESSION_COOKIE_NAME = "session_id"
COOKIE_SECRET = os.environ.get("COOKIE_SECRET", "dev-insecure-secret-change-me")
# Default false: local/dev runs over plain HTTP, and a Secure cookie is silently
# dropped by clients on non-TLS connections, breaking session persistence. Prod
# (behind TLS) must set COOKIE_SECURE=true explicitly.
COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "false").lower() == "true"
COOKIE_MAX_AGE_S = 60 * 60 * 24 * 365
