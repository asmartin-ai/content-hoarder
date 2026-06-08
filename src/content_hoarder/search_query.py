"""Search-bar operator parsing.

This module turns a Gmail/Discord-style query string into:
- structured filters (source:, status:, tag:, before:, ...), and
- a leftover free-text string that continues to flow through the existing FTS path.

It is intentionally DB-free and side-effect-free so it can be unit-tested in
isolation and used by both the generic and Reddit-specific item routes.

See docs/search-operators-spec.md.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime, timezone


_NSFW_TAGS = ("nsfw_erotic", "nsfw_other", "nsfw_talk")


@dataclass(frozen=True)
class ParsedQuery:
    text: str = ""

    source: str | None = None
    kind: str | None = None
    status: str | None = None
    subreddit: str | None = None

    tags: list[str] = field(default_factory=list)
    # When true: tags are AND-ed (one required-membership check per tag).
    # When false: tags are OR-ed (any tag matches).
    tags_all: bool = False

    is_saved: int | None = None  # 1/0 (SQLite-friendly)
    nsfw: bool = False

    before: int | None = None  # unix seconds (UTC)
    after: int | None = None

    score_min: int | None = None
    score_max: int | None = None

    exclude: list[str] = field(default_factory=list)  # -term tokens
    exact: list[str] = field(default_factory=list)  # "quoted phrases"


_OP_RE = re.compile(r"^(?P<neg>-?)(?P<key>\w+):(?P<val>.+)$", re.UNICODE)


def _tokenize(q: str) -> list[tuple[str, bool]]:
    """Split on whitespace, respecting double-quoted phrases.

    Returns (token, quoted) where quoted=True means the token came from inside
    a balanced pair of double quotes.
    """
    s = q or ""
    out: list[tuple[str, bool]] = []
    i = 0
    n = len(s)
    while i < n:
        while i < n and s[i].isspace():
            i += 1
        if i >= n:
            break

        if s[i] == '"':
            j = i + 1
            while j < n and s[j] != '"':
                j += 1
            if j < n and s[j] == '"':
                out.append((s[i + 1 : j], True))
                i = j + 1
                continue
            # Unbalanced quote -> degrade to a normal token (keep the quote).

        j = i
        while j < n and not s[j].isspace():
            j += 1
        out.append((s[i:j], False))
        i = j

    return out


def _parse_yyyymmdd(value: str) -> int | None:
    try:
        dt = datetime.strptime(value, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None
    return int(dt.timestamp())


def _dedupe_preserve_order(xs: list[str]) -> list[str]:
    out: list[str] = []
    for x in xs:
        if x and x not in out:
            out.append(x)
    return out


def _parse_score(value: str) -> tuple[int | None, int | None] | None:
    """Return (min, max) inclusive bounds for score:, or None on parse failure."""
    s = (value or "").strip()
    if not s:
        return None

    op = "="
    num = s
    for cand in (">=", "<=", ">", "<", "="):
        if s.startswith(cand):
            op = cand
            num = s[len(cand) :].strip()
            break

    try:
        n = int(num)
    except ValueError:
        return None

    if op == ">":
        return (n + 1, None)
    if op == ">=":
        return (n, None)
    if op == "<":
        return (None, n - 1)
    if op == "<=":
        return (None, n)
    # '=' or no explicit op
    return (n, n)


def parse(q: str) -> ParsedQuery:
    """Parse a query string into structured operators + leftover free text.

    Unknown operators (unknown key:value) and malformed known operators degrade to
    free-text tokens (they are not dropped and do not error).
    """
    text_terms: list[str] = []
    exclude: list[str] = []
    exact: list[str] = []

    source = kind = status = subreddit = None
    tags_groups: list[list[str]] = []  # each token's group; later collapsed to tags/tags_all
    is_saved: int | None = None
    nsfw = False
    before = after = None
    score_min = score_max = None

    for tok, quoted in _tokenize(q):
        t = (tok or "").strip()
        if not t:
            continue

        if quoted:
            phrase = t.strip()
            if phrase:
                exact.append(phrase)
            continue

        if t.startswith("-") and len(t) > 1 and ":" not in t:
            exclude.append(t[1:])
            continue

        m = _OP_RE.match(t)
        if not m:
            text_terms.append(t)
            continue

        if m.group("neg") == "-":
            # Operator negation isn't in-scope yet; degrade to free text.
            text_terms.append(t)
            continue

        key = (m.group("key") or "").strip().lower()
        val = (m.group("val") or "").strip()

        if key in {"source", "kind", "status", "subreddit"}:
            if not val:
                text_terms.append(t)
                continue
            # source/kind/status are stored canonical-lowercase, so normalize the typed
            # value (e.g. `source:YouTube` -> `youtube`) or it would silently match nothing.
            # subreddit is left as-typed (search_items matches it COLLATE NOCASE).
            if key == "source":
                source = val.lower()
            elif key == "kind":
                kind = val.lower()
            elif key == "status":
                status = val.lower()
            elif key == "subreddit":
                subreddit = val
            continue

        if key == "tag":
            parts = [p.strip() for p in re.split(r"[,|]", val) if p.strip()]
            if not parts:
                text_terms.append(t)
                continue
            tags_groups.append(parts)
            continue

        if key == "is":
            v = val.lower()
            if v == "saved":
                is_saved = 1
                continue
            if v == "unsaved":
                is_saved = 0
                continue
            if v == "nsfw":
                nsfw = True
                continue
            text_terms.append(t)
            continue

        if key in {"before", "after"}:
            ts = _parse_yyyymmdd(val)
            if ts is None:
                text_terms.append(t)
                continue
            if key == "before":
                before = ts
            else:
                after = ts
            continue

        if key == "score":
            bounds = _parse_score(val)
            if bounds is None:
                text_terms.append(t)
                continue
            score_min, score_max = bounds
            continue

        # Unknown operator -> free text
        text_terms.append(t)

    # Collapse tag groups into the simple API requested by the spec.
    #
    # Supported forms (per docs/search-operators-spec.md):
    # - repeated tag:foo tag:bar => AND (tags_all=True)
    # - tag:foo,bar or tag:foo|bar => OR within that token
    #
    # Mixed AND+OR grouping (e.g. tag:a,b tag:c) is intentionally not represented
    # by this v1 shape; we degrade to a global OR when any OR-group is present.
    tags_all = False
    tags: list[str] = []
    if tags_groups:
        has_or = any(len(g) > 1 for g in tags_groups)
        if has_or:
            tags_all = False
            tags = _dedupe_preserve_order([x for g in tags_groups for x in g])
        else:
            tags_all = len(tags_groups) > 1
            tags = _dedupe_preserve_order([g[0] for g in tags_groups if g])

    return ParsedQuery(
        text=" ".join(text_terms).strip(),
        source=source,
        kind=kind,
        status=status,
        subreddit=subreddit,
        tags=tags,
        tags_all=tags_all,
        is_saved=is_saved,
        nsfw=nsfw,
        before=before,
        after=after,
        score_min=score_min,
        score_max=score_max,
        exclude=_dedupe_preserve_order([x.strip() for x in exclude if x.strip()]),
        exact=_dedupe_preserve_order([x.strip() for x in exact if x.strip()]),
    )


def nsfw_tags() -> tuple[str, ...]:
    """Expose the NSFW tag vocabulary for callers/tests."""
    return _NSFW_TAGS
