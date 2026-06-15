"""Connector contract + result type.

Connectors PARSE and **yield** normalized item dicts (built with
``content_hoarder.models.new_item``). They must NOT touch the database — the
pipeline owns all writes. This keeps every connector unit-testable with no DB.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable


@dataclass
class ImportResult:
    imported: int = 0
    skipped: int = 0
    errors: list[str] = field(default_factory=list)
    #: Per-kind unsave-reconciliation summary when ``import_path(reconcile=True)``; else None.
    reconcile: dict | None = None


class BaseConnector(ABC):
    #: Stable id — also stored as ``items.source``.
    id: str = ""
    #: Human-friendly label for UI/CLI.
    label: str = ""
    #: CSS color for the per-source badge.
    badge_color: str = "#888888"

    @abstractmethod
    def can_import(self, path: Path) -> bool:
        """Cheap sniff: does this connector recognize ``path``?"""
        raise NotImplementedError

    @abstractmethod
    def import_file(self, path: Path) -> Iterable[dict]:
        """Yield normalized item dicts (via ``models.new_item``). No DB writes."""
        raise NotImplementedError

    def enrich(self, items: list[dict]) -> list[dict]:
        """Optionally fill sparse rows from an external API. Default: no-op."""
        return items

    def sync(self) -> Iterable[dict]:
        """Optional live pull (OAuth/API). Not implemented in Phase 1."""
        raise NotImplementedError(f"{self.id} has no live sync yet")
