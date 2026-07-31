"""Browser worker configuration (environment-driven)."""
import os
from pathlib import Path

WORKER_ID = os.environ.get("SE_WORKER_ID", "worker-1")
WORKER_HOST = os.environ.get("SE_WORKER_HOST", "0.0.0.0")
WORKER_PORT = int(os.environ.get("SE_WORKER_PORT", "8701"))
# URL at which the broker can reach this worker (used for self-registration).
WORKER_PUBLIC_URL = os.environ.get("SE_WORKER_PUBLIC_URL", f"http://localhost:{WORKER_PORT}")

BROKER_URL = os.environ.get("SE_BROKER_URL", "http://localhost:8700")

# Where session artifacts (frames, downloads, recordings) are written.
# In docker-compose this is a volume shared with the broker.
DATA_DIR = Path(os.environ.get("SE_DATA_DIR", "./data")).resolve()
RECORDINGS_DIR = DATA_DIR / "recordings"

MAX_SESSIONS = int(os.environ.get("SE_MAX_SESSIONS", "5"))

# Optional explicit Chromium binary (e.g. /opt/pw-browsers/chromium when the
# environment pre-installs a browser that doesn't match the Playwright pin).
CHROMIUM_EXECUTABLE = os.environ.get("SE_CHROMIUM_EXECUTABLE") or None
FFMPEG_PATH = os.environ.get("SE_FFMPEG_PATH", "ffmpeg")

SCREENCAST_QUALITY = int(os.environ.get("SE_SCREENCAST_QUALITY", "60"))
SCREENCAST_MAX_WIDTH = int(os.environ.get("SE_SCREENCAST_MAX_WIDTH", "1600"))
SCREENCAST_MAX_HEIGHT = int(os.environ.get("SE_SCREENCAST_MAX_HEIGHT", "1000"))

# Gap (seconds) between input events that counts as idle time in metrics.
IDLE_GAP_SECONDS = int(os.environ.get("SE_IDLE_GAP_SECONDS", "30"))
