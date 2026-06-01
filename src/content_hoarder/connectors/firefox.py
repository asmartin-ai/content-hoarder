"""Firefox tabs connector — DEFERRED.

Registered so the slot exists, but not built in v1. When implemented it will read a
session export (OneTab / Tab Session Manager) or ``recovery.jsonlz4`` and emit
``firefox:<url-hash>`` bookmarks — no schema/registry/UI change required.
"""

from __future__ import annotations

from pathlib import Path

from content_hoarder.connectors.base import BaseConnector


class FirefoxConnector(BaseConnector):
    id = "firefox"
    label = "Firefox Tabs"
    badge_color = "#ff7139"

    def can_import(self, path: Path) -> bool:
        return False

    def import_file(self, path: Path):
        raise NotImplementedError("Firefox tab connector is deferred to a later phase")
