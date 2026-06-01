"""Command-line interface: init-db, import, enrich, serve, stats, sources, bankruptcy, promote."""

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
    with _connect():
        pass
    print(f"Initialized database at {config.db_path()}")
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
        if getattr(args, "archives", False):
            from content_hoarder.archival import service as archival
            n = archival.count_targets(conn, retry=args.all)
            print(f"{n} reddit item(s) need recovery; querying archives...", file=sys.stderr)
            res = archival.recover(conn, limit=args.limit, retry=args.all,
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
        res = cat_mod.categorize_source(conn, args.source or "youtube",
                                        limit=args.limit, retry=args.all)
    print(json.dumps(res, indent=2))
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
    try:
        dt = datetime.datetime.fromisoformat(args.before)
    except ValueError:
        print(f"error: --before must be YYYY-MM-DD (got {args.before!r})", file=sys.stderr)
        return 2
    before_utc = int(dt.timestamp())
    with _connect() as conn:
        n = db.bankruptcy(conn, before_utc, source=args.source, dry_run=args.dry_run)
    verb = "would archive" if args.dry_run else "archived"
    print(f"{verb} {n} inbox item(s) older than {args.before}")
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
    pe.add_argument("--limit", type=int, default=None,
                    help="Max items to attempt this run (chunked/resumable recovery).")
    pe.set_defaults(func=cmd_enrich)

    pc = sub.add_parser("categorize", help="Tag items listenable/watch/wotagei (heuristics).")
    pc.add_argument("--source", default="youtube", help="Source to categorize (default: youtube).")
    pc.add_argument("--all", action="store_true", help="Re-categorize items that already have one.")
    pc.add_argument("--limit", type=int, default=None, help="Max items to categorize.")
    pc.set_defaults(func=cmd_categorize)

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

    pp = sub.add_parser("promote", help="Push 'keep' items to a stock Karakeep (opt-in).")
    pp.add_argument("--status", default="keep")
    pp.add_argument("--limit", type=int)
    pp.add_argument("--dry-run", action="store_true")
    pp.set_defaults(func=cmd_promote)

    px = sub.add_parser("export-obsidian", help="Write items to an Obsidian vault as Markdown.")
    px.add_argument("--vault", required=True)
    px.add_argument("--status", default="keep", help="Which status to export (default: keep).")
    px.set_defaults(func=cmd_export_obsidian)

    pg = sub.add_parser("suggest", help="Annotate inbox items with local-LLM keep/skip suggestions.")
    pg.add_argument("--source")
    pg.add_argument("--limit", type=int, default=20)
    pg.set_defaults(func=cmd_suggest)

    return p


def main(argv=None) -> int:
    config.load_env()
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
