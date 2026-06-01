"""Obsidian vault connector.

A vault is just a folder of Markdown files (+ an ``.obsidian/`` config dir). We walk
the folder, parse YAML frontmatter with a tiny stdlib parser (no PyYAML), and yield
one item per ``.md`` file.
"""

from __future__ import annotations

import datetime
import os
import re
from pathlib import Path

from content_hoarder.connectors.base import BaseConnector
from content_hoarder.models import new_item

_WIKILINK = re.compile(r"\[\[([^\]]+)\]\]")
_INLINE_TAG = re.compile(r"(?<![:/\w])#([\w\-/]+)")
_KV = re.compile(r"^(\w[\w\-]*):\s*(.*)$")


def _parse_frontmatter(text: str) -> tuple[dict, str]:
    """Return (frontmatter dict, body). Frontmatter only if the file starts with '---'."""
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}, text
    close = next((i for i in range(1, len(lines)) if lines[i].strip() == "---"), -1)
    if close == -1:
        return {}, text
    fm: dict = {}
    current_key: str | None = None
    for line in lines[1:close]:
        stripped = line.strip()
        if not stripped:
            continue
        if current_key is not None and stripped.startswith("- "):
            fm[current_key].append(stripped[2:].strip().strip("'\""))
            continue
        m = _KV.match(line)
        if not m:
            continue
        key, value = m.group(1), m.group(2).strip()
        if not value:
            fm[key] = []
            current_key = key
        elif value.startswith("[") and value.endswith("]"):
            fm[key] = [x.strip().strip("'\"") for x in value[1:-1].split(",") if x.strip()]
            current_key = None
        else:
            fm[key] = value.strip("'\"")
            current_key = None
    body = "\n".join(lines[close + 1 :])
    return fm, body


def _to_epoch(value, fallback: int) -> int:
    try:
        dt = datetime.datetime.fromisoformat(str(value).strip().strip("'\""))
        return int(dt.timestamp())
    except (ValueError, TypeError):
        return fallback


class ObsidianConnector(BaseConnector):
    id = "obsidian"
    label = "Obsidian"
    badge_color = "#7c3aed"

    def can_import(self, path: Path) -> bool:
        p = Path(path)
        if p.is_dir():
            if (p / ".obsidian").is_dir():
                return True
            return next(p.rglob("*.md"), None) is not None
        return str(p).lower().endswith(".md")

    def import_file(self, path: Path):
        if path.is_dir():
            vault_root = path
            files = []
            for dirpath, dirnames, filenames in os.walk(vault_root):
                dirnames[:] = [d for d in dirnames if d not in (".obsidian", ".trash")]
                files.extend(
                    Path(dirpath) / f for f in filenames if f.lower().endswith(".md")
                )
        else:
            vault_root = path.parent
            files = [path]

        for fp in files:
            try:
                text = fp.read_text(encoding="utf-8", errors="ignore")
                mtime = int(os.path.getmtime(fp))
            except OSError:
                continue

            fm, body = _parse_frontmatter(text)

            wikilinks = []
            for raw in _WIKILINK.findall(body):
                target = raw.split("#")[0].split("|")[0].strip()
                if target:
                    wikilinks.append(target)

            tags: list[str] = []
            fm_tags = fm.get("tags")
            if isinstance(fm_tags, list):
                tags.extend(str(t).strip() for t in fm_tags if str(t).strip())
            elif isinstance(fm_tags, str) and fm_tags.strip():
                tags.append(fm_tags.strip())
            tags.extend(_INLINE_TAG.findall(body))
            tags = list(dict.fromkeys(tags))  # unique, order-preserving

            title = fm.get("title") or fp.stem
            url = fm.get("url") or fm.get("source") or ""
            created = _to_epoch(fm.get("date") or fm.get("created"), mtime)
            source_id = fp.relative_to(vault_root).as_posix()

            yield new_item(
                source="obsidian",
                source_id=source_id,
                kind="note",
                title=title if isinstance(title, str) else str(title),
                body=body,
                url=url if isinstance(url, str) else "",
                created_utc=created,
                saved_utc=mtime,
                metadata={
                    "tags": tags,
                    "vault": vault_root.name,
                    "wikilinks": wikilinks,
                    "frontmatter": fm,
                },
            )
