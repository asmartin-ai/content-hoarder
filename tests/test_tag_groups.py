"""Epic 26 P2: parent/child tag grouping for the browse rail.

TAG_GROUPS is presentation-only (the underlying tags stay flat for search/FTS). These lock its
validity: every child must be a curated FILTER_TAG, groups must be disjoint, and they must cover
FILTER_TAGS exactly — so adding a new curated tag forces grouping it, and a typo'd child fails
fast here instead of silently dropping into the rail's "More" bucket.
"""
from content_hoarder import categorize
from content_hoarder.web import create_app


def _grouped_tags():
    return [t for _label, tags in categorize.TAG_GROUPS for t in tags]


def test_every_grouped_tag_is_curated():
    for t in _grouped_tags():
        assert t in categorize.FILTER_TAGS, t


def test_groups_are_disjoint():
    seen = _grouped_tags()
    assert len(seen) == len(set(seen)), "a tag appears in more than one group"


def test_groups_cover_filter_tags_exactly():
    # completeness: every curated facet has a parent (nothing orphaned to the rail's "More")
    assert set(_grouped_tags()) == set(categorize.FILTER_TAGS)


def test_tag_groups_payload_shape():
    payload = categorize.tag_groups()
    assert isinstance(payload, list) and payload
    for g in payload:
        assert set(g) == {"label", "tags"}
        assert isinstance(g["label"], str) and g["label"]
        assert all(t in categorize.FILTER_TAGS for t in g["tags"])


def test_tags_endpoint_includes_groups(tmp_db):
    cl = create_app(tmp_db).test_client()
    r = cl.get("/tags")
    assert r.status_code == 200
    data = r.get_json()
    assert "groups" in data
    assert "Gaming" in [g["label"] for g in data["groups"]]
    assert data["groups"] == categorize.tag_groups()  # served == source map
