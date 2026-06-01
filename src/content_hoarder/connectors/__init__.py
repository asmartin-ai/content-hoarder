"""Source connectors: registry + dispatch.

Each connector parses one or more input formats and YIELDS normalized item dicts.
The pipeline owns all DB writes. ``dispatch`` picks a connector by sniffing a path;
callers can also force one with ``get(<id>)``.
"""

from __future__ import annotations

from pathlib import Path

from content_hoarder.connectors.base import BaseConnector, ImportResult
from content_hoarder.connectors.reddit import RedditConnector
from content_hoarder.connectors.youtube import YouTubeConnector
from content_hoarder.connectors.hackernews import HNConnector
from content_hoarder.connectors.obsidian import ObsidianConnector
from content_hoarder.connectors.keep import KeepConnector
from content_hoarder.connectors.firefox import FirefoxConnector

# Order matters for dispatch: more specific sniffs first. Obsidian (requires a .md)
# is checked before Keep (any dir with .json) so a vault never matches Keep.
_CONNECTORS = (
    RedditConnector(),
    YouTubeConnector(),
    HNConnector(),
    ObsidianConnector(),
    KeepConnector(),
    FirefoxConnector(),
)

REGISTRY: dict[str, BaseConnector] = {c.id: c for c in _CONNECTORS}


def get(connector_id: str) -> BaseConnector:
    return REGISTRY[connector_id]


def all_connectors() -> list[BaseConnector]:
    return list(REGISTRY.values())


def dispatch(path) -> BaseConnector:
    """Return the first connector that recognizes ``path`` (raises if none)."""
    p = Path(path)
    for connector in REGISTRY.values():
        try:
            if connector.can_import(p):
                return connector
        except Exception:
            continue
    raise ValueError(f"No connector recognizes {p}; pass --source explicitly")


__all__ = [
    "BaseConnector",
    "ImportResult",
    "REGISTRY",
    "get",
    "all_connectors",
    "dispatch",
]
