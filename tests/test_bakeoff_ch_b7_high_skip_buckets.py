"""Bakeoff oracle — CH-B7: triage high-skip-bucket detection.

Contract: ``triage_score.high_skip_buckets(model, *, min_skip_rate=0.9,
min_support=2)`` returns the feature buckets of a fitted triage model whose
processed-rate is at or below ``1 - min_skip_rate`` (i.e. the buckets the user
almost never processes — "high skip").

* The function MUST accept a fitted model dict (as produced by
  ``triage_score.fit``) and return a list of dicts, one per qualifying bucket.
* Each returned dict MUST identify the bucket (its feature key) and report the
  bucket's ``n`` (support), ``k`` (processed count), ``processed_rate``, and
  ``skip_rate`` (where ``skip_rate = 1 - processed_rate``).
* A bucket with a high skip rate (``processed_rate`` near 0) and sufficient
  support (``n >= min_support``) MUST appear in the result.
* A bucket with a low skip rate (``processed_rate`` near 1) MUST NOT appear.
* A bucket with a high skip rate but support below ``min_support`` MUST NOT
  appear (low-confidence buckets are excluded).
* ``min_skip_rate`` and ``min_support`` MUST be honored when passed as keyword
  arguments.
"""

from content_hoarder import triage_score


def _model(features):
    """Build a minimal fitted-model dict shaped like triage_score.fit's output.

    ``features``: dict feature_key -> [n, k, rate].
    """
    return {
        "version": 1,
        "fitted_utc": 0,
        "trained_on": 100,
        "processed": 50,
        "prior": 0.5,
        "alpha": 50.0,
        "min_support": 2,
        "features": {key: [n, k, rate] for key, (n, k, rate) in features.items()},
    }


def test_high_skip_buckets_exists():
    assert hasattr(triage_score, "high_skip_buckets"), (
        "triage_score.high_skip_buckets must exist (CH-B7)"
    )


def test_high_skip_bucket_with_high_skip_rate_and_support_is_returned():
    model = _model(
        {
            "sub:highskip": [10, 0, 0.0],  # 10 items, 0 processed -> skip rate 1.0
            "sub:lowskip": [10, 10, 1.0],  # 10 items, all processed -> skip rate 0.0
        }
    )
    out = triage_score.high_skip_buckets(model, min_skip_rate=0.9, min_support=2)
    keys = [b["feature"] for b in out]
    assert "sub:highskip" in keys
    assert "sub:lowskip" not in keys


def test_high_skip_bucket_entry_has_required_fields():
    model = _model({"sub:highskip": [10, 1, 0.1]})  # skip rate 0.9
    out = triage_score.high_skip_buckets(model, min_skip_rate=0.9, min_support=2)
    assert out, "expected at least one bucket"
    entry = next(b for b in out if b["feature"] == "sub:highskip")
    assert entry["n"] == 10
    assert entry["k"] == 1
    assert abs(entry["processed_rate"] - 0.1) < 1e-9
    assert abs(entry["skip_rate"] - 0.9) < 1e-9


def test_low_support_high_skip_bucket_is_excluded():
    model = _model(
        {
            "sub:rare": [1, 0, 0.0],  # support 1, below min_support=2
            "sub:common": [10, 0, 0.0],
        }
    )
    out = triage_score.high_skip_buckets(model, min_skip_rate=0.9, min_support=2)
    keys = [b["feature"] for b in out]
    assert "sub:common" in keys
    assert "sub:rare" not in keys


def test_min_skip_rate_threshold_is_honored():
    model = _model(
        {
            "sub:boundary": [10, 1, 0.1],  # skip rate 0.9 — at threshold
            "sub:below": [10, 2, 0.2],  # skip rate 0.8 — below threshold
        }
    )
    out = triage_score.high_skip_buckets(model, min_skip_rate=0.9, min_support=2)
    keys = [b["feature"] for b in out]
    assert "sub:boundary" in keys
    assert "sub:below" not in keys


def test_min_support_keyword_is_honored():
    model = _model(
        {
            "sub:three": [3, 0, 0.0],
            "sub:two": [2, 0, 0.0],
        }
    )
    # min_support=3 must exclude the support-2 bucket.
    out = triage_score.high_skip_buckets(model, min_skip_rate=0.9, min_support=3)
    keys = [b["feature"] for b in out]
    assert "sub:three" in keys
    assert "sub:two" not in keys
