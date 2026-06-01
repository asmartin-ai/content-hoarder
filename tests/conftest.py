import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

FIXTURES = ROOT / "fixtures"


@pytest.fixture
def conn():
    from content_hoarder import db
    c = db.connect(":memory:")
    try:
        yield c
    finally:
        c.close()


@pytest.fixture
def fixtures():
    return FIXTURES


@pytest.fixture
def tmp_db(tmp_path):
    return str(tmp_path / "t.db")
