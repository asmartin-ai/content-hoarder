"""Composable card-source helpers for the future engagement deck.

Epic 22's architecture gate needs a small, backend-owned seam before any Anki
or separate-app prototype: sources produce normalized cards, and the deck
combiner interleaves them without knowing whether a card came from content,
Anki, resurfacing, or another local app.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from typing import Any, Protocol


class CardSource(Protocol):
    """Producer of normalized engagement-deck cards."""

    id: str

    def cards(self, limit: int, **context: Any) -> list[dict[str, Any]]:
        """Return up to ``limit`` cards.

        ``context`` carries source-specific read-only inputs such as DB
        connections, mode flags, or timestamps. Implementations should return an
        empty list when their lane is unavailable; for example, an offline Anki
        source should disappear rather than creating a guilt/error card.
        """


_REQUIRED_CARD_KEYS = frozenset({"id", "source_app", "kind", "title", "actions"})


def validate_card(card: Mapping[str, Any]) -> Mapping[str, Any]:
    """Validate the minimal cross-source card shape.

    The renderer-specific payload intentionally stays open-ended; the stable
    contract is enough identity and action metadata for a host deck to route
    decisions back to the owning source.
    """

    missing = _REQUIRED_CARD_KEYS - set(card)
    if missing:
        raise ValueError("card missing required keys: " + ", ".join(sorted(missing)))
    if not isinstance(card.get("actions"), list):
        raise ValueError("card actions must be a list")
    return card


def deck(
    sources: Sequence[tuple[CardSource, int]],
    *,
    limit: int,
    **context: Any,
) -> list[dict[str, Any]]:
    """Interleave cards from weighted sources.

    ``sources`` is ``[(source, weight), ...]``. A 2:1 content/Anki mix yields two
    content cards, then one Anki card, repeating until ``limit`` or all sources
    are exhausted. Empty sources are skipped, so optional integrations can fail
    closed without user-visible friction.
    """

    if limit <= 0:
        return []
    for _, weight in sources:
        if weight < 1:
            raise ValueError("source weight must be >= 1")

    pools: list[tuple[list[dict[str, Any]], int]] = []
    for source, weight in sources:
        cards = [dict(validate_card(c)) for c in source.cards(limit, **context)]
        if cards:
            pools.append((cards, weight))

    out: list[dict[str, Any]] = []
    while len(out) < limit and any(cards for cards, _ in pools):
        for cards, weight in pools:
            for _ in range(weight):
                if len(out) >= limit:
                    break
                if cards:
                    out.append(cards.pop(0))
    return out
