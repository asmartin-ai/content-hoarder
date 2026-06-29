"""Minimal AnkiConnect adapter for the engagement deck prototype.

AnkiConnect's API is local JSON-RPC over HTTP. This module keeps it optional and
quiet: if desktop Anki/AnkiConnect is not running, the card source returns no
cards instead of surfacing a guilt/error state in the deck.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

from content_hoarder._http import HttpError, request

API_VERSION = 6
DEFAULT_URL = "http://127.0.0.1:8765"
DEFAULT_DUE_QUERY = "is:due"

_ACTION_EASE = {
    "again": 1,
    "good": 3,
}


class AnkiConnectError(Exception):
    """Raised when AnkiConnect returns an application-level error."""


def invoke(
    url: str = DEFAULT_URL,
    action: str = "version",
    *,
    key: str | None = None,
    request_func: Callable[..., tuple[int, dict, bytes]] | None = None,
    timeout: float = 2.0,
    **params: Any,
) -> Any:
    """Invoke an AnkiConnect action and return its ``result``.

    Official request shape: ``{"action", "version", "params", "key?"}``.
    Official response shape for version 6: ``{"result", "error"}``.
    """

    payload: dict[str, Any] = {"action": action, "version": API_VERSION}
    if params:
        payload["params"] = params
    if key:
        payload["key"] = key
    transport = request_func or request
    _, _, raw = transport(
        url,
        method="POST",
        headers={"Content-Type": "application/json"},
        data=json.dumps(payload).encode("utf-8"),
        timeout=timeout,
    )
    try:
        body = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise AnkiConnectError("invalid AnkiConnect JSON response") from exc
    if not isinstance(body, dict) or "result" not in body or "error" not in body:
        raise AnkiConnectError("unexpected AnkiConnect response shape")
    if body["error"] is not None:
        raise AnkiConnectError(str(body["error"]))
    return body["result"]


class AnkiDueCardSource:
    """Card source for due Anki flashcards.

    The source is intentionally read-only until the user takes an action. When
    Anki is offline/unavailable, it returns ``[]`` so the engagement deck simply
    omits this lane.
    """

    id = "anki"

    def __init__(
        self,
        *,
        url: str = DEFAULT_URL,
        key: str | None = None,
        query: str = DEFAULT_DUE_QUERY,
        invoke_func: Callable[..., Any] = invoke,
    ) -> None:
        self.url = url
        self.key = key
        self.query = query
        self._invoke = invoke_func

    def _call(self, action: str, **params: Any) -> Any:
        if self.key:
            params["key"] = self.key
        return self._invoke(self.url, action, **params)

    def cards(self, limit: int, **context: Any) -> list[dict[str, Any]]:
        if limit <= 0:
            return []
        try:
            ids = list(self._call("findCards", query=self.query) or [])[:limit]
            if not ids:
                return []
            infos = self._call("cardsInfo", cards=ids) or []
        except (HttpError, AnkiConnectError, OSError):
            return []
        out: list[dict[str, Any]] = []
        for info in infos[:limit]:
            card_id = info.get("cardId")
            question = info.get("question") or "Anki card"
            out.append(
                {
                    "id": f"anki:{card_id}",
                    "source_app": "anki",
                    "kind": "flashcard",
                    "title": question,
                    "actions": [
                        {
                            "id": "again",
                            "label": "Again",
                            "ease": _ACTION_EASE["again"],
                        },
                        {"id": "good", "label": "Good", "ease": _ACTION_EASE["good"]},
                    ],
                    "payload": {
                        "card_id": card_id,
                        "question": question,
                        "answer": info.get("answer") or "",
                        "deck": info.get("deckName") or "",
                        "model": info.get("modelName") or "",
                    },
                }
            )
        return out


def answer_card(
    url: str,
    card_id: int,
    action: str,
    *,
    key: str | None = None,
    invoke_func: Callable[..., Any] = invoke,
) -> bool:
    """Answer one Anki card using the deck action id.

    Prototype scope intentionally exposes only Again/Good; wider Anki ease
    controls can be added after UI review.
    """

    if action not in _ACTION_EASE:
        raise ValueError("unsupported Anki action; expected one of: again, good")
    params: dict[str, Any] = {
        "answers": [{"cardId": int(card_id), "ease": _ACTION_EASE[action]}]
    }
    if key:
        params["key"] = key
    result = invoke_func(url, "answerCards", **params)
    return bool(result and result[0])
