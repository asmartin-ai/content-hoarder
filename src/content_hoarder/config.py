"""Configuration: environment + optional .env loading.

No third-party dependency (no python-dotenv). The shell environment always wins;
.env only fills in values that are not already set.
"""

from __future__ import annotations

import os
import sys
import warnings
from pathlib import Path

_DEFAULTS = {
    "CONTENT_HOARDER_DB": "data/app.db",
    "CONTENT_HOARDER_NSFW_RULES": "nsfw_rules.json",  # gitignored; see nsfw_rules.example.json
    "CONTENT_HOARDER_HOST": "127.0.0.1",
    "CONTENT_HOARDER_PORT": "8788",
    # Extra hostnames the web guard accepts (comma-separated). Local/private/tailnet
    # addresses are always allowed; set this only when serving behind a real DNS name.
    "CONTENT_HOARDER_ALLOWED_HOSTS": "",
    "FLASK_SECRET_KEY": "dev-insecure-change-me",
    "USER_AGENT": "content-hoarder/0.1 (local personal use)",
    # Reddit cookie transport: a real browser UA makes a logged-in session blend in, unlike
    # the generic USER_AGENT above (which still serves archives/youtube/karakeep). Override in
    # .env with YOUR actual browser's UA string for the closest blend. See docs/reddit-derisking.md.
    "REDDIT_BROWSER_USER_AGENT":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0",
    # Reddit OAuth (installed-app; read + history + identity + save scopes). Client id is a PUBLIC installed-app id (e.g.
    # RedReader's) — there is no client secret. The redirect URI must match that app's
    # registered one (RedReader = redreader://rr_oauth_redir). Blank client id = cookie-only.
    "REDDIT_OAUTH_CLIENT_ID": "",
    "REDDIT_OAUTH_REDIRECT_URI": "redreader://rr_oauth_redir",
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
    try:
        # utf-8-sig strips the BOM Notepad prepends (else the first key never matches);
        # errors="replace" degrades a stray bad byte to U+FFFD instead of crashing startup
        # — the shell environment is the authoritative source anyway.
        content = env_path.read_text(encoding="utf-8-sig", errors="replace")
    except OSError:
        return
    for raw in content.splitlines():
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


# Security-relevant vars that are dangerous to leave at their built-in default.
# Each entry: (env_var, default_value_that_is_insecure, why_message).
# Audit Low 2026-07-02 (Pass 5): config fell back silently to insecure defaults;
# boot-time warning preserves the zero-config LAN posture while closing the trap
# if the app is ever exposed beyond Tailscale or gains Flask sessions.
_INSECURE_DEFAULTS: tuple[tuple[str, str, str], ...] = (
    (
        "FLASK_SECRET_KEY",
        "dev-insecure-change-me",
        "FLASK_SECRET_KEY is at its insecure built-in default. Sessions (if/when "
        "introduced) would be forgeable. Set a random value in .env before exposing "
        "the app beyond Tailscale or adding Flask session use.",
    ),
)


def validate(*, stream=None, warn: bool = True) -> list[str]:
    """Warn on stderr when security-relevant env vars sit at insecure defaults.

    Returns the list of warning messages (empty when clean). Never raises, never
    blocks startup — the deliberate posture is fail-late/zero-config for the LAN
    single-user case (see AGENTS.md). ``stream`` defaults to ``sys.stderr``;
    pass a custom stream in tests. ``warn=False`` silences the stderr write but
    still returns the messages so callers can surface them differently.
    """
    messages: list[str] = []
    for env_var, bad_default, why in _INSECURE_DEFAULTS:
        if get(env_var) == bad_default:
            messages.append(why)
    if messages and warn:
        out = stream or sys.stderr
        for m in messages:
            try:
                print(f"warning: {m}", file=out)
            except Exception:
                # stderr write must never kill startup; fall back to warnings.warn.
                warnings.warn(m)
    return messages
