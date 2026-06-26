/* core/api.js — fetch layer + thin endpoint wrappers used by 2+ pages.
   All wrappers reject on !r.ok (reddit.js's raw fetch().json() chains lacked this).
   UI reactions (toasts, count bumps, reloads) stay page-side. */

export const getJSON = (url, opts) =>
  fetch(url, opts).then((r) => (r.ok ? r.json() : Promise.reject(r)));

export const postJSON = (url, body) =>
  getJSON(url, body === undefined
    ? { method: "POST" }
    : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

/* ---- item actions ---- */
export const setStatus = (fullname, status) =>
  postJSON("/items/" + encodeURIComponent(fullname) + "/status", { status });

export const undoItem = (fullname) =>
  postJSON("/items/" + encodeURIComponent(fullname) + "/undo");

export const recoverItem = (fullname) =>
  postJSON("/items/" + encodeURIComponent(fullname) + "/recover");

export const setBody = (fullname, body) =>
  postJSON("/items/" + encodeURIComponent(fullname) + "/body", { body });

export const bulkStatus = (fullnames, status) =>
  postJSON("/bulk/status", { fullnames, status });

/* Bulk undo (Epic 13:369): /bulk/status has no server-side undo, so replay the
   per-item undo for every affected fullname. Resolves with {ok, failed[]}. */
export const bulkUndo = (fullnames) =>
  Promise.allSettled((fullnames || []).map((f) => undoItem(f))).then((rs) => ({
    ok: rs.filter((r) => r.status === "fulfilled").length,
    failed: rs.map((r, i) => (r.status === "rejected" ? fullnames[i] : null)).filter(Boolean),
  }));

/* ---- lists / counts ---- */
export const fetchItems = (params) =>
  getJSON("/items" + (params ? "?" + new URLSearchParams(params) : ""));

export const fetchSources = (status) =>
  getJSON("/sources" + (status ? "?status=" + encodeURIComponent(status) : ""));

export const fetchStats = (params) =>
  getJSON("/stats" + (params ? "?" + new URLSearchParams(params) : ""));

/* ---- reddit unsave queue ---- */
export const unsaveStatus = () => getJSON("/reddit/unsave/status");
export const unsaveDrain = (limit) =>
  postJSON("/reddit/unsave/drain", limit ? { limit } : undefined);
