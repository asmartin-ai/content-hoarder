import json

from content_hoarder import db, models
from content_hoarder.categorize import categorize, categorize_source


def test_categorize_rules():
    assert categorize("Isaac Arthur: Dyson Spheres", "Isaac Arthur", 120) == "listenable"  # channel beats short
    assert categorize("Two hour talk", "Random Channel", 7200) == "listenable"
    assert categorize("Quick clip", "Random", 60) == "watch"
    assert categorize("ヲタ芸 freestyle", "x", 60) == "wotagei"
    assert categorize("Epic WOTA performance", "x", 7200) == "wotagei"  # keyword beats duration
    assert categorize("Mid-length video", "Random", 900) == "unknown"
    assert categorize("No duration", "Random", None) == "unknown"


def test_categorize_source_sets_category(tmp_db):
    conn = db.connect(tmp_db)
    db.merge_upsert(conn, models.new_item(source="youtube", source_id="v_long", kind="video",
                    title="Long talk", metadata={"channel": "Random", "duration": 4000}))
    db.merge_upsert(conn, models.new_item(source="youtube", source_id="v_short", kind="video",
                    title="Short clip", metadata={"channel": "Random", "duration": 45}))
    conn.commit()
    res = categorize_source(conn)
    assert res["selected"] == 2
    assert res["by_category"]["listenable"] == 1 and res["by_category"]["watch"] == 1
    item = db.get_item(conn, "youtube:v_long")
    assert json.loads(item["metadata"])["category"] == "listenable"
