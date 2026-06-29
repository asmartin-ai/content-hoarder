import json

from content_hoarder import anki_connect
from content_hoarder._http import HttpError


def test_invoke_posts_version_6_request_and_returns_result(monkeypatch):
    calls = []

    def fake_request(url, **kwargs):
        calls.append((url, kwargs))
        return 200, {}, json.dumps({"result": [1, 2], "error": None}).encode()

    monkeypatch.setattr(anki_connect, "request", fake_request)

    assert anki_connect.invoke(
        "http://127.0.0.1:8765", "findCards", query="is:due"
    ) == [1, 2]
    url, kwargs = calls[0]
    assert url == "http://127.0.0.1:8765"
    assert kwargs["method"] == "POST"
    assert kwargs["headers"]["Content-Type"] == "application/json"
    payload = json.loads(kwargs["data"].decode())
    assert payload == {
        "action": "findCards",
        "version": 6,
        "params": {"query": "is:due"},
    }


def test_invoke_supports_api_key():
    seen = {}

    def fake_request(url, **kwargs):
        seen.update(json.loads(kwargs["data"].decode()))
        return 200, {}, b'{"result": true, "error": null}'

    assert (
        anki_connect.invoke(
            "http://x", "version", key="secret", request_func=fake_request
        )
        is True
    )
    assert seen["key"] == "secret"


def test_invoke_raises_on_anki_error():
    def fake_request(url, **kwargs):
        return 200, {}, b'{"result": null, "error": "unsupported action"}'

    try:
        anki_connect.invoke("http://x", "nope", request_func=fake_request)
    except anki_connect.AnkiConnectError as exc:
        assert "unsupported action" in str(exc)
    else:
        raise AssertionError("AnkiConnect errors should raise")


def test_due_card_source_maps_cards_to_deck_cards():
    calls = []

    def fake_invoke(url, action, **params):
        calls.append((action, params))
        if action == "findCards":
            return [101, 102, 103]
        if action == "cardsInfo":
            assert params == {"cards": [101, 102]}
            return [
                {
                    "cardId": 101,
                    "question": "Q1",
                    "answer": "A1",
                    "deckName": "Japanese",
                    "modelName": "Basic",
                },
                {
                    "cardId": 102,
                    "question": "Q2",
                    "answer": "A2",
                    "deckName": "Default",
                    "modelName": "Cloze",
                },
            ]
        raise AssertionError(action)

    source = anki_connect.AnkiDueCardSource(url="http://anki", invoke_func=fake_invoke)
    cards = source.cards(2)

    assert [c["id"] for c in cards] == ["anki:101", "anki:102"]
    assert cards[0]["source_app"] == "anki"
    assert cards[0]["kind"] == "flashcard"
    assert cards[0]["title"] == "Q1"
    assert cards[0]["payload"]["answer"] == "A1"
    assert cards[0]["actions"] == [
        {"id": "again", "label": "Again", "ease": 1},
        {"id": "good", "label": "Good", "ease": 3},
    ]
    assert calls[0] == ("findCards", {"query": "is:due"})


def test_due_card_source_disappears_when_anki_is_offline():
    def offline(*args, **kwargs):
        raise HttpError("connection refused")

    source = anki_connect.AnkiDueCardSource(url="http://anki", invoke_func=offline)
    assert source.cards(10) == []


def test_answer_card_maps_again_and_good_to_anki_ease():
    calls = []

    def fake_invoke(url, action, **params):
        calls.append((action, params))
        return [True]

    assert (
        anki_connect.answer_card("http://anki", 123, "good", invoke_func=fake_invoke)
        is True
    )
    assert calls == [("answerCards", {"answers": [{"cardId": 123, "ease": 3}]})]

    try:
        anki_connect.answer_card("http://anki", 123, "easy", invoke_func=fake_invoke)
    except ValueError as exc:
        assert "again" in str(exc) and "good" in str(exc)
    else:
        raise AssertionError("unsupported actions should be rejected")
