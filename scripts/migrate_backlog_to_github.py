"""Migrate BACKLOG.md active items to GitHub Issues.

This script is intentionally conservative:
- parses top-level unchecked/half-open backlog items only;
- skips completed history;
- can archive the current monolithic backlog into per-epic docs;
- creates labels/milestones/issues with gh, but only when --apply is passed;
- writes a JSON mapping so BACKLOG.md can become a compact index.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import textwrap
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
BACKLOG = ROOT / "BACKLOG.md"
OUT_DIR = ROOT / "docs" / "backlog"
MAP_PATH = OUT_DIR / "github-issues.json"

EPIC_RE = re.compile(r"^## Epic (?P<num>\d+) — (?P<title>.+?)(?:\s+`|\s+\(|$)")
ITEM_RE = re.compile(r"^- \[(?P<state>[ ~])\]\s+(?P<body>.*)")
TITLE_RE = re.compile(r"\*\*(?P<title>.+?)\*\*")
LABELS_RE = re.compile(r"`([^`]+)`")

AREA_BY_EPIC = {
    1: "youtube",
    2: "youtube",
    3: "recovery",
    4: "recovery",
    5: "ui",
    6: "ui",
    7: "connectors",
    8: "infra",
    9: "reddit",
    10: "triage",
    11: "dedup",
    12: "search",
    13: "ui",
    14: "ui",
    15: "reddit",
    16: "mobile",
    17: "ui",
    18: "youtube",
    19: "backend",
    20: "ui",
    21: "triage",
    22: "triage",
    23: "design",
    24: "reddit",
    25: "reddit",
    26: "tags",
}

PRIORITY_RE = re.compile(r"\b(P[0-3])\b")

LABEL_DEFS = {
    "priority:P0": ("b60205", "Must fix immediately"),
    "priority:P1": ("d93f0b", "High priority"),
    "priority:P2": ("fbca04", "Medium priority"),
    "priority:P3": ("0e8a16", "Low priority / someday"),
    "type:bug": ("d73a4a", "Bug or regression"),
    "type:enhancement": ("a2eeef", "Feature or enhancement"),
    "type:research": ("5319e7", "Research or decision gate"),
    "type:chore": ("cfd3d7", "Chore / maintenance"),
    "type:icebox": ("eeeeee", "Deferred until reactivated"),
    "area:backend": ("1d76db", "Backend / data layer"),
    "area:connectors": ("1d76db", "Import connectors / sync"),
    "area:dedup": ("1d76db", "Deduplication / consolidation"),
    "area:design": ("c5def5", "Design language / visual design"),
    "area:infra": ("c5def5", "Infra / tooling / performance"),
    "area:mobile": ("0e8a16", "Mobile / PWA UX"),
    "area:recovery": ("fbca04", "Content/media recovery"),
    "area:reddit": ("ff7619", "Reddit-specific behavior"),
    "area:search": ("0052cc", "Search and operators"),
    "area:tags": ("5319e7", "Tags / categories / folders"),
    "area:triage": ("0e8a16", "Triage / scoring / decay"),
    "area:ui": ("7057ff", "Frontend UI"),
    "area:youtube": ("fbca04", "YouTube-specific behavior"),
    "needs:design": ("f9d0c4", "Needs design decision/review"),
    "needs:real-device": ("f9d0c4", "Needs physical device validation"),
    "needs:sample-data": ("f9d0c4", "Needs representative sample data"),
    "needs:live-smoke": ("f9d0c4", "Needs live smoke against copied data"),
    "needs:user-decision": ("f9d0c4", "Needs user decision before implementation"),
    "safety:external-action": ("b60205", "Touches irreversible/external action"),
    "safety:live-network": ("b60205", "Live network/API behavior"),
    "sandbox:local-spec": ("bfd4f2", "Detailed context is in repo docs"),
}


@dataclass
class Epic:
    num: int
    title: str
    body: str
    slug: str
    area: str


@dataclass
class IssueSpec:
    key: str
    title: str
    state: str
    epic_num: int
    epic_title: str
    milestone: str
    labels: list[str]
    body: str
    local_history: str
    number: int | None = None
    url: str | None = None


def slugify(s: str) -> str:
    s = s.lower()
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s[:80].strip("-") or "item"


def clean_title(raw: str) -> str:
    raw = re.sub(r"^P[0-3]\s+[—-]\s+", "", raw.strip())
    raw = raw.replace("~~", "")
    raw = raw.replace("✅", "").strip()
    return raw.rstrip(".")


def item_title(first_line: str) -> str:
    m = TITLE_RE.search(first_line)
    if m:
        return clean_title(m.group("title"))
    return clean_title(re.sub(r"^- \[[ ~]\]\s+", "", first_line))[:120]


def infer_labels(epic: Epic, title: str, body: str, state: str) -> list[str]:
    labels: set[str] = set()
    area = AREA_BY_EPIC.get(epic.num, epic.area or "ui")
    labels.add(f"area:{area}")
    if state == "~":
        labels.add("type:enhancement")
    low = (title + "\n" + body).lower()
    if (
        "bug" in low
        or "not working" in low
        or "misleading" in low
        or "regression" in low
    ):
        labels.add("type:bug")
    elif "research" in low or "spike" in low or "investigate" in low or "audit" in low:
        labels.add("type:research")
    elif "chore" in low or epic.num in {8, 23}:
        labels.add("type:chore")
    else:
        labels.add("type:enhancement")
    pr = PRIORITY_RE.search(title + " " + body)
    labels.add(f"priority:{pr.group(1) if pr else 'P3'}")
    if "icebox" in low:
        labels.add("type:icebox")
    if "design" in low or "visual" in low or "glm" in low or "figma" in low:
        labels.add("needs:design")
    if "real-device" in low or "pixel" in low or "physical" in low:
        labels.add("needs:real-device")
    if "sample" in low or "representative" in low:
        labels.add("needs:sample-data")
    if "live smoke" in low or "live-smoke" in low:
        labels.add("needs:live-smoke")
    if "user decision" in low or "approved" in low or "approval" in low:
        labels.add("needs:user-decision")
    if (
        "unsave" in low
        or "archive.today" in low
        or "redgifs" in low
        or "live reddit" in low
    ):
        labels.add("safety:external-action")
    if (
        "network" in low
        or "api" in low
        or "oauth" in low
        or "archive.today" in low
        or "redgifs" in low
    ):
        labels.add("safety:live-network")
    labels.add("sandbox:local-spec")
    return sorted(labels)


def public_summary(item_md: str) -> str:
    """Compact public summary; full historical detail remains in docs/backlog/."""
    text = re.sub(r"^- \[[ ~]\]\s+", "", item_md.strip())
    text = re.sub(r"\*\*", "", text)
    text = re.sub(r"~~", "", text)
    text = text.replace(
        "“People who bring your dog literally everywhere, why?”",
        "a text-only Reddit self-post",
    )
    text = text.replace(
        '"People who bring your dog literally everywhere, why?"',
        "a text-only Reddit self-post",
    )
    text = re.sub(r"\s+", " ", text).strip()
    return text[:700].rstrip() + ("…" if len(text) > 700 else "")


def issue_body(epic: Epic, title: str, item_md: str, local_history: str) -> str:
    summary = public_summary(item_md)
    return textwrap.dedent(
        f"""
        Migrated from `BACKLOG.md`.

        ## Summary

        {summary}

        ## Local context for agents

        - Epic: {epic.num} — {epic.title}
        - Full local history/spec: `{local_history}`
        - Project guardrails: see `AGENTS.md`.

        ## Acceptance criteria

        - [ ] Confirm current behavior / repro where applicable.
        - [ ] Implement the smallest safe change that satisfies the issue.
        - [ ] Add or update focused offline tests where practical.
        - [ ] For mobile/UI work, run or update targeted Playwright coverage; use real-device validation when tagged `needs:real-device`.
        - [ ] Update the GitHub issue and local backlog history if scope/status changes.

        ## Privacy note

        This repository is public. Keep private data, live DB contents, credentials, and personal exports out of issue comments and fixtures.
        """
    ).strip()


def parse_backlog() -> tuple[list[Epic], list[IssueSpec]]:
    text = BACKLOG.read_text(encoding="utf-8")
    lines = text.splitlines()
    epics: list[Epic] = []
    cur_start = 0
    cur_num = None
    cur_title = ""
    for i, line in enumerate(lines):
        m = EPIC_RE.match(line)
        if m:
            if cur_num is not None:
                body = "\n".join(lines[cur_start:i]).rstrip() + "\n"
                area = AREA_BY_EPIC.get(cur_num, "ui")
                epics.append(
                    Epic(
                        cur_num,
                        cur_title,
                        body,
                        f"epic-{cur_num:02d}-{slugify(cur_title)}",
                        area,
                    )
                )
            cur_num = int(m.group("num"))
            cur_title = m.group("title").strip()
            cur_start = i
    if cur_num is not None:
        body = "\n".join(lines[cur_start:]).rstrip() + "\n"
        area = AREA_BY_EPIC.get(cur_num, "ui")
        epics.append(
            Epic(
                cur_num,
                cur_title,
                body,
                f"epic-{cur_num:02d}-{slugify(cur_title)}",
                area,
            )
        )

    by_num = {e.num: e for e in epics}
    issues: list[IssueSpec] = []
    current_epic: Epic | None = None
    item_lines: list[str] = []
    item_state = ""

    def flush_item() -> None:
        nonlocal item_lines, item_state, current_epic
        if not current_epic or not item_lines:
            item_lines = []
            item_state = ""
            return
        md = "\n".join(item_lines).rstrip()
        title = item_title(item_lines[0])
        # Skip notes/catch-alls that are duplicated by specific actionable issues.
        if title.startswith("Needs the API") or title.startswith("port note for Epic"):
            item_lines = []
            item_state = ""
            return
        key = f"epic-{current_epic.num:02d}-{slugify(title)}"
        local_history = f"docs/backlog/{current_epic.slug}.md"
        labels = infer_labels(current_epic, title, md, item_state)
        issues.append(
            IssueSpec(
                key=key,
                title=title,
                state=item_state,
                epic_num=current_epic.num,
                epic_title=current_epic.title,
                milestone=f"Epic {current_epic.num} — {current_epic.title}",
                labels=labels,
                body=issue_body(current_epic, title, md, local_history),
                local_history=local_history,
            )
        )
        item_lines = []
        item_state = ""

    for line in lines:
        em = EPIC_RE.match(line)
        if em:
            flush_item()
            current_epic = by_num[int(em.group("num"))]
            continue
        im = ITEM_RE.match(line)
        if im:
            flush_item()
            item_state = "~" if im.group("state") == "~" else " "
            item_lines = [line]
            continue
        if item_lines:
            if line.startswith("## Epic "):
                flush_item()
            elif line.startswith("- [x]"):
                flush_item()
            else:
                item_lines.append(line)
    flush_item()
    return epics, issues


def run_gh(
    args: list[str], *, input_text: str | None = None, check: bool = True
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["gh", *args],
        input=input_text,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=ROOT,
        check=check,
    )


def archive_epics(epics: list[Epic]) -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for e in epics:
        path = OUT_DIR / f"{e.slug}.md"
        path.write_text(e.body, encoding="utf-8")
    readme = "# Backlog history\n\nThis directory stores the split historical backlog. `BACKLOG.md` is the compact active index; GitHub Issues are the active tracker.\n\n"
    for e in epics:
        readme += f"- [Epic {e.num} — {e.title}]({e.slug}.md)\n"
    (OUT_DIR / "README.md").write_text(readme, encoding="utf-8")


def ensure_labels(apply: bool) -> None:
    if not apply:
        return
    existing_raw = run_gh(
        ["label", "list", "--limit", "300", "--json", "name"], check=True
    ).stdout
    existing = {x["name"] for x in json.loads(existing_raw)}
    for name, (color, desc) in LABEL_DEFS.items():
        if name in existing:
            continue
        run_gh(
            ["label", "create", name, "--color", color, "--description", desc],
            check=True,
        )


def ensure_milestones(epics: list[Epic], apply: bool) -> None:
    if not apply:
        return
    existing_raw = run_gh(
        ["api", "repos/asmartin-ai/content-hoarder/milestones", "--paginate"],
        check=True,
    ).stdout
    existing = {m["title"] for m in json.loads(existing_raw)}
    for e in epics:
        title = f"Epic {e.num} — {e.title}"
        if title in existing:
            continue
        run_gh(
            [
                "api",
                "repos/asmartin-ai/content-hoarder/milestones",
                "-f",
                f"title={title}",
                "-f",
                f"description=Backlog epic migrated from BACKLOG.md. Local history: docs/backlog/{e.slug}.md",
            ],
            check=True,
        )


def create_issues(
    issues: list[IssueSpec], apply: bool, limit: int | None = None
) -> list[IssueSpec]:
    selected = issues[:limit] if limit else issues
    if not apply:
        return selected
    existing_raw = run_gh(
        [
            "issue",
            "list",
            "--state",
            "all",
            "--limit",
            "1000",
            "--json",
            "number,title,url",
        ],
        check=True,
    ).stdout
    existing = {x["title"]: x for x in json.loads(existing_raw)}
    out: list[IssueSpec] = []
    for spec in selected:
        if spec.title in existing:
            hit = existing[spec.title]
            spec.number = hit["number"]
            spec.url = hit["url"]
            out.append(spec)
            continue
        args = [
            "issue",
            "create",
            "--title",
            spec.title,
            "--body",
            spec.body,
            "--milestone",
            spec.milestone,
        ]
        for label in spec.labels:
            args += ["--label", label]
        cp = run_gh(args, check=True)
        url = cp.stdout.strip().splitlines()[-1]
        spec.url = url
        m = re.search(r"/(\d+)$", url)
        spec.number = int(m.group(1)) if m else None
        out.append(spec)
    return out


def write_mapping(issues: list[IssueSpec]) -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    MAP_PATH.write_text(
        json.dumps([asdict(i) for i in issues], indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def write_compact_backlog(epics: list[Epic], issues: list[IssueSpec]) -> None:
    by_epic: dict[int, list[IssueSpec]] = {}
    for i in issues:
        by_epic.setdefault(i.epic_num, []).append(i)
    text = textwrap.dedent(
        """
        # content-hoarder — backlog index

        Active work is tracked in GitHub Issues. Historical/as-built backlog detail is split under
        `docs/backlog/` so sandboxed and delegated agents can still work offline without reading one
        monolithic file.

        - GitHub repo: https://github.com/asmartin-ai/content-hoarder
        - Issue mapping: `docs/backlog/github-issues.json`
        - History index: `docs/backlog/README.md`
        - Current delegation queue: `delegation/NEXT-DELEGATION.md`

        ## How to use this file

        1. Start here for the epic/issue index.
        2. Open the GitHub issue for active status and discussion.
        3. If an agent is sandboxed/offline, use the linked `docs/backlog/epic-*.md` file plus the issue
           body copied into the task prompt.
        4. Keep private data, live DB details, credentials, and personal exports out of GitHub Issues.

        """
    ).lstrip()
    for e in epics:
        items = by_epic.get(e.num, [])
        text += f"## Epic {e.num} — {e.title}\n\n"
        text += f"- History: `docs/backlog/{e.slug}.md`\n"
        text += f"- Milestone: https://github.com/asmartin-ai/content-hoarder/milestone/{e.num}\n"
        if items:
            text += "- Active issues:\n"
            for i in sorted(items, key=lambda x: (x.number or 999999, x.title)):
                num = f"#{i.number}" if i.number else "(not created)"
                text += f"  - {num} — {i.title}\n"
        else:
            text += "- Active issues: none currently migrated.\n"
        text += "\n"
    BACKLOG.write_text(text, encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--apply",
        action="store_true",
        help="Create labels, milestones, and issues on GitHub",
    )
    ap.add_argument(
        "--archive", action="store_true", help="Write docs/backlog split history files"
    )
    ap.add_argument(
        "--compact-backlog",
        action="store_true",
        help="Replace BACKLOG.md with compact issue index",
    )
    ap.add_argument(
        "--limit", type=int, default=None, help="Create only the first N parsed issues"
    )
    args = ap.parse_args()

    epics, issues = parse_backlog()
    print(
        json.dumps(
            {"epics": len(epics), "issues": len(issues), "apply": args.apply}, indent=2
        )
    )
    counts: dict[str, int] = {}
    for issue in issues:
        counts[issue.milestone] = counts.get(issue.milestone, 0) + 1
    for milestone, count in sorted(counts.items()):
        print(f"{count:3d}  {milestone}")
    if args.archive:
        archive_epics(epics)
    ensure_labels(args.apply)
    ensure_milestones(epics, args.apply)
    migrated = create_issues(issues, args.apply, args.limit)
    write_mapping(migrated if args.limit else issues)
    if args.compact_backlog:
        # Reload issue numbers from mapping if this run created them.
        write_compact_backlog(epics, migrated if args.limit else issues)
    print(f"mapping: {MAP_PATH.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
