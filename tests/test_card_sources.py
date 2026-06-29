from content_hoarder import card_sources


class StaticSource:
    def __init__(self, source_id, cards):
        self.id = source_id
        self._cards = list(cards)

    def cards(self, limit, **context):
        assert context == {"mode": "test"}
        return self._cards[:limit]


def _card(card_id, source="x"):
    return {
        "id": card_id,
        "source_app": source,
        "kind": "stub",
        "title": f"Card {card_id}",
        "actions": [],
    }


def test_source_card_requires_minimal_shape():
    good = _card("a")
    assert card_sources.validate_card(good) == good

    missing = dict(good)
    missing.pop("actions")
    try:
        card_sources.validate_card(missing)
    except ValueError as exc:
        assert "actions" in str(exc)
    else:
        raise AssertionError("missing actions should reject the card")


def test_round_robin_interleaves_registered_sources_with_ratio():
    deck = card_sources.deck(
        [
            (
                StaticSource(
                    "content",
                    [
                        _card("c1", "content"),
                        _card("c2", "content"),
                        _card("c3", "content"),
                    ],
                ),
                2,
            ),
            (StaticSource("anki", [_card("a1", "anki"), _card("a2", "anki")]), 1),
        ],
        limit=5,
        mode="test",
    )

    assert [c["id"] for c in deck] == ["c1", "c2", "a1", "c3", "a2"]


def test_round_robin_skips_empty_sources_and_clamps_to_limit():
    deck = card_sources.deck(
        [
            (StaticSource("empty", []), 1),
            (StaticSource("content", [_card("c1"), _card("c2"), _card("c3")]), 1),
        ],
        limit=2,
        mode="test",
    )

    assert [c["id"] for c in deck] == ["c1", "c2"]


def test_invalid_source_weight_is_rejected():
    try:
        card_sources.deck([(StaticSource("content", [_card("c1")]), 0)], limit=1)
    except ValueError as exc:
        assert "weight" in str(exc)
    else:
        raise AssertionError("zero weights should be rejected")
