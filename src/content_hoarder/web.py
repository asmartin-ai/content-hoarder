"""Flask app factory + routes (search, triage, status, sources, stats, import)."""

from __future__ import annotations

import os
import re
import secrets
import shutil
import subprocess
import tempfile
import time
from contextlib import closing

from flask import Flask, jsonify, render_template, request, send_from_directory

from content_hoarder import config, connectors, db, pipeline


def _int(value, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def create_app(db_path: str | None = None) -> Flask:
    config.load_env()
    app = Flask(__name__)
    app.config["DB_PATH"] = db_path or config.db_path()
    app.config["SECRET_KEY"] = config.get("FLASK_SECRET_KEY")

    def conn():
        return closing(db.connect(app.config["DB_PATH"]))

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
            app.static_folder, "manifest.webmanifest",
            mimetype="application/manifest+json",
        )

    # -- data --------------------------------------------------------------

    @app.get("/items")
    def items():
        a = request.args
        limit = min(max(_int(a.get("limit"), 50), 1), 500)
        offset = max(_int(a.get("offset"), 0), 0)
        is_saved = a.get("is_saved")
        with conn() as c:
            rows = db.search_items(
                c, a.get("q", ""),
                source=a.get("source") or None,
                kind=a.get("kind") or None,
                status=a.get("status") or None,
                category=a.get("category") or None,
                tags=a.getlist("tag") or None,
                is_saved=_int(is_saved) if is_saved not in (None, "") else None,
                open_in_firefox=a.get("open_in_firefox") in ("1", "true"),
                fuzzy=a.get("fuzzy") == "1",
                sort=a.get("sort", "last_seen_utc"),
                order=a.get("order", "desc"),
                limit=limit + 1, offset=offset,
            )
            has_more = len(rows) > limit
            return jsonify({"items": rows[:limit], "has_more": has_more})

    @app.get("/random")
    def random_batch():
        a = request.args
        n = min(max(_int(a.get("n"), 20), 1), 100)
        with conn() as c:
            rows = db.get_random_batch(
                c, n, source=a.get("source") or None,
                unprocessed=a.get("unprocessed", "1") != "0",
            )
        return jsonify({"items": rows})

    @app.post("/items/<path:fullname>/status")
    def set_status(fullname):
        body = request.get_json(silent=True) or request.form
        status = (body.get("status") or "").strip()
        try:
            with conn() as c:
                item = db.set_status(c, fullname, status)
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
        if item is None:
            return jsonify({"error": "not found"}), 404
        return jsonify(item)

    @app.post("/items/<path:fullname>/undo")
    def undo(fullname):
        with conn() as c:
            item = db.undo_status(c, fullname)
        if item is None:
            return jsonify({"error": "not found"}), 404
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

    @app.post("/items/<path:fullname>/recover")
    def recover_item(fullname):
        from content_hoarder.archival import service as archival
        with conn() as c:
            res = archival.recover_one(c, fullname)
        if res is None:
            return jsonify({"error": "not a recoverable reddit item"}), 400
        return jsonify(res)

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
            db.merge_upsert(c, {"fullname": fullname, "metadata": {"category": cat}})
            c.commit()
        return jsonify({"fullname": fullname, "category": cat})

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

    # -- reddit unsave: cookie auth + on-demand queue drain --------------

    @app.get("/reddit/unsave/status")
    def reddit_unsave_status():
        from content_hoarder import reddit_unsave as ru
        with conn() as c:
            auth = ru.get_auth(c)
            return jsonify({
                "configured": auth is not None,
                "username": auth.get("username") if auth else None,
                "enabled": db.get_setting(c, "reddit_unsave_on_done", "0") == "1",
                "pending": ru.count_pending(c),
            })

    @app.post("/reddit/unsave/auth")
    def reddit_unsave_auth():
        from content_hoarder import reddit_unsave as ru
        body = request.get_json(silent=True) or {}
        cookie = (body.get("cookie") or "").strip()
        if not cookie:
            return jsonify({"ok": False, "error": "paste your reddit_session cookie"}), 400
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
        mx = body.get("max")
        with conn() as c:
            res = ru.drain(c, limit=int(mx) if mx else None)
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
        is_saved = a.get("is_saved")
        with conn() as c:
            rows = db.search_items(
                c, a.get("q", ""),
                source="reddit",
                kind=a.get("kind") or None,
                status=a.get("status") or None,
                subreddit=a.get("subreddit") or None,
                tags=a.getlist("tag") or None,
                is_saved=_int(is_saved) if is_saved not in (None, "") else None,
                fuzzy=a.get("fuzzy") == "1",
                # Default to newest-synced-first — the closest proxy to newest-saved-first, since
                # Reddit exposes no save timestamp (see docs/reddit-management.md).
                sort=a.get("sort", "first_seen_utc"),
                order=a.get("order", "desc"),
                limit=limit + 1, offset=offset,
            )
        has_more = len(rows) > limit
        return jsonify({"items": [_reddit_view(r) for r in rows[:limit]], "has_more": has_more})

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
        from content_hoarder import reddit_thread
        with conn() as c:
            res = reddit_thread.get_thread(c, fullname)
        if res is None:
            return jsonify({"error": "not found"}), 404
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
        mp = body.get("max_pages")
        full = bool(body.get("full"))
        max_pages = int(mp) if mp else (50 if full else 3)
        with conn() as c:
            res = reddit_sync.sync_saved_cookie(c, max_pages=max_pages, stop_on_known=not full)
        return jsonify(res)

    @app.get("/sources")
    def sources():
        # Optional ?status= cross-filters the per-source counts (tabs by active status).
        status = request.args.get("status") or None
        with conn() as c:
            rows = db.source_counts(c, status=status)
        out = []
        for r in rows:  # source_counts only returns sources actually present in the DB
            x = connectors.REGISTRY.get(r["source"])
            out.append({
                "id": r["source"],
                "label": x.label if x else r["source"],
                "badge_color": x.badge_color if x else "#888888",
                "count": r["count"],
            })
        return jsonify({"sources": out})

    @app.get("/stats")
    def stats():
        # Optional ?source= cross-filters the status counts (sidebar by active source).
        source = request.args.get("source") or None
        with conn() as c:
            return jsonify(db.get_counts(c, source=source))

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
            return jsonify({
                "imported": res.imported, "skipped": res.skipped,
                "errors": res.errors[:20],
            })
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

    def _count_existing(c, fullnames):
        existing = 0
        for i in range(0, len(fullnames), 500):  # chunk to stay under SQLite's var limit
            chunk = fullnames[i:i + 500]
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
                capture_output=True, text=True, timeout=600,
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
                    return jsonify({"error": "Only YouTube playlist or video URLs are supported here."}), 400
                path = _ytdlp_to_temp(url)
                forced = "youtube"
            else:
                return jsonify({"error": "Provide a file or a YouTube URL."}), 400
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400

        try:
            connector = connectors.get(forced) if forced else connectors.dispatch(path)
            items = list(connector.import_file(path))
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
        fullnames = list(dict.fromkeys(it["fullname"] for it in items if it.get("fullname")))
        total = len(fullnames)
        with conn() as c:
            existing = _count_existing(c, fullnames)
        token = secrets.token_urlsafe(16)
        _prepared[token] = {"path": path, "source": connector.id,
                            "count": total, "ts": time.time()}
        sample = [{"title": (it.get("title") or it.get("url") or it.get("fullname") or "")[:120],
                "source": it.get("source")} for it in items[:5]]
        return jsonify({"token": token, "count": total,
                        "new": max(total - existing, 0),
                        "source": connector.id, "label": connector.label, "sample": sample})

    @app.post("/import/commit")
    def import_commit():
        data = request.get_json(silent=True) or {}
        prep = _prepared.pop((data.get("token") or "").strip(), None)
        if not prep:
            return jsonify({"error": "this import preview expired — please preview again"}), 400
        try:
            with conn() as c:
                res = pipeline.import_path(c, prep["path"], source=prep.get("source"))
            return jsonify({"imported": res.imported, "skipped": res.skipped,
                            "errors": res.errors[:20]})
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
        finally:
            try:
                os.unlink(prep["path"])
            except OSError:
                pass

    return app
