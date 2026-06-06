"""Configuration: environment + optional .env loading.

No third-party dependency (no python-dotenv). The shell environment always wins;
.env only fills in values that are not already set.
"""

from __future__ import annotations

import os
from pathlib import Path

_DEFAULTS = {
    "CONTENT_HOARDER_DB": "data/app.db",
    "CONTENT_HOARDER_NSFW_RULES": "nsfw_rules.json",  # gitignored; see nsfw_rules.example.json
    "CONTENT_HOARDER_HOST": "127.0.0.1",
    "CONTENT_HOARDER_PORT": "8788",
    "FLASK_SECRET_KEY": "dev-insecure-change-me",
    "USER_AGENT": "content-hoarder/0.1 (local personal use)",
    "KARAKEEP_BASE_URL": "",
    "KARAKEEP_API_KEY": "",
    "LLM_BASE_URL": "http://127.0.0.1:1234/v1",
    "LLM_MODEL": "",
}


def load_env(path: str | os.PathLike | None = None) -> None:
    """Load ``KEY=VALUE`` lines from a .env file into os.environ.

    Existing environment variables are never overwritten. Lines that are blank,
    comments (``#``), or lack ``=`` are ignored. Surrounding quotes are stripped.
    """
    env_path = Path(path) if path else Path(".env")
    if not env_path.is_file():
        return
    for raw in env_path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def get(key: str) -> str:
    """Return an env value, falling back to the built-in default ("" if unknown)."""
    return os.environ.get(key, _DEFAULTS.get(key, ""))


def db_path() -> str:
    return get("CONTENT_HOARDER_DB")


def host() -> str:
    return get("CONTENT_HOARDER_HOST")


def port() -> int:
    try:
        return int(get("CONTENT_HOARDER_PORT"))
    except (TypeError, ValueError):
        return 8788
