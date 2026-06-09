# Pin merge_upsert's tags semantics (comment + characterization test)

## Model: devstral

`db.merge_upsert` merges incoming `metadata.tags` two different ways depending on whether the
incoming item also carries a `category`: **union** when it does, **wholesale replace** when it
doesn't. Current callers happen to survive this, but a future caller doing a partial-tags
merge would silently clobber existing tags (e.g. NSFW tags). Pin the behavior with a comment
and a characterization test so any change is deliberate.

## Context — current code (src/content_hoarder/db.py, inside merge_upsert)

```python
    # metadata: shallow-merge (incoming non-empty values win; keep prior keys).
    emd = parse_metadata(existing.get("metadata"))
    for k, v in incoming_md.items():
        if k == "tags" and incoming_category:
            tags = _tag_list(emd.get("tags"))
            for t in _tag_list(v):
                if t not in tags:
                    tags.append(t)
            emd["tags"] = tags
            continue
        if v not in (None, "", [], {}):
            emd[k] = v
    if incoming_category:
        emd = metadata_with_category_tag(emd, incoming_category)
    elif emd.get("category"):
        emd = metadata_with_category_tag(emd, str(emd.get("category") or ""))
```

`metadata_with_category_tag` re-appends the category-mirror processing tag
(`listenable`/`watch`/`wotagei`) after stripping prior processing tags — which is why the
category mirror survives a replace, but **other** existing tags do not.

## Requirements

1. Replace the `if k == "tags" and incoming_category:` line's surrounding comment with one
   that states the asymmetry explicitly, e.g.:
   ```python
        # tags are UNION-merged only when the incoming item carries a category (the
        # category-tag mirror needs prior tags kept); otherwise incoming tags REPLACE
        # existing ones wholesale (re-tag passes recompute from scratch and rely on this).
        # A future partial-tags caller would clobber e.g. NSFW tags — change deliberately,
        # with tests, or send category alongside. Pinned by test_merge_upsert_tags_semantics.
   ```
   No logic change.
2. Add `test_merge_upsert_tags_semantics` to `tests/test_db.py` characterizing **current**
   behavior (fixtures: `conn` = connected in-memory DB; build items via
   `models.new_item(source=..., source_id=..., metadata={...})`):
   - Seed item with `metadata={"tags": ["nsfw_erotic", "memes"]}`.
   - `merge_upsert` the same fullname with `{"metadata": {"tags": ["kw1"]}}` (no category) →
     tags are now exactly `["kw1"]` (replace).
   - Re-seed a second item with `metadata={"tags": ["memes"]}`; merge incoming
     `{"metadata": {"tags": ["kw1"], "category": "listenable"}}` → tags contain
     `"memes"`, `"kw1"` **and** `"listenable"` (union + category mirror).
   - Note: when merging onto an existing row, a partial dict (`fullname` + the fields to
     overlay) is accepted — see how `categorize.tag_reddit_source` calls it.

## Constraints

- **Zero behavior change.** Comment + test only.

## Acceptance

`python -m pytest tests/test_db.py --basetemp .pytest-tmp -q`

## Output

Unified diff only (db.py comment + tests/test_db.py).
