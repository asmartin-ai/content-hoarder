import pytest
from content_hoarder.categorize import categorize


def test_new_terms():
    new_terms = [
        "otagei",
        "打ち師",
        "サイリウムダンス",
        "ペンライトダンス",
        "cyalume",
    ]
    for term in new_terms:
        assert categorize(f"video with {term}", "", None) == "wotagei", f"Failed for {term}"


def test_existing_terms():
    assert categorize("ヲタ芸 performance", "", None) == "wotagei"
    assert categorize("wotagei event", "", None) == "wotagei"


def test_precision():
    precision_cases = [
        "Botagei compilation",
        "cyalumes wholesale catalog",
        "penlight review",
        "サイリウム review",
        "ペンライト review",
    ]
    for title in precision_cases:
        assert categorize(title, "", None) == "unknown", f"Failed precision for {title}"


def test_precedence():
    assert categorize("otagei dance", "Isaac Arthur", None) == "wotagei"
