"""Command-line interface: init-db, import, enrich, serve, stats, sources, bankruptcy, decay, promote."""

from __future__ import annotations

import argparse
import datetime
import json
import sys

from content_hoarder import config


def _connect():
    from content_hoarder import db
    return db.connect()


def cmd_init_db(args) -> int:
    from content_hoarder import db
    with _connect() as conn:
        backfilled = db.normalize_processing_tags(conn)  # one-time legacy category→tag mirror
        conn.commit()
    note = f" (backfilled {backfilled} processing-tag rows)" if backfilled else ""
    print(f"Initialized database at {config.db_path()}{note}")
    return 0


def cmd_import(args) -> int:
    from content_hoarder import pipeline
    with _connect() as conn:
        res = pipeline.import_path(
            conn, args.path, source=args.source, enrich=args.enrich
        )
    print(f"imported={res.imported} skipped={res.skipped} errors={len(res.errors)}")
    for err in res.errors[:10]:
        print("  !", err)
    return 0


def cmd_enrich(args) -> int:
    from content_hoarder import enrich as enrich_mod
    with _connect() as conn:
        if getattr(args, "archives", False) or getattr(args, "scores", False):
            from content_hoarder.archival import service as archival
            scope = "all" if getattr(args, "scores", False) else "removed"
            n = archival.count_targets(conn, retry=args.all, scope=scope)
            what = "to hydrate (score/content)" if scope == "all" else "need recovery"
            print(f"{n} reddit item(s) {what}; querying archives...", file=sys.stderr)
            res = archival.recover(conn, limit=args.limit, retry=args.all, scope=scope,
                                   progress=lambda m: print(m, file=sys.stderr))
        elif getattr(args, "titles", False):
            from content_hoarder import youtube_recover
            res = youtube_recover.recover_titles(conn, limit=args.limit, retry=args.all,
                                                 progress=lambda m: print(m, file=sys.stderr))
        elif args.source:
            res = enrich_mod.enrich_source(conn, args.source, all_rows=args.all, limit=args.limit)
        else:
            res = enrich_mod.enrich_all(conn, all_rows=args.all)
    print(json.dumps(res, indent=2))
    return 0


def cmd_categorize(args) -> int:
    from content_hoarder import categorize as cat_mod
    with _connect() as conn:
        if (args.source or "").lower() == "reddit":
            # Reddit gets multi-label tags (metadata.tags); --dry-run previews accuracy.
            res = cat_mod.tag_reddit_source(conn, limit=args.limit, retry=args.all,
                                            dry_run=args.dry_run)
        elif args.topics:
            res = cat_mod.tag_youtube_source(conn, limit=args.limit, retry=args.all,
                                             dry_run=args.dry_run)
        else:
            res = cat_mod.categorize_source(conn, args.source or "youtube",
                                            limit=args.limit, retry=args.all)
    print(json.dumps(res, indent=2, ensure_ascii=False))
    return 0


def cmd_dedup(args) -> int:
    from content_hoarder import dedup as dd
    with _connect() as conn:
        if args.clear:
            res = dd.clear_flags(conn)
        elif args.resolve:
            res = dd.auto_resolve(conn, by=args.by)
        else:
            res = dd.flag_duplicates(conn, by=args.by)
    print(json.dumps(res, indent=2))
    if not args.clear and not args.resolve and res.get("groups"):
        print(f"(flagged {res['flagged']} items in {res['groups']} possible-duplicate groups — "
              f"`dedup --resolve` to auto-archive all-but-richest, or `dedup --clear`)",
              file=sys.stderr)
    return 0


def cmd_migrate_firefox_tabs(args) -> int:
    from content_hoarder import firefox_youtube as fy
    with _connect() as conn:
        res = fy.migrate(conn, apply=args.apply)
    print(json.dumps(res, indent=2))
    if not args.apply:
        print(f"(dry run — {res['dupes']} dupes + {res['orphans']} orphans would become youtube "
              f"items and {res['dupes'] + res['orphans']} firefox rows removed; re-run with "
              f"--apply to commit. Run against a COPY of the DB first.)", file=sys.stderr)
    return 0


def cmd_migrate_rsm_threads(args) -> int:
    from content_hoarder import rsm_threads
    with _connect() as conn:
        res = rsm_threads.migrate_threads(conn, args.from_db, only_existing=not args.all_threads)
    print(json.dumps(res, indent=2))
    return 0


def cmd_consolidate(args) -> int:
    from content_hoarder import consolidate
    with _connect() as conn:
        if args.undo:
            res = consolidate.unconsolidate(conn, apply=args.apply)
        else:
            res = consolidate.migrate(conn, apply=args.apply)
    print(json.dumps(res, indent=2))
    if not args.apply:
        if args.undo:
            print(
                f"(dry run — would clear companions/unmark consolidated rows and delete promoted "
                f"youtube rows across {res['candidates']} candidate item(s); re-run with --apply to "
                f"commit. Run against a COPY of the DB first.)",
                file=sys.stderr,
            )
        else:
            print(
                f"(dry run — {res['foldable']} item(s) would fold into existing youtube rows; "
                f"{res['promoted']} item(s) link to not-yet-saved YouTube videos and would be promoted into "
                f"{res['youtube_created']} new youtube item(s); re-run with --apply to commit. "
                f"Run against a COPY of the DB first.)",
                file=sys.stderr,
            )
    return 0


def cmd_serve(args) -> int:
    from content_hoarder.web import create_app
    app = create_app()
    host = args.host or config.host()
    port = args.port or config.port()
    print(f"Serving on http://{host}:{port}/  (Ctrl+C to stop)")
    app.run(host=host, port=port, debug=False)
    return 0


def cmd_stats(args) -> int:
    from content_hoarder import db
    with _connect() as conn:
        print(json.dumps(db.get_counts(conn), indent=2))
    return 0


def cmd_sources(args) -> int:
    from content_hoarder import connectors
    for c in connectors.all_connectors():
        deferred = " (deferred)" if c.id == "firefox" else ""
        print(f"{c.id:11} {c.label}{deferred}")
    return 0


def cmd_bankruptcy(args) -> int:
    from content_hoarder import db
    before_utc, rc = _parse_date(args.before, "--before")
    if rc:
        return rc
    with _connect() as conn:
        n = db.bankruptcy(conn, before_utc, source=args.source, dry_run=args.dry_run)
    verb = "would archive" if args.dry_run else "archived"
    print(f"{verb} {n} inbox item(s) older than {args.before}")
    return 0


def _parse_date(value: str | None, flag: str) -> tuple[int | None, int]:
    """YYYY-MM-DD (or full ISO) -> epoch seconds; (None, 0) when the flag is unset.
    Returns (value, exit_code) — exit_code 2 means the caller should bail."""
    if value is None:
        return None, 0
    try:
        return int(datetime.datetime.fromisoformat(value).timestamp()), 0
    except ValueError:
        print(f"error: {flag} must be YYYY-MM-DD (got {value!r})", file=sys.stderr)
        return None, 2


def cmd_decay(args) -> int:
    from content_hoarder import db
    if args.undo:
        if args.tag or args.subreddit or args.before:
            print("error: --tag/--subreddit/--before don't apply to --undo; "
                  "select a wave with --decayed-after/--decayed-before", file=sys.stderr)
            return 2
        after_utc, rc = _parse_date(args.decayed_after, "--decayed-after")
        if rc:
            return rc
        before_utc, rc = _parse_date(args.decayed_before, "--decayed-before")
        if rc:
            return rc
        with _connect() as conn:
            res = db.undecay(conn, decayed_after=after_utc, decayed_before=before_utc,
                             apply=args.apply)
        print(json.dumps(res, indent=2))
        if not args.apply:
            print(f"(dry run — {res['total']} decayed item(s) would return to inbox; "
                  f"re-run with --apply to commit.)", file=sys.stderr)
        return 0

    if not (args.tag or args.subreddit or args.before):
        print("error: decay needs at least one selector: --tag, --subreddit, or --before",
              file=sys.stderr)
        return 2
    before_utc, rc = _parse_date(args.before, "--before")
    if rc:
        return rc
    from content_hoarder.categorize import FILTER_TAGS
    unknown = [t for t in (args.tag or []) if t not in FILTER_TAGS]
    if unknown:
        print(f"warning: tag(s) not in the curated vocabulary (typo?): {', '.join(unknown)}",
              file=sys.stderr)
    with _connect() as conn:
        res = db.decay(conn, tags=args.tag, subreddits=args.subreddit,
                       before_utc=before_utc, source=args.source, label=args.label,
                       apply=args.apply)
    print(json.dumps(res, indent=2))
    if not args.apply:
        print(f"(dry run — {res['total']} inbox item(s) would decay to archived; re-run with "
              f"--apply to commit. Run against a COPY of the DB first.)", file=sys.stderr)
    return 0


def cmd_promote(args) -> int:
    from content_hoarder.bridge import karakeep
    with _connect() as conn:
        res = karakeep.promote(
            conn, status=args.status, limit=args.limit, dry_run=args.dry_run
        )
    if not res.get("configured"):
        print(f"Karakeep not configured (set KARAKEEP_BASE_URL + KARAKEEP_API_KEY). "
              f"{res['candidates']} item(s) with status={args.status} are ready to push.")
        return 0
    print(json.dumps(res, indent=2))
    return 0


def cmd_delete(args) -> int:
    """PERMANENT delete with the money-action safety shape: dry-run is the default and
    the confirmation surface; --apply alone refuses (exit 3); --apply --yes executes
    after an automatic timestamped backup, then appends to the audit log."""
    import datetime as _dt
    import sqlite3 as _sqlite3
    import time as _time
    from pathlib import Path

    from content_hoarder import config, db
    if not (args.tag or args.subreddit or args.before or args.fullname
            or args.swept or args.status):
        print("error: delete needs at least one selector "
              "(--tag/--subreddit/--before/--fullname/--swept/--status)", file=sys.stderr)
        return 2
    before_utc, rc = _parse_date(args.before, "--before")
    if rc:
        return rc

    selectors = dict(tags=args.tag, subreddits=args.subreddit, before_utc=before_utc,
                     source=args.source, status=args.status, swept=args.swept,
                     fullnames=args.fullname, also_unsave=args.also_unsave)
    with _connect() as conn:
        plan = db.delete_items(conn, **selectors, apply=False)
        if not args.apply:
            print(json.dumps(plan, indent=2))
            print(f"(dry run — {plan['total']} item(s) would be PERMANENTLY deleted; "
                  f"re-run with --apply --yes to commit. Irreversible except via the "
                  f"automatic backup.)", file=sys.stderr)
            return 0
        if not args.yes:
            print(json.dumps(plan, indent=2))
            print("refusing: a hard delete needs BOTH --apply and --yes.", file=sys.stderr)
            return 3

        stamp = _dt.datetime.now().strftime("%Y%m%d-%H%M%S")
        bak = Path(config.db_path()).with_name(f"app.backup-pre-delete-{stamp}.db")
        dst = _sqlite3.connect(str(bak))
        with dst:
            conn.backup(dst)
        dst.close()

        res = db.delete_items(conn, **selectors, apply=True, max_rows=args.max)
        res["backup"] = str(bak)

        audit_path = Path(config.db_path()).with_name("delete-audit.jsonl")
        audit = {"ts": int(_time.time()), "selectors": {k: v for k, v in selectors.items()
                                                        if v not in (None, False)},
                 "total": res["total"], "threads_deleted": res["threads_deleted"],
                 "unsave_enqueued": res["unsave_enqueued"], "backup": str(bak),
                 "sample": res["sample"]}
        with audit_path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(audit, ensure_ascii=False) + "\n")
    print(json.dumps(res, indent=2))
    return 0


def cmd_export(args) -> int:
    from pathlib import Path

    from content_hoarder import db, export
    with _connect() as conn:
        rows = db.search_items(conn, "", source=args.source, status=args.status,
                               tags=args.tag or None, subreddit=args.subreddit,
                               limit=1_000_000)
    recs = export.export_records(rows)
    text = (json.dumps(recs, ensure_ascii=False, indent=2)
            if args.format == "json" else export.to_csv(recs))
    Path(args.out).write_text(text, encoding="utf-8")
    print(f"exported {len(recs)} item(s) -> {args.out}")
    return 0


def cmd_export_obsidian(args) -> int:
    from content_hoarder import export
    with _connect() as conn:
        res = export.obsidian_export(conn, args.vault, status=args.status)
    print(f"exported {res['exported']} note(s) to {res['vault']}")
    return 0


def cmd_suggest(args) -> int:
    from content_hoarder.assist import llm
    with _connect() as conn:
        res = llm.suggest_inbox(conn, source=args.source, limit=args.limit)
    print(json.dumps(res, indent=2))
    return 0


def cmd_reddit_sync(args) -> int:
    from content_hoarder import reddit_sync
    max_pages = args.max_pages if args.max_pages else (50 if args.full else 3)
    with _connect() as conn:
        res = reddit_sync.sync_saved_cookie(
            conn, max_pages=max_pages, stop_on_known=not args.full,
            progress=lambda m: print(m, file=sys.stderr),
        )
    print(json.dumps(res, indent=2))
    # Non-zero for network errors too, so a scheduled run is visibly unhealthy; the
    # printed JSON distinguishes auth_error (re-paste cookie) from network_error (retry).
    return 1 if (res.get("auth_error") or res.get("network_error")) else 0


def cmd_reddit_unsave(args) -> int:
    from content_hoarder import db, reddit_unsave as ru
    with _connect() as conn:
        if args.login:
            if not args.cookie:
                print('error: --login requires --cookie "<reddit_session value>"', file=sys.stderr)
                return 2
            try:
                username = ru.login(conn, args.cookie.strip())
            except ru.RedditAuthError as exc:
                print(f"cookie rejected: {exc}", file=sys.stderr)
                return 1
            print(f"Signed in as u/{username}")
            return 0
        if args.enable or args.disable:
            db.set_setting(conn, "reddit_unsave_on_done", "1" if args.enable else "0")
            print(f"unsave-on-done {'enabled' if args.enable else 'disabled'}")
            return 0
        if args.enqueue_existing:
            n = db.enqueue_existing_done(conn)
            print(f"queued {n} existing 'done' reddit item(s) for unsaving")
            return 0
        if args.drain:
            res = ru.drain(conn, limit=args.limit, throttle=args.throttle,
                           progress=lambda m: print(m, file=sys.stderr))
            print(json.dumps(res, indent=2))
            # Non-zero for network errors too (scheduled-run visibility); the printed JSON
            # distinguishes auth_error (re-paste cookie) from network_error (retry later).
            return 1 if (res.get("auth_error") or res.get("network_error")) else 0
        # default: status
        auth = ru.get_auth(conn)
        print(json.dumps({
            "configured": auth is not None,
            "username": auth.get("username") if auth else None,
            "enabled": db.get_setting(conn, "reddit_unsave_on_done", "0") == "1",
            "pending": ru.count_pending(conn),
            "failed": ru.count_failed(conn),
        }, indent=2))
    return 0


def cmd_reddit_hydrate(args) -> int:
    from content_hoarder import reddit_hydrate
    with _connect() as conn:
        if args.from_dir:
            res = reddit_hydrate.hydrate_from_archive(
                conn, args.from_dir, limit=args.limit,
                only_existing=not args.include_orphans,
                progress=lambda m: print(m, file=sys.stderr),
            )
            print(json.dumps(res, indent=2))
            return 0 if res.get("errors", 0) == 0 else 1
        if not args.fullname:
            print("error: provide a fullname or --from <bdfr-dir>", file=sys.stderr)
            return 2
        res = reddit_hydrate.hydrate_one(conn, args.fullname)
    print(json.dumps(res, indent=2))
    return 0 if res.get("status") == "hydrated" else 1


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="content_hoarder", description="Local triage-first content manager.")
    sub = p.add_subparsers(dest="command", required=True)

    sub.add_parser("init-db", help="Create the database + search tables.").set_defaults(func=cmd_init_db)

    pi = sub.add_parser("import", help="Import a file or directory.")
    pi.add_argument("path")
    pi.add_argument("--source", help="Force a connector id (else auto-detect).")
    pi.add_argument("--enrich", action="store_true", help="Enrich imported items immediately.")
    pi.set_defaults(func=cmd_import)

    pe = sub.add_parser("enrich", help="Fill sparse rows via source APIs.")
    pe.add_argument("--source", help="Only this source (else all that support it).")
    pe.add_argument("--all", action="store_true", help="Re-enrich every row, not just sparse ones.")
    pe.add_argument("--archives", action="store_true",
                    help="Recover [removed]/[deleted] + unhydrated reddit items from web "
                         "archives (PullPush + Arctic-Shift). Network; resumable via --limit.")
    pe.add_argument("--titles", action="store_true",
                    help="Recover [Private/Deleted video] YouTube titles from the Wayback Machine.")
    pe.add_argument("--scores", action="store_true",
                    help="Hydrate upvotes/score (+ current title/body) for ALL reddit items via the archives.")
    pe.add_argument("--limit", type=int, default=None,
                    help="Max items to attempt this run (chunked/resumable recovery).")
    pe.set_defaults(func=cmd_enrich)

    pc = sub.add_parser("categorize",
                        help="Tag items: YouTube → listenable/watch/wotagei; Reddit → multi-label tags.")
    pc.add_argument("--source", default="youtube", help="Source to categorize (default: youtube).")
    pc.add_argument("--all", action="store_true", help="Re-categorize items that already have one.")
    pc.add_argument("--limit", type=int, default=None, help="Max items to categorize.")
    pc.add_argument("--dry-run", action="store_true",
                    help="Preview tag assignment without writing (reddit multi-label tagging).")
    pc.add_argument("--topics", action="store_true", help="YouTube: multi-label topic tags instead of processing areas.")
    pc.set_defaults(func=cmd_categorize)

    ph = sub.add_parser("reddit-hydrate",
                        help="Hydrate saved Reddit comment threads into reddit_threads "
                             "(one fullname via cookie, or --from a local BDFR archive, offline).")
    ph.add_argument("fullname", nargs="?",
                    help="Item fullname to hydrate via cookie (e.g. 'reddit:t3_xxxxx').")
    ph.add_argument("--from", dest="from_dir", metavar="BDFR_DIR",
                    help="Offline: hydrate every submission .json under this BDFR archive dir "
                         "(no network, no cookie). Converts the local comment trees.")
    ph.add_argument("--limit", type=int, default=None,
                    help="--from: cap how many threads to write this run.")
    ph.add_argument("--include-orphans", action="store_true",
                    help="--from: also cache threads whose post isn't in the items table "
                         "(default skips them).")
    ph.set_defaults(func=cmd_reddit_hydrate)

    pd = sub.add_parser("dedup", help="Flag possible-duplicate items (non-destructive) or resolve.")
    pd.add_argument("--by", choices=("url", "title"), default="url",
                    help="Group by identical URL (safe) or title (looser).")
    pd.add_argument("--resolve", action="store_true",
                    help="Auto-archive all-but-richest per group (reversible).")
    pd.add_argument("--clear", action="store_true", help="Remove the dup flags.")
    pd.set_defaults(func=cmd_dedup)

    pm = sub.add_parser("migrate-firefox-tabs",
                        help="Promote Firefox YouTube tabs into youtube items (the connector now "
                             "does this at import; this fixes rows imported before that).")
    pm.add_argument("--apply", action="store_true",
                    help="Commit changes (default: dry run). Run against a DB copy first.")
    pm.set_defaults(func=cmd_migrate_firefox_tabs)

    prt = sub.add_parser("migrate-rsm-threads",
                         help="One-time: copy cached thread JSON from a reddit-saved-manager "
                              "data/app.db into the local reddit_threads cache (source is read-only).")
    prt.add_argument("--from", dest="from_db", required=True, metavar="RSM_APP_DB",
                     help="Path to the reddit-saved-manager data/app.db.")
    prt.add_argument("--all-threads", action="store_true",
                     help="Migrate threads even for items not present locally (default: skip orphans).")
    prt.set_defaults(func=cmd_migrate_rsm_threads)

    pcon = sub.add_parser(
        "consolidate",
        help="Re-runnable migration: fold reddit/HN/etc links-to-YouTube into canonical youtube:<id> rows.",
    )
    pcon.add_argument("--apply", action="store_true",
                      help="Commit changes (default: dry run). Run against a DB copy first.")
    pcon.add_argument("--undo", action="store_true",
                      help="Undo consolidation (default: consolidate).")
    pcon.set_defaults(func=cmd_consolidate)

    ps = sub.add_parser("serve", help="Run the web app.")
    ps.add_argument("--host", help="Bind host (default 127.0.0.1; set to your Tailscale IP for mobile).")
    ps.add_argument("--port", type=int, help="Port (default 8788).")
    ps.set_defaults(func=cmd_serve)

    sub.add_parser("stats", help="Print counts.").set_defaults(func=cmd_stats)
    sub.add_parser("sources", help="List connectors.").set_defaults(func=cmd_sources)

    pb = sub.add_parser("bankruptcy", help="Reversibly bulk-archive old inbox items.")
    pb.add_argument("--before", required=True, help="YYYY-MM-DD cutoff.")
    pb.add_argument("--source", help="Only this source.")
    pb.add_argument("--dry-run", action="store_true")
    pb.set_defaults(func=cmd_bankruptcy)

    pdc = sub.add_parser(
        "decay",
        help="Guilt-free bulk decay: archive inbox items by tag/subreddit/age "
             "(stamped per wave + reversible via --undo).",
    )
    pdc.add_argument("--tag", action="append",
                     help="Decay items carrying this metadata tag (repeatable; union with --subreddit).")
    pdc.add_argument("--subreddit", action="append",
                     help="Decay items from this subreddit (repeatable; case-insensitive).")
    pdc.add_argument("--before", help="Only items older than YYYY-MM-DD (content age).")
    pdc.add_argument("--source", default="reddit", help="Source to decay (default: reddit).")
    pdc.add_argument("--label",
                     help="Mark the wave with metadata.decay_label (e.g. swept for the "
                          "supervised initial backfill; pull via the is:swept search operator).")
    pdc.add_argument("--apply", action="store_true",
                     help="Commit changes (default: dry run). Run against a DB copy first.")
    pdc.add_argument("--undo", action="store_true",
                     help="Restore decayed items to inbox (select a wave with "
                          "--decayed-after/--decayed-before).")
    pdc.add_argument("--decayed-after", help="--undo: only waves stamped on/after this YYYY-MM-DD "
                                             "(full ISO datetime also accepted).")
    pdc.add_argument("--decayed-before", help="--undo: only waves stamped before this YYYY-MM-DD.")
    pdc.set_defaults(func=cmd_decay)

    pp = sub.add_parser("promote", help="Push 'keep' items to a stock Karakeep (opt-in).")
    pp.add_argument("--status", default="keep")
    pp.add_argument("--limit", type=int)
    pp.add_argument("--dry-run", action="store_true")
    pp.set_defaults(func=cmd_promote)

    pdel = sub.add_parser(
        "delete",
        help="PERMANENTLY delete matching items (dry-run default; execution needs "
             "--apply AND --yes; automatic pre-delete backup + audit log).",
    )
    pdel.add_argument("--tag", action="append",
                      help="Items carrying this tag (repeatable; union with --subreddit).")
    pdel.add_argument("--subreddit", action="append",
                      help="Items from this subreddit (repeatable; case-insensitive).")
    pdel.add_argument("--before", help="Only items older than YYYY-MM-DD (content age).")
    pdel.add_argument("--fullname", action="append", help="Exact item(s) by fullname.")
    pdel.add_argument("--status", help="Only items in this status.")
    pdel.add_argument("--swept", action="store_true",
                      help="Only items from the labeled initial decay pass (is:swept).")
    pdel.add_argument("--source", default="reddit", help="Source (default: reddit).")
    pdel.add_argument("--also-unsave", action="store_true", dest="also_unsave",
                      help="Also enqueue deleted reddit items into the unsave queue "
                           "(drained later via the cookie path).")
    pdel.add_argument("--max", type=int, default=5000,
                      help="Refuse to delete more rows than this (blast-radius cap).")
    pdel.add_argument("--apply", action="store_true",
                      help="Execute (with --yes). Default: dry run.")
    pdel.add_argument("--yes", action="store_true",
                      help="Second confirmation; --apply alone shows the plan and refuses.")
    pdel.set_defaults(func=cmd_delete)

    pex = sub.add_parser(
        "export",
        help="Dump matching items to CSV/JSON (re-save-elsewhere oriented; "
             "e.g. --tag nsfw_erotic --out erotic.csv).",
    )
    pex.add_argument("--out", required=True, help="Output file path.")
    pex.add_argument("--format", choices=("csv", "json"), default="csv")
    pex.add_argument("--tag", action="append", help="Filter by tag (repeatable = OR).")
    pex.add_argument("--status", help="Filter by status.")
    pex.add_argument("--source", help="Filter by source.")
    pex.add_argument("--subreddit", help="Filter by subreddit.")
    pex.set_defaults(func=cmd_export)

    px = sub.add_parser("export-obsidian", help="Write items to an Obsidian vault as Markdown.")
    px.add_argument("--vault", required=True)
    px.add_argument("--status", default="keep", help="Which status to export (default: keep).")
    px.set_defaults(func=cmd_export_obsidian)

    pg = sub.add_parser("suggest", help="Annotate inbox items with local-LLM keep/skip suggestions.")
    pg.add_argument("--source")
    pg.add_argument("--limit", type=int, default=20)
    pg.set_defaults(func=cmd_suggest)

    prs = sub.add_parser("reddit-sync",
                         help="Pull newest saved items from Reddit via the session cookie "
                              "(incremental: newest-first, stops once a page has no new items). "
                              "Set the cookie first with `reddit-unsave --login --cookie ...`.")
    prs.add_argument("--max-pages", type=int, default=None,
                     help="Pages of 100 to fetch (default 3 newest pages).")
    prs.add_argument("--full", action="store_true",
                     help="Deeper backfill (up to 50 pages) — slower; for a first/large catch-up.")
    prs.set_defaults(func=cmd_reddit_sync)

    pu = sub.add_parser("reddit-unsave",
                        help="Unsave reddit items (queued when triaged 'Done') from your Reddit "
                             "Saved via a session cookie. No args = print status.")
    pu.add_argument("--login", action="store_true",
                    help="Validate + store a reddit_session cookie (use with --cookie).")
    pu.add_argument("--cookie", help="The reddit_session cookie value (for --login).")
    pu.add_argument("--enable", action="store_true", help="Turn unsave-on-done ON.")
    pu.add_argument("--disable", action="store_true", help="Turn unsave-on-done OFF.")
    pu.add_argument("--drain", action="store_true",
                    help="Unsave queued items now (the scheduled job runs this). "
                         "Exits non-zero if the cookie has expired.")
    pu.add_argument("--enqueue-existing", action="store_true",
                    help="One-time backfill: queue all reddit items already marked 'done'.")
    pu.add_argument("--limit", type=int, default=None, help="Max items to unsave this drain run.")
    pu.add_argument("--throttle", type=float, default=1.0,
                    help="Seconds between unsave requests (default 1.0).")
    pu.set_defaults(func=cmd_reddit_unsave)

    return p


def main(argv=None) -> int:
    config.load_env()
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
