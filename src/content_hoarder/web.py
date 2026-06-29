"""Flask app factory + routes (search, triage, status, sources, stats, import)."""

from __future__ import annotations

import atexit
import ipaddress
import json
import mimetypes
import os
import re
import secrets
import shutil
import subprocess
import tempfile
import time
from contextlib import closing
from pathlib import Path
from urllib.parse import urlsplit

from flask import Flask, jsonify, render_template, request, send_from_directory

from content_hoarder import config, connectors, db, pipeline, resurface, search_query


def _int(value, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


# Tailscale hands out CGNAT-range addresses; ipaddress doesn't class them as private.
_TAILSCALE_NET = ipaddress.ip_network("100.64.0.0/10")


def _local_host(host: str) -> bool:
    """True when ``host`` (name/IP, no port) is this machine, a private/LAN address, a
    tailnet peer, or an explicitly allowed extra host (``CONTENT_HOARDER_ALLOWED_HOSTS``,
    comma-separated). Everything else is a DNS-rebinding suspect."""
    h = (host or "").strip("[]").lower()
    if not h:
        return False
    if h == "localhost" or h.endswith(".localhost") or h.endswith(".ts.net"):
        return True
    extra = {
        x.strip().lower()
        for x in config.get("CONTENT_HOARDER_ALLOWED_HOSTS").split(",")
        if x.strip()
    }
    if h in extra:
        return True
    try:
        ip = ipaddress.ip_address(h)
    except ValueError:
        return False  # a public DNS name — not how this app is served
    return ip.is_loopback or ip.is_private or ip in _TAILSCALE_NET


def create_app(db_path: str | None = None) -> Flask:
    config.load_env()
    # Windows reads MIME types from the registry, which can map .js to text/plain —
    # that hard-fails <script type="module">. Pin the correct type before any static
    # file is served (v3 pages load ES modules from /static/core and /static/browse).
    mimetypes.add_type("text/javascript", ".js")
    app = Flask(__name__)
    app.config["DB_PATH"] = db_path or config.db_path()
    app.config["SECRET_KEY"] = config.get("FLASK_SECRET_KEY")

    def conn():
        return closing(db.connect(app.config["DB_PATH"]))

    def _backup_db(suffix: str) -> Path:
        stamp = time.strftime("%Y%m%d-%H%M%S") + f"-{int((time.time() % 1) * 1000):03d}"
        bak = Path(app.config["DB_PATH"]).with_name(f"app.backup-{suffix}-{stamp}.db")
        with closing(db.connect(str(bak))) as dst, conn() as src:
            src.backup(dst)
        return bak

    def _append_delete_audit(record: dict) -> None:
        audit_path = Path(app.config["DB_PATH"]).with_name("delete-audit.jsonl")
        with audit_path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(record, ensure_ascii=False) + "\n")

    def _parse_retention_days(value) -> int | None:
        try:
            days = int(value)
        except (TypeError, ValueError):
            return None
        return days if 1 <= days <= 3650 else None

    # Async unsave trickle: a Done enqueues instantly (db.set_status); this background drainer
    # flushes a small capped batch once triage settles (idle debounce). Opt-in via
    # reddit_unsave_on_done + bounded (small cap, jitter, audit) — that's the consent, not a
    # per-fire prompt. The big-blast bulk drain keeps its --live --yes gate. See reddit_trickle.
    from content_hoarder import reddit_trickle, reddit_unsave

    _unsave_audit, _unsave_audit_path = reddit_unsave.audit_appender(
        app.config["DB_PATH"]
    )
    _trickle = reddit_trickle.TrickleDrainer(conn, audit=_unsave_audit)

    # Automatic Reddit saved-sync: a background scheduler periodically imports new saves and (on a
    # slower cadence) reconciles Reddit-side unsaves; the PWA-open hook (POST /reddit/sync/auto) funnels
    # into the SAME debounced auto_sync path. Opt-in (reddit_autosync_enabled, default off) — only then
    # do we spin the daemon timer, so the test suite (which builds many apps) stays timer-free. Toggling
    # it on takes effect for the foreground PWA-open path immediately; the background thread starts on the
    # next app launch. See reddit_sync.auto_sync / SyncScheduler.
    from content_hoarder import reddit_sync as _reddit_sync

    _sync_scheduler = None
    with conn() as _c0:
        if _reddit_sync.is_autosync_enabled(_c0):
            _interval = _int(config.get("REDDIT_AUTOSYNC_INTERVAL"), 600) or 600
            _sync_scheduler = _reddit_sync.SyncScheduler(
                conn, interval=_interval
            ).start()
            atexit.register(_sync_scheduler.stop)

    @app.before_request
    def _same_origin_guard():
        # CSRF / DNS-rebinding guard. The app holds a live reddit_session cookie and some
        # POSTs are destructive against the real Reddit account (mass-unsave drain), so a
        # malicious page must not be able to drive it: (1) reject ANY request whose Host
        # isn't local/private/tailnet — a rebound public DNS name fails this; (2) browsers
        # attach Origin to every cross-origin POST (no-cors fetch + form posts included),
        # so reject state-changing requests whose Origin doesn't match our Host. Requests
        # without an Origin (curl, CLI, same-origin GETs) pass untouched.
        try:  # a malformed (e.g. bad-IPv6) Host header must reject, not 500
            host = urlsplit("//" + (request.host or "")).hostname or ""
        except ValueError:
            host = ""
        if not _local_host(host):
            return jsonify({"error": "forbidden host"}), 403
        if request.method in ("POST", "PUT", "PATCH", "DELETE"):
            origin = request.headers.get("Origin", "")
            try:
                origin_loc = urlsplit(origin).netloc.lower() if origin else ""
            except ValueError:
                origin_loc = "\x00invalid"  # never matches -> rejected below
            if origin and origin_loc != (request.host or "").lower():
                return jsonify({"error": "cross-origin request rejected"}), 403

    # -- pages -------------------------------------------------------------

    @app.get("/")
    def index():
        return render_template("index.html")

    @app.get("/triage")
    def triage():
        return render_template("triage.html")

    @app.get("/manifest.webmanifest")
    def manifest():
        return send_from_directory(
            app.static_folder or os.path.join(app.root_path, "static"),
            "manifest.webmanifest",
            mimetype="application/manifest+json",
        )

    # -- data --------------------------------------------------------------

    @app.get("/export")
    def export_list():
        """CSV/JSON list export of whatever the filters match (Epic 9a — e.g.
        ?tag=nsfw_erotic for the migrate-elsewhere set). Accepts the same q/operator
        and param filters as /items; no pagination — the whole match is returned."""
        from content_hoarder import export as export_mod

        a = request.args
        parsed = search_query.parse(a.get("q", ""))
        is_saved_param = a.get("is_saved")
        is_saved = (
            parsed.is_saved
            if parsed.is_saved is not None
            else _int(is_saved_param)
            if is_saved_param not in (None, "")
            else None
        )
        tags = parsed.tags if parsed.tags else (a.getlist("tag") or None)
        tags_all = parsed.tags_all if parsed.tags else False
        with conn() as c:
            rows = db.search_items(
                c,
                parsed.text,
                source=parsed.source
                if parsed.source is not None
                else (a.get("source") or None),
                kind=parsed.kind
                if parsed.kind is not None
                else (a.get("kind") or None),
                status=parsed.status
                if parsed.status is not None
                else (a.get("status") or None),
                tags=tags,
                tags_all=tags_all,
                subreddit=parsed.subreddit
                if parsed.subreddit is not None
                else (a.get("subreddit") or None),
                author=parsed.author
                if parsed.author is not None
                else (a.get("author") or None),
                is_saved=is_saved,
                nsfw=parsed.nsfw,
                decayed=parsed.decayed,
                swept=parsed.swept,
                deleted=parsed.deleted,
                has_media=parsed.has,
                before=parsed.before,
                after=parsed.after,
                score_min=parsed.score_min,
                score_max=parsed.score_max,
                exact=parsed.exact,
                exclude=parsed.exclude,
                include_consolidated=True,
                fuzzy=a.get("exact") != "1",
                sort=a.get("sort", "created_utc"),
                order=a.get("order", "desc"),
                limit=1_000_000,
                offset=0,
            )
        recs = export_mod.export_records(rows)
        if (a.get("format") or "csv").lower() == "json":
            return {"count": len(recs), "items": recs}
        return app.response_class(
            export_mod.to_csv(recs),
            mimetype="text/csv",
            headers={
                "Content-Disposition": "attachment; filename=content-hoarder-export.csv"
            },
        )

    @app.get("/items")
    def items():
        a = request.args
        limit = min(max(_int(a.get("limit"), 50), 1), 500)
        offset = max(_int(a.get("offset"), 0), 0)

        # Search operators (docs/search-operators-spec.md): a typed operator wins over the
        # dropdown param for that key; when the operator is absent (or malformed), the
        # explicit query param (if any) remains authoritative.
        parsed = search_query.parse(a.get("q", ""))

        is_saved_param = a.get("is_saved")
        is_saved = (
            parsed.is_saved
            if parsed.is_saved is not None
            else _int(is_saved_param)
            if is_saved_param not in (None, "")
            else None
        )

        tags = parsed.tags if parsed.tags else (a.getlist("tag") or None)
        tags_all = parsed.tags_all if parsed.tags else False
        status_filter = (
            parsed.status if parsed.status is not None else (a.get("status") or None)
        )

        with conn() as c:
            rows = db.search_items(
                c,
                parsed.text,
                source=parsed.source
                if parsed.source is not None
                else (a.get("source") or None),
                kind=parsed.kind
                if parsed.kind is not None
                else (a.get("kind") or None),
                status=status_filter,
                category=a.get("category") or None,
                tags=tags,
                tags_all=tags_all,
                subreddit=parsed.subreddit
                if parsed.subreddit is not None
                else (a.get("subreddit") or None),
                author=parsed.author
                if parsed.author is not None
                else (a.get("author") or None),
                is_saved=is_saved,
                nsfw=parsed.nsfw,
                decayed=parsed.decayed,
                swept=parsed.swept,
                snoozed=parsed.snoozed,
                hide_snoozed=not parsed.snoozed and status_filter == "inbox",
                deleted=parsed.deleted,
                has_media=parsed.has,
                before=parsed.before,
                after=parsed.after,
                score_min=parsed.score_min,
                score_max=parsed.score_max,
                exact=parsed.exact,
                exclude=parsed.exclude,
                open_in_firefox=parsed.open_in_firefox
                or a.get("open_in_firefox") in ("1", "true"),
                # Fuzzy by default (Epic 12, user decision): bare terms are typo-tolerant;
                # "quoted phrases" are always exact (parser routes them to exact=);
                # ?exact=1 (the repurposed checkbox) forces the exact FTS path.
                fuzzy=a.get("exact") != "1",
                hide_nsfw=a.get("safe") in ("1", "true"),
                sort=a.get("sort", "last_seen_utc"),
                order=a.get("order", "desc"),
                limit=limit + 1,
                offset=offset,
            )
            has_more = len(rows) > limit
            return jsonify({"items": rows[:limit], "has_more": has_more})

    @app.get("/items/<path:fullname>")
    def item_detail(fullname):
        with conn() as c:
            item = db._public_by_fullname(c, fullname)
        if item is None:
            return jsonify({"error": "not found"}), 404
        return jsonify(item)

    @app.get("/random")
    def random_batch():
        a = request.args
        n = min(max(_int(a.get("n"), 20), 1), 100)
        with conn() as c:
            rows = db.get_random_batch(
                c,
                n,
                source=a.get("source") or None,
                unprocessed=a.get("unprocessed", "1") != "0",
                mode=a.get("mode") or "random",
            )
        return jsonify({"items": rows})

    @app.post("/items/<path:fullname>/status")
    def set_status(fullname):
        body = request.get_json(silent=True) or request.form
        status = (body.get("status") or "").strip()
        try:
            with conn() as c:
                item = db.set_status(c, fullname, status)
                # Arm the unsave trickle when a reddit item is Done and unsave-on-done is opted in;
                # read the flag on this same conn (no extra connection in the hot path).
                arm_trickle = (
                    item is not None
                    and status == "done"
                    and fullname.startswith("reddit:")
                    and db.get_setting(c, "reddit_unsave_on_done", "0") == "1"
                )
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
        if item is None:
            return jsonify({"error": "not found"}), 404
        if arm_trickle:  # (re)arm the idle debounce; returns immediately
            _trickle.note_enqueue()
        return jsonify(item)

    @app.post("/items/<path:fullname>/snooze")
    def snooze_item(fullname):
        body = request.get_json(silent=True) or {}
        now = int(time.time())
        window_days = _int(body.get("window_days"), 7) or 7
        until_utc = _int(body.get("until_utc"), 0) or now + window_days * 86400
        escalate_after = _int(body.get("escalate_after"), 3) or 3
        try:
            with conn() as c:
                res = db.snooze(
                    c,
                    fullnames=[fullname],
                    until_utc=until_utc,
                    window_days=window_days,
                    escalate_after=escalate_after,
                    apply=True,
                )
        except ValueError as exc:
            msg = str(exc)
            return jsonify({"error": msg}), 404 if msg.startswith(
                "unknown item"
            ) else 400
        return jsonify(res)

    @app.post("/snooze/undo")
    def snooze_undo():
        body = request.get_json(silent=True) or {}
        try:
            with conn() as c:
                if isinstance(body.get("snoozed_wave"), int):
                    return jsonify(
                        db.unsnooze(c, snoozed_wave=body["snoozed_wave"], apply=True)
                    )
                if isinstance(body.get("decayed_at"), int):
                    wave = int(body["decayed_at"])
                    return jsonify(
                        db.undecay(
                            c,
                            decayed_after=wave,
                            decayed_before=wave + 1,
                            apply=True,
                        )
                    )
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
        return jsonify({"error": "snoozed_wave or decayed_at required"}), 400

    @app.post("/items/<path:fullname>/undo")
    def undo(fullname):
        from content_hoarder import reddit_unsave as ru

        with conn() as c:
            # A Done whose unsave already drained was *actually removed from Reddit Saved*;
            # undoing only the local status would leave the two sides silently divergent
            # (is_saved=0, gone on Reddit). Mirror the Reddit-view undo: attempt a live
            # re-save, and surface a warning when it can't be done (dead cookie / offline).
            prior = c.execute(
                "SELECT i.status AS status, q.state AS state FROM items i "
                "LEFT JOIN reddit_unsave q ON q.fullname = i.fullname WHERE i.fullname=?",
                (fullname,),
            ).fetchone()
            item = db.undo_status(c, fullname)
            if item is None:
                return jsonify({"error": "not found"}), 404
            if (
                prior
                and prior["status"] == "done"
                and prior["state"] == "done"
                and item["status"] != "done"
            ):
                if ru.resave(c, fullname):
                    item = db._public_by_fullname(c, fullname)  # is_saved restored to 1
                else:
                    item = dict(item)
                    item["warning"] = (
                        "restored locally, but still unsaved on Reddit "
                        "(re-save failed — check the session cookie)"
                    )
        return jsonify(item)

    @app.post("/items/<path:fullname>/suggest")
    def suggest(fullname):
        from content_hoarder.assist import llm

        if not llm.is_available():
            return jsonify({"error": "LLM not configured"}), 503
        with conn() as c:
            s = llm.suggest_and_store(c, fullname)
        if s is None:
            return jsonify({"error": "no suggestion"}), 502
        return jsonify(s)

    @app.get("/tag-suggestions")
    def list_tag_suggestions():
        from content_hoarder import tag_suggest

        status = request.args.get("status", "pending")
        tag = request.args.get("tag")
        source_type = request.args.get("source_type")
        try:
            limit = int(request.args["limit"]) if "limit" in request.args else None
        except (ValueError, KeyError):
            limit = None
        with conn() as c:
            suggestions = tag_suggest.list_suggestions(
                c, status=status, tag=tag, source_type=source_type, limit=limit
            )
            counts = tag_suggest.suggestion_counts(c, status=status)
        return jsonify(
            {"suggestions": suggestions, "by_tag": counts, "total": len(suggestions)}
        )

    @app.post("/tag-suggestions/<int:suggestion_id>/accept")
    def accept_tag_suggestion(suggestion_id):
        from content_hoarder import tag_suggest

        with conn() as c:
            res = tag_suggest.accept_suggestion(c, suggestion_id)
        if res is None:
            return jsonify({"error": "not found or not pending"}), 404
        return jsonify(res)

    @app.post("/tag-suggestions/<int:suggestion_id>/reject")
    def reject_tag_suggestion(suggestion_id):
        from content_hoarder import tag_suggest

        with conn() as c:
            res = tag_suggest.reject_suggestion(c, suggestion_id)
        if res is None:
            return jsonify({"error": "not found or not pending"}), 404
        return jsonify(res)

    @app.post("/tag-suggestions/accept-all")
    def accept_all_tag_suggestions():
        from content_hoarder import tag_suggest

        data = request.get_json(silent=True) or {}
        with conn() as c:
            n = tag_suggest.accept_all_suggestions(c, tag=data.get("tag"))
        return jsonify({"accepted": n})

    @app.post("/tag-suggestions/reject-all")
    def reject_all_tag_suggestions():
        from content_hoarder import tag_suggest

        data = request.get_json(silent=True) or {}
        with conn() as c:
            n = tag_suggest.reject_all_suggestions(c, tag=data.get("tag"))
        return jsonify({"rejected": n})

    # ------------------------------------------------------------------
    # Folder routes (Epic 26)
    # ------------------------------------------------------------------

    @app.get("/folders")
    def list_folders():
        from content_hoarder import db

        with conn() as c:
            folders = db.list_folders(c)
            counts = db.folder_counts(c)
        for f in folders:
            f["count"] = counts.get(f["name"], 0)
        return jsonify(folders)

    @app.post("/folders")
    def create_folder():
        from content_hoarder import db

        data = request.get_json(silent=True) or {}
        name = data.get("name", "").strip()
        if not name:
            return jsonify({"error": "name required"}), 400
        qd = data.get("query_def") or {}
        desc = data.get("description", "")
        with conn() as c:
            try:
                f = db.create_folder(c, name, qd, desc)
            except ValueError as exc:
                return jsonify({"error": str(exc)}), 409
        return jsonify(f), 201

    @app.patch("/folders/<int:folder_id>")
    def update_folder(folder_id):
        from content_hoarder import db

        data = request.get_json(silent=True) or {}
        with conn() as c:
            if "name" in data:
                try:
                    f = db.rename_folder(c, folder_id, data["name"])
                except ValueError as exc:
                    return jsonify({"error": str(exc)}), 409
                if f is None:
                    return jsonify({"error": "not found"}), 404
            else:
                return jsonify({"error": "nothing to update"}), 400
        return jsonify(f)

    @app.delete("/folders/<int:folder_id>")
    def delete_folder(folder_id):
        from content_hoarder import db

        with conn() as c:
            if db.delete_folder(c, folder_id):
                return jsonify({"deleted": folder_id})
            return jsonify({"error": "not found"}), 404

    @app.post("/folders/evaluate")
    def evaluate_folders():
        from content_hoarder import folders as fmod

        data = request.get_json(silent=True) or {}
        folder_id = data.get("folder_id")
        with conn() as c:
            if folder_id:
                res = fmod.evaluate_folder(c, int(folder_id))
                results = [res] if isinstance(res, dict) else res
            else:
                results = fmod.evaluate_all_folders(c)
        return jsonify({"results": results})

    @app.patch("/items/<path:fullname>/folder")
    def set_item_folder(fullname):
        from content_hoarder import db

        data = request.get_json(silent=True) or {}
        folder = data.get("folder")
        with conn() as c:
            if db.set_item_folder(c, fullname, folder):
                return jsonify({"fullname": fullname, "folder": folder})
            return jsonify({"error": "not found"}), 404

    @app.get("/folders/stats")
    def folder_stats():
        from content_hoarder import db

        with conn() as c:
            counts = db.folder_counts(c)
        return jsonify(counts)

    @app.post("/items/<path:fullname>/recover")
    def recover_item(fullname):
        from content_hoarder.archival import service as archival
        from content_hoarder.archival.providers import default_media_providers

        with conn() as c:
            res = archival.recover_one(
                c,
                fullname,
                media_providers=default_media_providers(
                    archival.DEFAULT_USER_AGENT, throttle=False
                ),
            )
        if res is None:
            return jsonify({"error": "not a recoverable reddit item"}), 400
        return jsonify(res)

    @app.post("/items/<path:fullname>/body")
    def set_body_route(fullname):
        data = request.get_json(silent=True) or {}
        with conn() as c:
            updated = db.set_body(c, fullname, str(data.get("body") or ""))
            if updated is None:
                return jsonify({"error": "not found"}), 404
            c.commit()
        return jsonify(updated)

    @app.post("/reddit/items/<path:fullname>/hydrate")
    def hydrate_item(fullname):
        from content_hoarder import reddit_hydrate

        with conn() as c:
            res = reddit_hydrate.hydrate_one(c, fullname)
        status = res.get("status")
        if status in ("hydrated", "archived"):
            return jsonify(res), 200
        if status == "not_found":
            return jsonify(res), 404
        if status in ("no_permalink", "bad_shape"):
            return jsonify(res), 400
        if status in ("auth_missing", "auth_expired"):
            return jsonify(res), 401
        if status == "network_error":
            return jsonify(res), 502
        return jsonify(res), 500

    @app.post("/items/<path:fullname>/category")
    def set_category(fullname):
        from content_hoarder.categorize import VALID_CATEGORIES

        body = request.get_json(silent=True) or {}
        cat = (body.get("category") or "").strip().lower()
        if cat not in VALID_CATEGORIES:
            return jsonify({"error": "invalid category"}), 400
        with conn() as c:
            if db.get_item(c, fullname) is None:
                return jsonify({"error": "not found"}), 404
            db.set_category(c, fullname, cat)
            c.commit()
        return jsonify({"fullname": fullname, "category": cat})

    @app.post("/items/<path:fullname>/tags")
    def set_item_tags(fullname):
        # Manual tagging: body = {"add": [...], "remove": [...]} (or {"tag": "x"} shorthand).
        # Adds are stamped manual (survive recategorize/re-import); non-destructive.
        body = request.get_json(silent=True) or {}
        add = body.get("add") or ([body["tag"]] if body.get("tag") else [])
        remove = body.get("remove") or []
        if not isinstance(add, list) or not isinstance(remove, list):
            return jsonify({"error": "add/remove must be lists"}), 400
        if not add and not remove:
            return jsonify({"error": "no tags given"}), 400
        with conn() as c:
            tags = db.set_tags(c, fullname, add=add, remove=remove)
            if tags is None:
                return jsonify({"error": "not found"}), 404
            c.commit()
        return jsonify({"fullname": fullname, "tags": tags})

    @app.post("/bulk/status")
    def bulk_status():
        data = request.get_json(silent=True) or {}
        fullnames = data.get("fullnames") or []
        status = (data.get("status") or "").strip()
        try:
            with conn() as c:
                n = db.bulk_set_status(c, fullnames, status)
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
        return jsonify({"updated": n})

    @app.get("/duplicates")
    def duplicates_route():
        from content_hoarder import dedup

        by = (request.args.get("by") or "url").strip().lower()
        status = (request.args.get("status") or "inbox").strip().lower()
        if by not in ("url", "title"):
            return jsonify({"error": "by must be url or title"}), 400
        if status not in ("inbox", "keep", "archived", "done"):
            return jsonify({"error": "invalid status"}), 400
        with conn() as c:
            groups = dedup.find_groups(c, by=by, status=status)
        return jsonify({"groups": groups, "by": by, "status": status})

    @app.post("/duplicates/resolve")
    def duplicates_resolve_route():
        from content_hoarder import dedup

        body = request.get_json(silent=True) or {}
        keep = str(body.get("keep") or "").strip()
        archive = body.get("archive") or []
        if not keep or not isinstance(archive, list):
            return jsonify({"error": "keep and archive list required"}), 400
        with conn() as c:
            return jsonify(dedup.resolve_group(c, keep, archive))

    @app.post("/duplicates/undo")
    def duplicates_undo_route():
        from content_hoarder import dedup

        body = request.get_json(silent=True) or {}
        fullnames = body.get("fullnames") or []
        if not isinstance(fullnames, list) or not fullnames:
            return jsonify({"error": "fullnames list required"}), 400
        with conn() as c:
            return jsonify(dedup.undo_resolve(c, fullnames))

    # -- done retention settings / purge ----------------------------------

    @app.get("/settings/done-retention")
    def done_retention_settings():
        now = int(time.time())
        with conn() as c:
            try:
                retention_days = int(db.get_setting(c, "done_retention_days", 30) or 30)
            except ValueError:
                retention_days = 30
                db.set_setting(c, "done_retention_days", "30")
            preview = db.purge_done(c, now=now, apply=False)
        return jsonify(
            {"retention_days": retention_days, "preview": preview, "now": now}
        )

    @app.post("/settings/done-retention")
    def done_retention_set():
        body = request.get_json(silent=True) or {}
        retention_days = _parse_retention_days(body.get("retention_days"))
        if retention_days is None:
            return jsonify(
                {"error": "retention_days must be an integer between 1 and 3650"}
            ), 400
        now = int(time.time())
        with conn() as c:
            db.set_setting(c, "done_retention_days", str(retention_days))
            preview = db.purge_done(c, now=now, apply=False)
        return jsonify(
            {"retention_days": retention_days, "preview": preview, "now": now}
        )

    @app.post("/settings/done-retention/purge")
    def done_retention_purge():
        body = request.get_json(silent=True) or {}
        expected_total_raw = body.get("expected_total")
        expected_cutoff_raw = body.get("expected_cutoff")
        if not isinstance(
            expected_total_raw, (str, bytes, bytearray, int, float)
        ) or not isinstance(
            expected_cutoff_raw, (str, bytes, bytearray, int, float)
        ):
            return jsonify(
                {"error": "expected_total and expected_cutoff are required"}
            ), 400
        try:
            expected_total = int(expected_total_raw)
            expected_cutoff = int(expected_cutoff_raw)
        except ValueError:
            return jsonify(
                {"error": "expected_total and expected_cutoff are required"}
            ), 400

        now = int(time.time())
        with conn() as c:
            plan = db.purge_done(c, now=now, apply=False)
            if plan["total"] != expected_total or plan["cutoff"] != expected_cutoff:
                return jsonify(
                    {
                        "error": "purge preview changed; review the updated count before deleting",
                        "preview": plan,
                    }
                ), 409
            if plan["total"] == 0:
                return jsonify(
                    {
                        "error": "no Done items currently qualify for purge",
                        "preview": plan,
                    }
                ), 409

            victims = [
                {"fullname": r[0], "source": r[1], "title": (r[2] or "")[:80]}
                for r in c.execute(
                    "SELECT fullname, source, title FROM items WHERE status='done' "
                    "AND processed_utc IS NOT NULL AND processed_utc < ? ORDER BY processed_utc",
                    (plan["cutoff"],),
                ).fetchall()
            ]
            bak = _backup_db("pre-purge-done")
            try:
                res = db.purge_done(c, now=now, apply=True)
            except ValueError as exc:
                return jsonify({"error": str(exc), "preview": plan}), 400
            preview = db.purge_done(c, now=now, apply=False)

        audit = {
            "ts": int(time.time()),
            "op": "purge_done",
            "retention_days": res["retention_days"],
            "cutoff": res["cutoff"],
            "total": res["total"],
            "threads_deleted": res["threads_deleted"],
            "backup": str(bak),
            "victims": victims[:200],
        }
        _append_delete_audit(audit)
        res["backup"] = str(bak)
        return jsonify({"purged": res, "preview": preview})

    # -- reddit unsave: cookie auth + on-demand queue drain --------------

    @app.get("/reddit/unsave/status")
    def reddit_unsave_status():
        from content_hoarder import reddit_unsave as ru

        with conn() as c:
            auth = ru.get_auth(c)
            return jsonify(
                {
                    "configured": auth is not None,
                    "username": auth.get("username") if auth else None,
                    "enabled": db.get_setting(c, "reddit_unsave_on_done", "0") == "1",
                    "pending": ru.count_pending(c),
                    "failed": ru.count_failed(c),
                }
            )

    @app.post("/reddit/unsave/auth")
    def reddit_unsave_auth():
        from content_hoarder import reddit_unsave as ru

        body = request.get_json(silent=True) or {}
        cookie = (body.get("cookie") or "").strip()
        if not cookie:
            return jsonify(
                {"ok": False, "error": "paste your reddit_session cookie"}
            ), 400
        try:
            with conn() as c:
                username = ru.login(c, cookie)
        except ru.RedditAuthError as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400
        return jsonify({"ok": True, "username": username})

    @app.post("/reddit/unsave/enable")
    def reddit_unsave_enable():
        body = request.get_json(silent=True) or {}
        enabled = bool(body.get("enabled"))
        with conn() as c:
            db.set_setting(c, "reddit_unsave_on_done", "1" if enabled else "0")
        return jsonify({"enabled": enabled})

    @app.post("/reddit/unsave/drain")
    def reddit_unsave_drain():
        from content_hoarder import reddit_unsave as ru

        body = request.get_json(silent=True) or {}
        # Cap per request (~50s at the 1 req/s throttle) — an unbounded drain of a big
        # queue is a 30+ minute HTTP request. The response's `remaining` lets the UI
        # loop; the CLI/scheduled job is the right tool for bulk drains.
        limit = min(max(_int(body.get("max"), 50), 1), 500)
        with conn() as c:
            # Pass the shared audit appender: a web-initiated live drain is a real money-action and
            # must leave the same reconstructable unsave-audit.jsonl trail as the CLI/trickle paths.
            res = ru.drain(c, limit=limit, audit=_unsave_audit)
        return jsonify(res)

    @app.post("/items/<path:fullname>/resave")
    def resave_item(fullname):
        from content_hoarder import reddit_unsave as ru

        with conn() as c:
            ok = ru.resave(c, fullname)
        return jsonify({"resaved": ok})

    # -- reddit management view (reuses the RSM interface over the items table) --

    def _reddit_view(it: dict) -> dict:
        """Flatten a content-hoarder item into the flat shape the Reddit UI expects."""
        m = it.get("metadata") or {}
        return {
            "fullname": it.get("fullname"),
            "reddit_id": it.get("source_id"),
            "kind": it.get("kind"),
            "title": it.get("title"),
            "body": it.get("body"),
            "url": it.get("url"),
            "permalink": m.get("permalink") or "",
            "subreddit": m.get("subreddit") or "",
            "author": it.get("author"),
            "score": m.get("score") or 0,
            "over_18": 1 if m.get("over_18") else 0,
            "num_comments": m.get("num_comments") or 0,
            "created_utc": it.get("created_utc"),
            "saved_utc": it.get("saved_utc"),
            "first_seen_utc": it.get("first_seen_utc"),
            "is_saved": it.get("is_saved"),
            "status": it.get("status"),
            "media_type": m.get("media_type") or "",
            "media_url": m.get("media_url") or "",
            "tags": m.get("tags") or [],
        }

    @app.get("/reddit")
    def reddit_page():
        return render_template("reddit.html")

    @app.get("/reddit/items")
    def reddit_items():
        a = request.args
        limit = min(max(_int(a.get("limit"), 100), 1), 500)
        offset = max(_int(a.get("offset"), 0), 0)

        parsed = search_query.parse(a.get("q", ""))

        is_saved_param = a.get("is_saved")
        is_saved = (
            parsed.is_saved
            if parsed.is_saved is not None
            else _int(is_saved_param)
            if is_saved_param not in (None, "")
            else None
        )

        tags = parsed.tags if parsed.tags else (a.getlist("tag") or None)
        tags_all = parsed.tags_all if parsed.tags else False

        with conn() as c:
            rows = db.search_items(
                c,
                parsed.text,
                source="reddit",  # route is reddit-scoped regardless of source: operator
                kind=parsed.kind
                if parsed.kind is not None
                else (a.get("kind") or None),
                status=parsed.status
                if parsed.status is not None
                else (a.get("status") or None),
                subreddit=parsed.subreddit
                if parsed.subreddit is not None
                else (a.get("subreddit") or None),
                author=parsed.author
                if parsed.author is not None
                else (a.get("author") or None),
                tags=tags,
                tags_all=tags_all,
                is_saved=is_saved,
                nsfw=parsed.nsfw,
                decayed=parsed.decayed,
                swept=parsed.swept,
                deleted=parsed.deleted,
                has_media=parsed.has,
                before=parsed.before,
                after=parsed.after,
                score_min=parsed.score_min,
                score_max=parsed.score_max,
                exact=parsed.exact,
                exclude=parsed.exclude,
                include_consolidated=True,
                # Fuzzy by default (Epic 12, user decision): bare terms are typo-tolerant;
                # "quoted phrases" are always exact (parser routes them to exact=);
                # ?exact=1 (the repurposed checkbox) forces the exact FTS path.
                fuzzy=a.get("exact") != "1",
                # Default to newest-synced-first — the closest proxy to newest-saved-first, since
                # Reddit exposes no save timestamp (see docs/reddit-management.md).
                sort=a.get("sort", "first_seen_utc"),
                order=a.get("order", "desc"),
                limit=limit + 1,
                offset=offset,
            )
        has_more = len(rows) > limit
        return jsonify(
            {"items": [_reddit_view(r) for r in rows[:limit]], "has_more": has_more}
        )

    @app.get("/reddit/subreddits")
    def reddit_subreddits():
        status = request.args.get("status") or None
        with conn() as c:
            return jsonify({"subreddits": db.reddit_subreddit_counts(c, status=status)})

    @app.get("/reddit/stats")
    def reddit_stats_route():
        with conn() as c:
            return jsonify(db.reddit_stats(c))

    @app.get("/reddit/items/<path:fullname>/thread")
    def reddit_thread_route(fullname):
        from content_hoarder import reddit_hydrate, reddit_thread

        sort = request.args.get("sort", "best")
        if sort not in ("best", "top", "new"):
            sort = "best"
        no_fetch = request.args.get("nofetch") == "1"  # opt out of the lazy live fetch
        with conn() as c:
            # Lazy hydration: on the first open of an un-cached reddit thread, fetch + store it
            # (cookie, with PullPush/Arctic-Shift archive fallback), then serve from cache.
            hres = None if no_fetch else reddit_hydrate.hydrate_if_missing(c, fullname)
            res = reddit_thread.get_thread(c, fullname, sort)
            if res is None:
                return jsonify({"error": "not found"}), 404
            if hres is not None:
                res["hydrate_status"] = hres.get(
                    "status"
                )  # hydrated|archived|cached|auth_*|...
        return jsonify(res)

    @app.get("/hackernews/items/<path:fullname>/thread")
    def hn_thread_route(fullname):
        from content_hoarder import hn_thread

        sort = request.args.get("sort", "top")
        if sort not in ("top", "new", "default", "best"):
            sort = "top"
        no_fetch = request.args.get("nofetch") == "1"
        with conn() as c:
            if db.get_item(c, fullname) is None:
                return jsonify({"error": "not found"}), 404
            hres = None if no_fetch else hn_thread.hydrate_if_missing(c, fullname)
            res = hn_thread.get_thread(c, fullname, sort)
            if res is None:
                return jsonify({"error": "not found"}), 404
            if hres is not None:
                res["hydrate_status"] = hres.get("status")
        return jsonify(res)

    @app.post("/reddit/items/<path:fullname>/unsave")
    def reddit_unsave_one(fullname):
        # Queue for unsaving from the user's Reddit saved list. The Reddit call happens
        # on drain (cookie/OAuth); here we enqueue (works fully offline) and optimistically
        # flip is_saved=0 so the Reddit-view row immediately toggles to its "Undo" state.
        # A later drain confirms with Reddit; Undo (below) cancels a still-pending unsave.
        with conn() as c:
            if db.get_item(c, fullname) is None:
                return jsonify({"error": "not found"}), 404
            db.enqueue_unsave(c, fullname)
            c.execute("UPDATE items SET is_saved=0 WHERE fullname=?", (fullname,))
            c.commit()
        return jsonify({"queued": True, "fullname": fullname, "is_saved": 0})

    @app.post("/reddit/unsave/enqueue-by-tag")
    def reddit_unsave_by_tag():
        body = request.get_json(silent=True) or {}
        tag = str(body.get("tag", "") or "").strip()
        if not tag:
            return jsonify({"error": "tag required"}), 400
        apply = bool(
            body.get("confirm") or body.get("apply") or body.get("dry_run") is False
        )
        with conn() as c:
            res = db.enqueue_unsave_by_tag(c, tag, dry_run=not apply)
        res["confirmed"] = apply
        res["message"] = (
            "This only queues local unsaves. Reddit is not contacted until the existing "
            "explicit drain action runs."
        )
        return jsonify(res)

    @app.post("/reddit/items/<path:fullname>/undo")
    def reddit_undo_unsave(fullname):
        # Undo a Reddit-view "Unsave". If the unsave is still queued (not yet drained to
        # Reddit), just cancel it locally — no network call, never fails. If it was already
        # drained (actually unsaved on Reddit), do a live re-save. Otherwise just restore the
        # local flag. Returns {undone: bool} so the UI can report a genuine failure.
        from content_hoarder import reddit_unsave as ru

        with conn() as c:
            if db.get_item(c, fullname) is None:
                return jsonify({"error": "not found"}), 404
            row = c.execute(
                "SELECT state FROM reddit_unsave WHERE fullname=?", (fullname,)
            ).fetchone()
            state = row["state"] if row else None
            if state == "done":  # already removed from Reddit -> needs a live re-save
                ok = ru.resave(c, fullname)
                return jsonify({"undone": bool(ok), "method": "resave"})
            # pending (or never queued): cancel locally; no Reddit call needed.
            db.dequeue_unsave(c, fullname)
            c.execute("UPDATE items SET is_saved=1 WHERE fullname=?", (fullname,))
            c.commit()
        return jsonify({"undone": True, "method": "dequeued", "is_saved": 1})

    @app.post("/reddit/sync")
    def reddit_sync_route():
        from content_hoarder import reddit_sync

        body = request.get_json(silent=True) or {}
        full = bool(body.get("full"))
        max_pages = _int(body.get("max_pages"), 0)
        if max_pages <= 0:
            max_pages = 50 if full else 3
        max_pages = min(
            max_pages, 200
        )  # hard ceiling — ~200 throttled reqs is already extreme
        with conn() as c:
            res = reddit_sync.sync_saved(c, max_pages=max_pages, stop_on_known=not full)
        return jsonify(res)

    @app.post("/reddit/sync/auto")
    def reddit_sync_auto_route():
        """The PWA-open hook: fire-and-forget on app load / tab-focus. Debounced + two-speed inside
        auto_sync, and a NO-OP unless autosync is opted in — so the client can poll it freely. The
        background scheduler funnels into the same auto_sync path."""
        from content_hoarder import reddit_sync

        with conn() as c:
            if not reddit_sync.is_autosync_enabled(c):
                return jsonify({"skipped": "disabled"})
            res = reddit_sync.auto_sync(c)
        return jsonify(res)

    @app.get("/media/<blob>")
    def media_blob(blob):
        # Serve a locally-archived media blob from data/media/ (Epic 4 P1). Same-origin so the
        # service worker can finally cache reddit media + the UI can fall back here on a remote
        # 404. Content-addressed => immutable => cache forever. path_for is traversal-safe.
        from flask import send_file

        from content_hoarder import media_store

        p = media_store.path_for(blob)
        if not p:
            return jsonify({"error": "not found"}), 404
        resp = send_file(
            str(p), mimetype=media_store.mime_for(p.name), conditional=True
        )
        resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return resp

    @app.get("/sources")
    def sources():
        # Optional ?status= cross-filters the per-source counts (tabs by active status).
        status = request.args.get("status") or None
        with conn() as c:
            rows = db.source_counts(c, status=status)
        out = []
        for r in rows:  # source_counts only returns sources actually present in the DB
            x = connectors.REGISTRY.get(r["source"])
            out.append(
                {
                    "id": r["source"],
                    "label": x.label if x else r["source"],
                    "badge_color": x.badge_color if x else "#888888",
                    "count": r["count"],
                }
            )
        return jsonify({"sources": out})

    @app.get("/categories")
    def categories():
        source = request.args.get("source") or None
        status = request.args.get("status") or None
        with conn() as c:
            rows = db.category_counts(c, source=source, status=status)
            total = db._count_items(c, source=source, status=status)
        return jsonify(
            {
                "total": total,
                "categories": [
                    {
                        "id": r["category"],
                        "label": str(r["category"]).capitalize(),
                        "count": r["count"],
                    }
                    for r in rows
                ],
            }
        )

    @app.get("/tags")
    def tags():
        # Curated filter-tag counts for the browse rail, cross-filtered by the active
        # source/status. Kept off the hot /stats path (it's a json_each scan) so the
        # per-action status refresh stays cheap; the rail refetches this only on navigation.
        from content_hoarder import categorize

        source = request.args.get("source") or None
        status = request.args.get("status") or None
        with conn() as c:
            counts = db.tag_counts(c, source=source, status=status)
        # `groups` is the static parent→children rail grouping (Epic 26 P2); the rail nests the
        # curated `tags` counts under it. Tags stay flat — this is presentation only.
        return jsonify(
            {
                "tags": counts,
                "total": sum(counts.values()),
                "groups": categorize.tag_groups(),
            }
        )

    @app.get("/stats")
    def stats():
        # Optional ?source=/status= cross-filter the status/kind totals (rail + Stats modal).
        # ?light=1 returns just the status counts (the rail's per-action refresh) and skips the
        # full-table scans the Stats modal needs. Tag/category facet counts live on /tags and
        # /categories — see db.get_counts.
        source = request.args.get("source") or None
        status = request.args.get("status") or None
        light = request.args.get("light") == "1"
        with conn() as c:
            return jsonify(db.get_counts(c, source=source, status=status, light=light))

    @app.get("/pulse")
    def pulse():
        # Ambient console counts (win pebbles / "· N new" / decay line). Guilt-free by
        # contract: arrivals + manual clears today and the recent swept count — never a
        # backlog total (Epic 20 research mandate).
        with conn() as c:
            return jsonify(db.pulse(c))

    @app.get("/resurface")
    def resurface_card():
        # The ONE ambient slot: today's resurfacing question, or 204 when no cluster
        # qualifies (rationed to one card per day inside resurface.candidate).
        with conn() as c:
            card = resurface.candidate(c)
        return (jsonify(card), 200) if card else ("", 204)

    @app.post("/resurface/dismiss")
    def resurface_dismiss():
        # "Not now" — silent 30-day no-renag. Empty 204 by design: never mentioned again.
        cluster = (request.get_json(silent=True) or {}).get("cluster") or ""
        try:
            with conn() as c:
                resurface.dismiss(c, cluster)
        except ValueError:
            return jsonify({"error": "unknown cluster"}), 400
        return ("", 204)

    @app.post("/resurface/letgo")
    def resurface_letgo():
        # One-tap reversible cluster decay; the undo toast calls /resurface/letgo/undo.
        cluster = (request.get_json(silent=True) or {}).get("cluster") or ""
        try:
            with conn() as c:
                return jsonify(resurface.letgo(c, cluster))
        except ValueError:
            return jsonify({"error": "unknown cluster"}), 400

    @app.post("/resurface/letgo/undo")
    def resurface_letgo_undo():
        body = request.get_json(silent=True) or {}
        cluster = body.get("cluster") or ""
        decayed_at = body.get("decayed_at")
        if not isinstance(decayed_at, int):
            return jsonify({"error": "decayed_at required"}), 400
        try:
            with conn() as c:
                return jsonify(resurface.undo_letgo(c, cluster, decayed_at))
        except ValueError:
            return jsonify({"error": "unknown cluster"}), 400

    @app.post("/import")
    def do_import():
        f = request.files.get("file")
        if not f:
            return jsonify({"error": "no file uploaded"}), 400
        suffix = os.path.splitext(f.filename or "")[1]
        tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
        try:
            f.save(tmp.name)
            tmp.close()
            with conn() as c:
                res = pipeline.import_path(
                    c, tmp.name, source=request.form.get("source") or None
                )
            return jsonify(
                {
                    "imported": res.imported,
                    "skipped": res.skipped,
                    "errors": res.errors[:20],
                }
            )
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
        finally:
            os.unlink(tmp.name)

    # -- import modal: /prepare counts a file/URL WITHOUT writing; /commit writes --

    _prepared: dict[str, dict] = {}
    _YT_RE = re.compile(r"^https?://([\w.-]*\.)?(youtube\.com|youtu\.be)/", re.I)

    def _cleanup_prepared():
        now = time.time()
        for tok in list(_prepared):
            if now - _prepared[tok].get("ts", now) > 3600:
                try:
                    os.unlink(_prepared[tok]["path"])
                except OSError:
                    pass
                _prepared.pop(tok, None)

    def _cleanup_all_prepared():
        """Unlink every staged temp file regardless of age (B4). The TTL sweep above
        only runs on the *next* /import/prepare, so a preview that's previewed-but-never-
        committed would otherwise linger up to an hour; this runs on process exit so a
        clean shutdown leaves no orphaned temp files."""
        for tok in list(_prepared):
            try:
                os.unlink(_prepared[tok]["path"])
            except OSError:
                pass
            _prepared.pop(tok, None)

    atexit.register(_cleanup_all_prepared)

    def _count_existing(c, fullnames):
        existing = 0
        for i in range(
            0, len(fullnames), 500
        ):  # chunk to stay under SQLite's var limit
            chunk = fullnames[i : i + 500]
            qmarks = ",".join("?" * len(chunk))
            existing += c.execute(
                f"SELECT COUNT(*) FROM items WHERE fullname IN ({qmarks})", chunk
            ).fetchone()[0]
        return existing

    def _ytdlp_to_temp(url):
        exe = shutil.which("yt-dlp")
        if not exe:
            raise ValueError("yt-dlp is not installed (needed to fetch YouTube URLs)")
        out = tempfile.NamedTemporaryFile(delete=False, suffix=".json")
        out.close()
        try:
            proc = subprocess.run(
                [exe, "--flat-playlist", "--dump-single-json", url],
                capture_output=True,
                text=True,
                timeout=600,
            )
        except subprocess.TimeoutExpired:
            os.unlink(out.name)
            raise ValueError("yt-dlp timed out fetching that playlist")
        except OSError as exc:
            os.unlink(out.name)
            raise ValueError(f"could not run yt-dlp: {exc}")
        if proc.returncode != 0 or not (proc.stdout or "").strip():
            os.unlink(out.name)
            tail = (proc.stderr or "").strip().splitlines()
            raise ValueError("yt-dlp error: " + (tail[-1] if tail else "no output"))
        with open(out.name, "w", encoding="utf-8") as fh:
            fh.write(proc.stdout)
        return out.name

    @app.post("/import/prepare")
    def import_prepare():
        _cleanup_prepared()
        f = request.files.get("file")
        body = request.get_json(silent=True) or {}
        url = (body.get("url") or request.form.get("url") or "").strip()
        forced = request.form.get("source") or body.get("source")
        try:
            if f and f.filename:
                suffix = os.path.splitext(f.filename)[1] or ".dat"
                tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
                f.save(tmp.name)
                tmp.close()
                path = tmp.name
            elif url:
                if not _YT_RE.match(url):
                    return jsonify(
                        {
                            "error": "Only YouTube playlist or video URLs are supported here."
                        }
                    ), 400
                path = _ytdlp_to_temp(url)
                forced = "youtube"
            else:
                return jsonify({"error": "Provide a file or a YouTube URL."}), 400
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400

        try:
            connector = connectors.get(forced) if forced else connectors.dispatch(path)
            items = list(connector.import_file(Path(path)))
        except KeyError:
            os.unlink(path)
            return jsonify({"error": f"unknown source '{forced}'"}), 400
        except ValueError as exc:
            os.unlink(path)
            return jsonify({"error": str(exc)}), 400
        except Exception as exc:  # noqa: BLE001 - surface any parse failure to the user
            os.unlink(path)
            return jsonify({"error": f"could not parse input: {exc}"}), 400

        if not items:
            os.unlink(path)
            return jsonify({"error": "No importable items found in that input."}), 400

        # de-dup within the file so "N items / X new" reflects distinct items, not raw rows
        fullnames = list(
            dict.fromkeys(it["fullname"] for it in items if it.get("fullname"))
        )
        total = len(fullnames)
        with conn() as c:
            existing = _count_existing(c, fullnames)
        token = secrets.token_urlsafe(16)
        _prepared[token] = {
            "path": path,
            "source": connector.id,
            "count": total,
            "ts": time.time(),
        }
        sample = [
            {
                "title": (it.get("title") or it.get("url") or it.get("fullname") or "")[
                    :120
                ],
                "source": it.get("source"),
            }
            for it in items[:5]
        ]
        return jsonify(
            {
                "token": token,
                "count": total,
                "new": max(total - existing, 0),
                "source": connector.id,
                "label": connector.label,
                "sample": sample,
            }
        )

    @app.post("/import/commit")
    def import_commit():
        data = request.get_json(silent=True) or {}
        prep = _prepared.pop((data.get("token") or "").strip(), None)
        if not prep:
            return jsonify(
                {"error": "this import preview expired — please preview again"}
            ), 400
        try:
            with conn() as c:
                res = pipeline.import_path(c, prep["path"], source=prep.get("source"))
            return jsonify(
                {
                    "imported": res.imported,
                    "skipped": res.skipped,
                    "errors": res.errors[:20],
                }
            )
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
        finally:
            try:
                os.unlink(prep["path"])
            except OSError:
                pass

    # exposed for testing the B4 exit-cleanup (the atexit hook is otherwise unreachable)
    app._prepared = _prepared  # type: ignore[attr-defined]
    app._cleanup_all_prepared = _cleanup_all_prepared  # type: ignore[attr-defined]
    return app
