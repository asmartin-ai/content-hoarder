# Harden .env loading against BOM / non-UTF-8 bytes

## Model: devstral

`src/content_hoarder/config.py` reads `.env` with strict UTF-8. On Windows, a `.env` saved by
Notepad gets a UTF-8 BOM (the first key becomes `﻿KEY` and silently stops matching), and
a stray non-UTF-8 byte crashes startup entirely — even though the shell environment should
have been a sufficient fallback.

## Context — current code (src/content_hoarder/config.py)

```python
def load_env(path: str | os.PathLike | None = None) -> None:
    """Load ``KEY=VALUE`` lines from a .env file into os.environ.

    Existing environment variables are never overwritten. Lines that are blank,
    comments (``#``), or lack ``=`` are ignored. Surrounding quotes are stripped.
    """
    env_path = Path(path) if path else Path(".env")
    if not env_path.is_file():
        return
    for raw in env_path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value
```

## Requirements

1. Read with `encoding="utf-8-sig"` (transparently strips a BOM) and `errors="replace"`
   (a bad byte degrades to U+FFFD in that one value instead of crashing the app).
2. Wrap the `read_text` call in `try/except OSError: return` (an unreadable file behaves
   like a missing one). One short why-comment covering BOM-via-Notepad + the fallback intent.
3. Tests — there is no test_config.py yet; create `tests/test_config.py` (conftest already
   puts `src/` on `sys.path`; use the `tmp_path` and `monkeypatch` pytest fixtures):
   - BOM: write `b'\xef\xbb\xbfFOO_BOM_TEST=1\n'` to a tmp file; `monkeypatch.delenv` the
     key if present; `config.load_env(path)`; assert `os.environ["FOO_BOM_TEST"] == "1"`
     (then clean up with `monkeypatch` so the env doesn't leak).
   - Bad byte: write `b'FOO_BAD_TEST=a\xffb\n'`; `load_env` must not raise and the key must
     be set (value contains the replacement char — just assert it exists and starts with "a").
   - Existing env wins: pre-set a key via `monkeypatch.setenv`, file has a different value,
     assert it is not overwritten (pins current behavior).

## Constraints

- Signature and "environment always wins" semantics unchanged.
- No new dependencies (no python-dotenv).

## Acceptance

`python -m pytest tests/test_config.py --basetemp .pytest-tmp -q`

## Output

Unified diff only (config.py + new tests/test_config.py).
