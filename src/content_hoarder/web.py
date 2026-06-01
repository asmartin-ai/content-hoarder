"""Flask app factory + routes (search, triage, status, sources, stats, import)."""

from __future__ import annotations

import os
import tempfile
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
                is_saved=_int(is_saved) if is_saved not in (None, "") else None,
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

    @app.get("/sources")
    def sources():
        with conn() as c:
            counts = {r["source"]: r["count"] for r in db.source_counts(c)}
        out = [
            {"id": x.id, "label": x.label, "badge_color": x.badge_color,
             "count": counts.get(x.id, 0)}
            for x in connectors.all_connectors()
        ]
        # Surface any DB sources not in the registry, too.
        for src, cnt in counts.items():
            if src not in connectors.REGISTRY:
                out.append({"id": src, "label": src, "badge_color": "#888888", "count": cnt})
        return jsonify({"sources": out})

    @app.get("/stats")
    def stats():
        with conn() as c:
            return jsonify(db.get_counts(c))

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

    return app
