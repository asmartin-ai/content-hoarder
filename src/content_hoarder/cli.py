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


def _backup_db(conn, suffix: str):
    """Write a timestamped online backup of the live DB beside it
    (``app.backup-<suffix>-<stamp>.db``) and return its Path. Used before
    destructive/irreversible commands so a run stays recoverable."""
    import sqlite3
    from pathlib import Path
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    bak = Path(config.db_path()).with_name(f"app.backup-{suffix}-{stamp}.db")
    dst = sqlite3.connect(str(bak))
    with dst:
        conn.backup(dst)
    dst.close()
    return bak


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
            conn, args.path, source=args.source, enrich=args.enrich,
            reconcile=args.reconcile, reconcile_dry_run=args.reconcile_dry_run,
            reconcile_complete=args.reconcile_complete,
        )
    print(f"imported={res.imported} skipped={res.skipped} errors={len(res.errors)}")
    for err in res.errors[:10]:
        print("  !", err)
    if res.reconcile is not None:
        tag = "[dry-run] " if args.reconcile_dry_run else ""
        print(f"{tag}reconcile (mark missing reddit saves as un-saved):")
        for kind, info in res.reconcile.items():
            if info.get("skipped"):
                print(f"  {kind}: skipped ({info['skipped']}; {info['present']} in export)")
            else:
                verb = "would un-save" if args.reconcile_dry_run else "un-saved"
                print(f"  {kind}: {info['present']} in export, {verb} {info['unsaved']}")
    return 0


def cmd_reddit_hydrate_titles(args) -> int:
    from content_hoarder import reddit_hydrate
    bak = None
    with _connect() as conn:
        if not args.dry_run:
            bak = _backup_db(conn, "pre-titles")
            print(f"backed up DB -> {bak}", file=sys.stderr)
        if getattr(args, "network", False):
            res = reddit_hydrate.backfill_titles_network(
                conn, dry_run=args.dry_run, limit=args.limit,
                progress=lambda m: print(m, file=sys.stderr))
        else:
            res = reddit_hydrate.backfill_titles_local(conn, dry_run=args.dry_run)
    if bak:
        res["backup"] = str(bak)
    print(json.dumps(res, indent=2, ensure_ascii=False))
    return 0


def cmd_enrich(args) -> int:
    from content_hoarder import enrich as enrich_mod
    with _connect() as conn:
        if getattr(args, "gallery_previews", False):
            from content_hoarder.archival import service as archival
            # already-hydrated galleries -> retry=True; the gallery_preview IS NULL scope is
            # what makes it resumable (each gallery drops out once backfilled).
            n = archival.count_targets(conn, retry=True, scope="gallery_preview")
            print(f"{n} gallery item(s) need sized previews; querying archives...", file=sys.stderr)
            res = archival.recover(conn, limit=args.limit, retry=True, scope="gallery_preview",
                                   progress=lambda m: print(m, file=sys.stderr))
        elif getattr(args, "archives", False) or getattr(args, "scores", False):
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
        if getattr(args, "llm", False):
            from content_hoarder.assist import llm
            res = llm.classify_source(conn, args.source or "youtube",
                                      limit=args.limit, retry=args.all,
                                      backend=getattr(args, "backend", "local"))
        elif (args.source or "").lower() == "reddit":
            # Reddit gets multi-label tags (metadata.tags); --dry-run previews accuracy.
            res = cat_mod.tag_reddit_source(conn, limit=args.limit, retry=args.all,
                                            dry_run=args.dry_run)
        elif (args.source or "").lower() in ("firefox", "hackernews"):
            # Firefox-tab / HN items get the same multi-label topic tags (F14).
            res = cat_mod.tag_browser_source(conn, (args.source or "").lower(),
                                             limit=args.limit, retry=args.all,
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


def cmd_migrate_note_youtube(args) -> int:
    from content_hoarder import note_youtube
    with _connect() as conn:
        res = note_youtube.migrate(conn, apply=args.apply)
    print(json.dumps(res, indent=2, ensure_ascii=False))
    if not args.apply:
        print(
            f"(dry run — {res['candidates']} candidate note→YouTube link(s): "
            f"{res['orphan']} orphan (would create youtube rows) + {res['companion']} companion "
            f"(would attach to existing youtube rows). Re-run with --apply to commit. "
            f"Run against a COPY of the DB first.)",
            file=sys.stderr,
        )
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
    # threaded: the dev server is single-threaded by default, so one slow request
    # (a live Reddit thread hydrate — a network round-trip to reddit.com) blocks ALL
    # others, making the whole app feel wedged. Each request opens + closes its own
    # SQLite connection within its own thread (db.connect via closing()), and WAL +
    # busy_timeout handle concurrent read/write, so threading is safe here.
    app.run(host=host, port=port, debug=False, threaded=True)
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


def cmd_learn_triage(args) -> int:
    from content_hoarder import triage_score
    with _connect() as conn:
        res = triage_score.learn(conn, apply=args.apply,
                                 min_support=args.min_support, alpha=args.alpha,
                                 limit=args.limit)
    print(json.dumps(res, indent=2))
    if not args.apply:
        print(f"(dry run — model fitted on {res['trained_on']} rows "
              f"({res['processed']} human-processed, prior {res['prior']}); "
              f"{res['scored']} inbox item(s) would get triage_score; re-run with "
              f"--apply to write. Run against a COPY of the DB first.)", file=sys.stderr)
    return 0


def cmd_delete(args) -> int:
    """PERMANENT delete with the money-action safety shape: dry-run is the default and
    the confirmation surface; --apply alone refuses (exit 3); --apply --yes executes
    after an automatic timestamped backup, then appends to the audit log."""
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

        bak = _backup_db(conn, "pre-delete")

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


def cmd_purge_done(args) -> int:
    """PERMANENT retention purge of long-Done items (Gmail-trash; Epic 21). Wraps the
    db.purge_done primitive in the same money-action safety shape as `delete`: dry-run is
    the default and the confirmation surface; --apply alone refuses (exit 3); --apply --yes
    executes after an automatic backup, then appends to the shared audit log. --retention-days
    persists the window setting (the eventual settings UI is the other entry point)."""
    import time as _time
    from pathlib import Path

    from content_hoarder import config, db
    with _connect() as conn:
        if args.retention_days is not None:
            db.set_setting(conn, "done_retention_days", str(int(args.retention_days)))
        now = int(_time.time())
        plan = db.purge_done(conn, now=now, apply=False, max_rows=args.max)
        if not args.apply:
            print(json.dumps(plan, indent=2))
            print(f"(dry run — {plan['total']} done item(s) older than "
                  f"{plan['retention_days']}d would be PERMANENTLY deleted; re-run with "
                  f"--apply --yes. Irreversible except via the automatic backup.)",
                  file=sys.stderr)
            return 0
        if not args.yes:
            print(json.dumps(plan, indent=2))
            print("refusing: a retention purge needs BOTH --apply and --yes.", file=sys.stderr)
            return 3
        if plan["total"] > args.max:
            print(json.dumps(plan, indent=2))
            print(f"refusing: {plan['total']} > --max {args.max} (blast-radius cap); "
                  f"raise --max deliberately if intended.", file=sys.stderr)
            return 4

        # capture the victims for the audit BEFORE deleting (same cutoff + now)
        victims = [
            {"fullname": r[0], "source": r[1], "title": (r[2] or "")[:80]}
            for r in conn.execute(
                "SELECT fullname, source, title FROM items WHERE status='done' "
                "AND processed_utc IS NOT NULL AND processed_utc < ? ORDER BY processed_utc",
                (plan["cutoff"],),
            ).fetchall()
        ]
        bak = _backup_db(conn, "pre-purge-done")
        res = db.purge_done(conn, now=now, apply=True, max_rows=args.max)
        res["backup"] = str(bak)

        audit_path = Path(config.db_path()).with_name("delete-audit.jsonl")
        audit = {"ts": int(_time.time()), "op": "purge_done",
                 "retention_days": res["retention_days"], "cutoff": res["cutoff"],
                 "total": res["total"], "threads_deleted": res["threads_deleted"],
                 "backup": str(bak), "victims": victims[:200]}
        with audit_path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(audit, ensure_ascii=False) + "\n")
    print(json.dumps(res, indent=2))
    return 0


def cmd_scan_media(args) -> int:
    """Probe saved reddit image/gallery items for deleted media + classify (Epic 4 P1
    groundwork). Dry-run by default; --apply stamps metadata.media_status (+ a `deleted` tag on
    gone items, surfaced by is:deleted / tag:deleted). Crash-safe (per-batch commit), resumable
    (skips already-classified unless --recheck). Writes a JSON manifest beside the DB."""
    from pathlib import Path

    from content_hoarder import config, media_scan
    with _connect() as conn:
        res = media_scan.scan(
            conn, status=args.status, limit=args.limit, recheck=args.recheck,
            apply=args.apply, workers=args.workers, batch=args.batch,
            progress=lambda m: print(m, file=sys.stderr),
        )
    manifest = Path(config.db_path()).with_name("deleted-media-scan.json")
    manifest.write_text(json.dumps(res, indent=2), encoding="utf-8")
    print(json.dumps({k: v for k, v in res.items() if k != "salvageable_items"}, indent=2))
    print(f"manifest -> {manifest}  ({len(res['salvageable_items'])} salvageable URL(s) recorded)",
          file=sys.stderr)
    if not args.apply:
        print("(dry run — re-run with --apply to write media_status/tags)", file=sys.stderr)
    return 0


def cmd_archive_media(args) -> int:
    """Download + store media bytes locally so deletions are survivable (Epic 4 P1, hoard the
    bytes). Dry-run by default; --apply fetches + writes content-addressed blobs under data/media/
    and stamps metadata.archived_media. Scope with --salvageable/--galleries/--images (default:
    salvageable + galleries). Resumable (skips already-archived URLs); per-item commit."""
    from content_hoarder import media_archive
    scopes = [s for s, on in (("salvageable", args.salvageable), ("galleries", args.galleries),
                              ("images", args.images)) if on] or ["salvageable", "galleries"]
    with _connect() as conn:
        res = media_archive.archive(conn, scopes=scopes, limit=args.limit, apply=args.apply,
                                    throttle=args.throttle,
                                    progress=lambda m: print(m, file=sys.stderr))
    print(json.dumps(res, indent=2))
    if not args.apply:
        print(f"(dry run — {res['urls']} URL(s) across {res['items']} item(s) would be fetched; "
              f"re-run with --apply)", file=sys.stderr)
    else:
        print(f"archived {res['archived']} blob(s) ({res['bytes'] // 1024 // 1024} MB), "
              f"{res['failed']} failed", file=sys.stderr)
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
    prog = lambda m: print(m, file=sys.stderr)
    with _connect() as conn:
        # Toggle the automatic background sync / PWA-open path (opt-in, default off).
        if args.enable_auto or args.disable_auto:
            reddit_sync.set_autosync_enabled(conn, args.enable_auto)
            print(json.dumps({"autosync_enabled": args.enable_auto,
                              "note": "background thread starts on next app launch; "
                                      "the PWA-open path is live immediately"}, indent=2))
            return 0
        if args.reconcile:
            # Full-walk census: import new saves AND infer Reddit-side unsaves (clear is_saved;
            # inbox -> done). Dry-run previews the would-unsave set with no writes. Reconcile is
            # destructive (non-additive) — back up the DB before a real run.
            res = reddit_sync.sync_saved(
                conn, reconcile=True, reconcile_dry_run=args.reconcile_dry_run,
                max_pages=reddit_sync.RECONCILE_MAX_PAGES, stop_on_known=False, progress=prog)
        else:
            max_pages = args.max_pages if args.max_pages else (50 if args.full else 3)
            res = reddit_sync.sync_saved(
                conn, max_pages=max_pages, stop_on_known=not args.full, progress=prog)
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
        if args.trickle:
            # Opted-in continuous lane: bounded auto-drain, no --live --yes (consent = the enable
            # toggle + the small cap + the audit trail). Refuses when unsave-on-done is OFF.
            from content_hoarder import reddit_trickle
            if db.get_setting(conn, "reddit_unsave_on_done", "0") != "1":
                print("trickle skipped: unsave-on-done is OFF — run `reddit-unsave --enable` first.",
                      file=sys.stderr)
                return 0
            cap = args.limit if args.limit is not None else reddit_trickle.DEFAULT_CAP
            _t_audit, audit_path = ru.audit_appender(config.db_path())
            res = ru.drain(conn, limit=cap, throttle=args.throttle, audit=_t_audit,
                           progress=lambda m: print(m, file=sys.stderr))
            res["audit_log"] = str(audit_path)
            print(json.dumps(res, indent=2))
            return 1 if (res.get("auth_error") or res.get("network_error")) else 0
        if args.drain:
            # Money-action gate: execute ONLY with --live --yes (and not --dry-run). Anything else
            # is a dry run that lists the scope and sends nothing — the confirmation surface.
            execute = args.live and args.yes and not args.dry_run
            if not execute:
                plan = ru.drain(conn, limit=args.limit, dry_run=True)
                print(json.dumps(plan, indent=2))
                if args.live and not args.yes and not args.dry_run:
                    print("\nrefusing: --live needs --yes too. The plan above is a DRY RUN — nothing "
                          "was sent. Re-run with --live --yes to unsave for real.", file=sys.stderr)
                    return 2
                print(f"\n[dry run] {plan['selected']} item(s) would be unsaved from your REAL "
                      f"Reddit Saved list (reversible via the undo/re-save). Re-run with "
                      f"--live --yes to execute.", file=sys.stderr)
                return 0
            # --- live execution path ---
            _audit, audit_path = ru.audit_appender(config.db_path())
            res = ru.drain(conn, limit=args.limit, throttle=args.throttle, audit=_audit,
                           progress=lambda m: print(m, file=sys.stderr))
            res["audit_log"] = str(audit_path)
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


def cmd_reddit_oauth(args) -> int:
    from content_hoarder import reddit_oauth
    with _connect() as conn:
        if args.logout:
            reddit_oauth.clear(conn)
            print("reddit OAuth tokens cleared.")
            return 0
        if not args.login:  # default: status
            print(json.dumps(reddit_oauth.status(conn), indent=2))
            return 0
        # --login: interactive one-time authorization.
        if not reddit_oauth.client_id():
            print("error: set REDDIT_OAUTH_CLIENT_ID (.env or a user env var) first.",
                  file=sys.stderr)
            return 2
        state = reddit_oauth.new_state()
        url = reddit_oauth.build_authorize_url(state=state)
        print("Reddit OAuth — one-time setup:\n")
        print("   (The consent screen will request read + history + identity + save permissions —")
        print("    that's RedReader's standard scope set. Reads work immediately; save/unsave stays")
        print("    dormant until you enable it, and bulk unsave needs an explicit --live --yes.)\n")
        print("1) Open this URL in your browser and click 'Allow':\n")
        print("   " + url + "\n")
        print("2) The browser then redirects to a 'redreader://rr_oauth_redir?...' URL it CANNOT")
        print("   open — that's EXPECTED (there's no RedReader app on the PC). Grab the code from")
        print("   that failed redirect one of two ways:")
        print("     - Easiest: after the error page appears, copy the full 'redreader://...' URL")
        print("       straight from the address bar.")
        print("     - If the address bar doesn't change: open dev tools (F12) -> Network tab, tick")
        print("       'Persist Logs', click Allow, find the 302 (or the red 'redreader://' entry),")
        print("       and copy its 'Location' response header.\n")
        try:
            pasted = input("3) Paste the redirected URL (or just the code) here: ").strip()
        except EOFError:
            print("error: no input received.", file=sys.stderr)
            return 2
        try:
            username = reddit_oauth.login(conn, pasted, expected_state=state)
        except reddit_oauth.RedditOAuthError as exc:
            print(f"OAuth failed: {exc}", file=sys.stderr)
            return 1
        except reddit_oauth.RedditNetworkError as exc:
            print(f"network error talking to Reddit: {exc}", file=sys.stderr)
            return 1
        who = f" as u/{username}" if username else ""
        print(f"\nOAuth configured{who}. Hydration now uses the sanctioned OAuth transport "
              f"(the cookie stays as a fallback). The grant also carries history + save scopes "
              f"for the saved-list sync and unsave writes (activated separately).")
        return 0


def cmd_reddit_hydrate(args) -> int:
    from content_hoarder import reddit_hydrate
    with _connect() as conn:
        if args.batch:
            # Safe by default: without --yes, --batch only LISTS the scope (no network),
            # mirroring the hard-delete double-gate. --yes is the explicit go-ahead.
            scope_only = args.dry_run or not args.yes
            res = reddit_hydrate.hydrate_batch(
                conn,
                limit=args.limit if args.limit is not None else reddit_hydrate.DEFAULT_BATCH_LIMIT,
                throttle=args.throttle, dry_run=scope_only,
                progress=lambda m: print(m, file=sys.stderr),
            )
            print(json.dumps(res, indent=2))
            if scope_only and not args.dry_run:
                print(f"\n[scope only] {res['eligible']} eligible; nothing fetched. Re-run with "
                      f"--yes to hydrate for real (hits Reddit at ~{args.throttle}s/request).",
                      file=sys.stderr)
            return 1 if res.get("auth_error") else 0
        if args.from_dir:
            res = reddit_hydrate.hydrate_from_archive(
                conn, args.from_dir, limit=args.limit,
                only_existing=not args.include_orphans,
                skip_hydrated=not args.overwrite,
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


def cmd_reddit_thumbnails(args) -> int:
    """Backfill metadata.thumbnail for reddit items from their already-cached thread blobs
    (the submission poster the initial sync dropped). Zero network; dry-run by default."""
    from content_hoarder import reddit_hydrate
    with _connect() as conn:
        res = reddit_hydrate.backfill_thumbnails(conn, apply=args.apply, limit=args.limit)
    print(json.dumps(res, indent=2))
    if not args.apply:
        print(f"\n[dry run] {res['eligible']} item(s) could get a thumbnail from cached threads. "
              f"Re-run with --apply to write (no network).", file=sys.stderr)
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="content_hoarder", description="Local triage-first content manager.")
    sub = p.add_subparsers(dest="command", required=True)

    sub.add_parser("init-db", help="Create the database + search tables.").set_defaults(func=cmd_init_db)

    pi = sub.add_parser("import", help="Import a file or directory.")
    pi.add_argument("path")
    pi.add_argument("--source", help="Force a connector id (else auto-detect).")
    pi.add_argument("--enrich", action="store_true", help="Enrich imported items immediately.")
    pi.add_argument("--reconcile", action="store_true",
                    help="Delta-reconcile saves: mark reddit items PREVIOUSLY seen in a saved-list "
                         "snapshot (metadata.saved_seen_utc) but absent from THIS export as "
                         "un-saved (per-type <1000 cap-guarded). The first snapshot only sets the "
                         "baseline (un-saves nothing). Destructive — back up the DB first.")
    pi.add_argument("--reconcile-dry-run", action="store_true",
                    help="Preview --reconcile (count would-be un-saves) without writing.")
    pi.add_argument("--reconcile-complete", action="store_true",
                    help="Assert this is the COMPLETE saved list (e.g. a GDPR export) so "
                         "reconcile runs even at/above the ~1000-per-type cap (B2). Omit for a "
                         "possibly page-truncated dump.")
    pi.set_defaults(func=cmd_import)

    ph = sub.add_parser("reddit-hydrate-titles",
                        help="Restore real titles for title-less saved reddit comments. Default: "
                             "local/offline from raw_json.submission_title (spec 08 P1). --network: "
                             "fetch the rest from web archives (spec 08 P2). Backs up the DB first.")
    ph.add_argument("--dry-run", action="store_true",
                    help="Preview the scope without writing (and without network when --network).")
    ph.add_argument("--network", action="store_true",
                    help="Phase 2: fetch remaining titles from web archives (PullPush -> Arctic-Shift) "
                         "for comments with no local submission_title, keyed on the submission id in "
                         "metadata.permalink. Network; resumable via --limit.")
    ph.add_argument("--limit", type=int, default=None,
                    help="--network: cap how many items to attempt this run (resumable).")
    ph.set_defaults(func=cmd_reddit_hydrate_titles)

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
    pe.add_argument("--gallery-previews", action="store_true", dest="gallery_previews",
                    help="Backfill sized ~1080px gallery preview variants (metadata.gallery_preview) "
                         "for galleries missing them (Epic 13 P2 perf). Network; resumable.")
    pe.add_argument("--limit", type=int, default=None,
                    help="Max items to attempt this run (chunked/resumable recovery).")
    pe.set_defaults(func=cmd_enrich)

    pc = sub.add_parser("categorize",
                        help="Tag items: YouTube → listenable/watch/wotagei; Reddit/Firefox/HN → multi-label tags.")
    pc.add_argument("--source", default="youtube",
                    help="Source to categorize: youtube (default), reddit, firefox, hackernews.")
    pc.add_argument("--all", action="store_true", help="Re-categorize items that already have one.")
    pc.add_argument("--limit", type=int, default=None, help="Max items to categorize.")
    pc.add_argument("--dry-run", action="store_true",
                    help="Preview tag assignment without writing (reddit/firefox/hackernews multi-label).")
    pc.add_argument("--topics", action="store_true", help="YouTube: multi-label topic tags instead of processing areas.")
    pc.add_argument("--llm", action="store_true",
                    help="Classify with an LLM (assist/llm.py) instead of heuristics; "
                         "re-does the NULL/unknown tail by default.")
    pc.add_argument("--backend", choices=("local", "fireworks"), default="local",
                    help="LLM backend for --llm: local LM Studio (default) or Fireworks "
                         "(needs FIREWORKS_API_KEY).")
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
    ph.add_argument("--overwrite", action="store_true",
                    help="--from: re-write threads already cached (default SKIPS them — a "
                         "live cookie/RSM blob can be richer than the archive).")
    ph.add_argument("--batch", action="store_true",
                    help="Cookie-hydrate the prioritized unhydrated set (inbox selftext posts, "
                         "newest-saved first), rate-limited + resumable. Pair with --limit/"
                         "--throttle; --dry-run lists the scope first.")
    ph.add_argument("--throttle", type=float, default=2.0,
                    help="--batch: seconds between requests (default 2.0 — be courteous to Reddit).")
    ph.add_argument("--dry-run", action="store_true",
                    help="--batch: print the scope (count + sample) without any network.")
    ph.add_argument("--yes", action="store_true",
                    help="--batch: actually hit Reddit. Without it, --batch only lists the scope "
                         "(safe-by-default gate; be conservative with Reddit requests).")
    ph.set_defaults(func=cmd_reddit_hydrate)

    pt = sub.add_parser("reddit-thumbnails",
                        help="Backfill reddit thumbnails (esp. v.redd.it video posters) from "
                             "already-cached thread blobs — zero network. Dry-run by default.")
    pt.add_argument("--apply", action="store_true",
                    help="Write the thumbnails (default just reports how many would be filled).")
    pt.add_argument("--limit", type=int, default=None,
                    help="Cap how many cached threads to scan this run.")
    pt.set_defaults(func=cmd_reddit_thumbnails)

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

    pmy = sub.add_parser(
        "migrate-note-youtube",
        help="Promote Keep/Obsidian notes containing YouTube links into youtube:<id> items "
             "(dry-run by default; attaches the note as a companion).",
    )
    pmy.add_argument("--apply", action="store_true",
                     help="Commit changes (default: dry run). Run against a DB copy first.")
    pmy.set_defaults(func=cmd_migrate_note_youtube)

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

    plt = sub.add_parser(
        "learn-triage",
        help="Fit the transparent likely-to-process model from triage history and "
             "score inbox items (metadata.triage_score + why; smart batches use it).",
    )
    plt.add_argument("--min-support", type=int, default=20,
                     help="Drop features seen fewer times than this (default 20).")
    plt.add_argument("--alpha", type=float, default=50.0,
                     help="Smoothing weight toward the global prior (default 50).")
    plt.add_argument("--limit", type=int, help="Score at most N inbox items (testing).")
    plt.add_argument("--apply", action="store_true",
                     help="Write scores + persist the model (default: dry run).")
    plt.set_defaults(func=cmd_learn_triage)

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

    ppd = sub.add_parser(
        "purge-done",
        help="PERMANENTLY purge Done items older than the retention window (Gmail-trash; "
             "dry-run default; execution needs --apply AND --yes; auto backup + audit log).",
    )
    ppd.add_argument("--retention-days", type=int, default=None,
                     help="Set + persist the done_retention_days window before purging "
                          "(default: the stored setting, 30).")
    ppd.add_argument("--max", type=int, default=5000,
                     help="Refuse to purge more rows than this (blast-radius cap).")
    ppd.add_argument("--apply", action="store_true",
                     help="Execute (with --yes). Default: dry run.")
    ppd.add_argument("--yes", action="store_true",
                     help="Second confirmation; --apply alone shows the plan and refuses.")
    ppd.set_defaults(func=cmd_purge_done)

    psm = sub.add_parser(
        "scan-media",
        help="Probe saved reddit media for deletion + classify (metadata.media_status); "
             "dry-run default, --apply writes. Surfaces via is:deleted.",
    )
    psm.add_argument("--status", default=None,
                     help="Limit to a triage status (e.g. inbox); default all.")
    psm.add_argument("--limit", type=int, default=None, help="Cap items probed this run.")
    psm.add_argument("--recheck", action="store_true",
                     help="Re-probe items already classified (e.g. the transient 'unknown's).")
    psm.add_argument("--workers", type=int, default=10, help="Concurrent probes (default 10).")
    psm.add_argument("--batch", type=int, default=200,
                     help="Commit cadence — rows per crash-safe batch (default 200).")
    psm.add_argument("--apply", action="store_true",
                     help="Write media_status + the deleted tag (default: dry run).")
    psm.set_defaults(func=cmd_scan_media)

    pam = sub.add_parser(
        "archive-media",
        help="Download + store media BYTES locally so deletions are survivable (Epic 4 P1); "
             "dry-run default, --apply writes to data/media/.",
    )
    pam.add_argument("--salvageable", action="store_true",
                     help="Archive items whose original 404'd but a preview still lives (urgent).")
    pam.add_argument("--galleries", action="store_true",
                     help="Archive the sized gallery_preview variants (~1080px).")
    pam.add_argument("--images", action="store_true",
                     help="Archive direct reddit images (the large set — ~10GB).")
    pam.add_argument("--limit", type=int, default=None,
                     help="Cap items with work this run (resumable).")
    pam.add_argument("--throttle", type=float, default=0.3,
                     help="Seconds between fetches — CDN politeness (default 0.3).")
    pam.add_argument("--apply", action="store_true", help="Fetch + write (default: dry run).")
    pam.set_defaults(func=cmd_archive_media)

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
    prs.add_argument("--reconcile", action="store_true",
                     help="Full-walk census: import new saves AND infer Reddit-side unsaves "
                          "(clear is_saved; promote still-inbox items to done). Destructive — back up first.")
    prs.add_argument("--reconcile-dry-run", action="store_true",
                     help="Preview --reconcile (lists the would-unsave set) with NO writes.")
    prs.add_argument("--enable-auto", action="store_true",
                     help="Arm the automatic background sync + PWA-open trigger (opt-in, default off).")
    prs.add_argument("--disable-auto", action="store_true",
                     help="Disarm the automatic sync.")
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
                    help="Unsave queued items. SAFE BY DEFAULT: a bare --drain is a DRY RUN that "
                         "lists the scope and sends nothing. Add --live --yes to execute (it "
                         "MUTATES your real Reddit Saved list). Exits non-zero on an expired auth.")
    pu.add_argument("--live", action="store_true",
                    help="With --drain: actually send. Requires --yes too (--live alone refuses).")
    pu.add_argument("--yes", action="store_true",
                    help="With --drain --live: the explicit go-ahead to mutate Reddit.")
    pu.add_argument("--dry-run", action="store_true",
                    help="With --drain: force the dry-run plan even if --live/--yes are present.")
    pu.add_argument("--trickle", action="store_true",
                    help="Bounded, non-interactive drain for a scheduled job (the opted-in "
                         "continuous lane): drains up to a small cap (default 25) WITHOUT "
                         "--live --yes, but ONLY when unsave-on-done is enabled — that opt-in + the "
                         "cap + the audit log is the consent. Use this for scheduled runs, not the "
                         "big-blast bulk `--drain --live --yes`.")
    pu.add_argument("--status", action="store_true",
                    help="Print status (configured? enabled? pending/failed counts) — also the "
                         "default when no flag is given.")
    pu.add_argument("--enqueue-existing", action="store_true",
                    help="One-time backfill: queue all reddit items already marked 'done'.")
    pu.add_argument("--limit", type=int, default=None, help="Max items to unsave this drain run.")
    pu.add_argument("--throttle", type=float, default=1.0,
                    help="Seconds between unsave requests (default 1.0).")
    pu.set_defaults(func=cmd_reddit_unsave)

    po = sub.add_parser(
        "reddit-oauth",
        help="Set up / inspect the sanctioned Reddit OAuth transport (installed-app, no client "
             "secret; read + history + identity + save scopes). No args = status; --login "
             "authorizes (one-time, interactive).")
    po.add_argument("--login", action="store_true",
                    help="Interactive one-time authorization: prints an authorize URL, then takes "
                         "the redirected URL/code. Needs REDDIT_OAUTH_CLIENT_ID set.")
    po.add_argument("--logout", action="store_true", help="Clear the stored OAuth tokens.")
    po.add_argument("--status", action="store_true",
                    help="Print OAuth status (configured? username? — the default with no flag).")
    po.set_defaults(func=cmd_reddit_oauth)

    return p


def main(argv=None) -> int:
    config.load_env()
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
