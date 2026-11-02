const rejectResponse = (r) => {
  if (r.status === 401) location.assign("/auth/login");

  return r
    .clone()
    .json()
    .catch(() => null)
    .then((data) => {
      r.data = data;
      throw r;
    });
};

export const getJSON = (url, opts) =>
  fetch(url, opts).then((r) => (r.ok ? r.json() : rejectResponse(r)));

export const postJSON = (url, body) =>
  getJSON(
    url,
    body === undefined
      ? { method: "POST" }
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );

export const setStatus = (fullname, status, extra) =>
  postJSON("/items/" + encodeURIComponent(fullname) + "/status", { status, ...extra });

export const fetchItem = (fullname) => getJSON("/items/" + encodeURIComponent(fullname));

export const undoItem = (fullname) => postJSON("/items/" + encodeURIComponent(fullname) + "/undo");

export const snoozeItem = (fullname, body) =>
  postJSON("/items/" + encodeURIComponent(fullname) + "/snooze", body || { window_days: 7 });

export const undoSnooze = (body) => postJSON("/snooze/undo", body);

export const recoverItem = (fullname, body) =>
  postJSON("/items/" + encodeURIComponent(fullname) + "/recover", body);

export const recoverArchiveToday = (fullname, mode = "apply") =>
  recoverItem(fullname, {
    metadata: false,
    archive_today: mode,
    confirm_external_archive_today: true,
  });

export const setBody = (fullname, body) =>
  postJSON("/items/" + encodeURIComponent(fullname) + "/body", { body });

export const bulkStatus = (fullnames, status) => postJSON("/bulk/status", { fullnames, status });

export const bulkUndo = (fullnames) =>
  Promise.allSettled((fullnames || []).map((f) => undoItem(f))).then((rs) => ({
    ok: rs.filter((r) => r.status === "fulfilled").length,
    failed: rs.map((r, i) => (r.status === "rejected" ? fullnames[i] : null)).filter(Boolean),
  }));

export const promoteItem = (fullname) =>
  postJSON("/items/" + encodeURIComponent(fullname) + "/promote");

export const fetchDuplicates = (params) =>
  getJSON("/duplicates" + (params ? "?" + new URLSearchParams(params) : ""));

export const resolveDuplicates = (keep, archive) =>
  postJSON("/duplicates/resolve", { keep, archive });

export const undoDuplicates = (fullnames) => postJSON("/duplicates/undo", { fullnames });

export const fetchItems = (params) =>
  getJSON("/items" + (params ? "?" + new URLSearchParams(params) : ""));

export const fetchSources = (status) =>
  getJSON("/sources" + (status ? "?status=" + encodeURIComponent(status) : ""));

export const fetchStats = (params) =>
  getJSON("/stats" + (params ? "?" + new URLSearchParams(params) : ""));

export const redditSync = (body) => postJSON("/reddit/sync", body || {});

export const unsaveStatus = () => getJSON("/reddit/unsave/status");

export const unsaveDrain = (body) => postJSON("/reddit/unsave/drain", body || { dry_run: true });

export const unsaveItem = (fullname) =>
  postJSON("/reddit/items/" + encodeURIComponent(fullname) + "/unsave");

export const undoRedditUnsave = (fullname) =>
  postJSON("/reddit/items/" + encodeURIComponent(fullname) + "/undo");

export const unsaveByTag = (tag, { apply = false } = {}) =>
  postJSON("/reddit/unsave/enqueue-by-tag", apply ? { tag, apply: true, yes: true } : { tag });

export const fetchPulse = () => getJSON("/pulse");

export const fetchSweeps = (limit) =>
  getJSON("/sweeps" + (limit ? "?limit=" + encodeURIComponent(limit) : ""));

export const applySweep = (body) => postJSON("/sweeps/apply", body);

export const undoSweep = (wave) => postJSON("/sweeps/undo", { wave });

export const fetchResurface = () =>
  fetch("/resurface").then((r) => (r.status === 204 ? null : r.ok ? r.json() : rejectResponse(r)));

export const dismissResurface = (cluster) =>
  fetch("/resurface/dismiss", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cluster }),
  }).then((r) => (r.ok ? null : rejectResponse(r)));

export const letgoResurface = (cluster) => postJSON("/resurface/letgo", { cluster });

export const undoLetgoResurface = (cluster, wave) =>
  postJSON("/resurface/letgo/undo", { cluster, decayed_at: wave });
