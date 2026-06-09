"""Hardening tests for .env loading (delegation/07): BOM, bad bytes, env precedence."""

import os

import pytest

from content_hoarder import config


@pytest.fixture(autouse=True)
def isolate_os_environ(monkeypatch):
    """Give each test a fresh os.environ copy so load_env mutations don't leak."""
    monkeypatch.setattr(os, "environ", os.environ.copy())


def test_load_env_strips_bom(tmp_path):
    p = tmp_path / ".env"
    p.write_bytes(b"\xef\xbb\xbfFOO_BOM_TEST=1\n")  # Notepad-style UTF-8 BOM
    config.load_env(p)
    assert os.environ["FOO_BOM_TEST"] == "1"


def test_load_env_bad_byte_does_not_crash(tmp_path):
    p = tmp_path / ".env"
    p.write_bytes(b"FOO_BAD_TEST=a\xffb\n")
    config.load_env(p)  # must not raise
    assert os.environ["FOO_BAD_TEST"].startswith("a")


def test_load_env_existing_env_wins(monkeypatch, tmp_path):
    monkeypatch.setenv("FOO_WINS_TEST", "keep")
    p = tmp_path / ".env"
    p.write_text("FOO_WINS_TEST=other\n")
    config.load_env(p)
    assert os.environ["FOO_WINS_TEST"] == "keep"
