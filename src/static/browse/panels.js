/* browse/panels.js — the sheet layer: browse scroll lock, the settings / stats /
   duplicates / keyboard-shortcut sheets, Done-retention settings + purge, the
   "Sync newest" button, and swipe-down-to-dismiss for the mobile bottom sheets. */

import { esc } from "../core/util.js";
import * as api from "../core/api.js";
import { toast, snackbar } from "../core/toast.js";
import { setArchivePref } from "../core/media.js";
import { $, $$, state, itemsEl, drawer, doneRetention } from "./shared.js";
import { paintWins } from "./chrome.js";
import {
  clearItemFirstPageCache,
  loadCounts,
  loadItems,
  refreshPulse,
  refreshRail,
} from "./data.js";
import { render, setFocus } from "./feed.js";
import { closeRelay } from "./relay.js";

/* ---- sheets / settings panel ---- */
export const scrim = $("#scrim");

let _browseLock = 0;

let _browseLockSaved = 0; // #items scroll

let _browseBodyLockSaved = 0; // body scroll

export function lockBrowseScroll() {
  if (_browseLock === 0) {
    _browseLockSaved = itemsEl.scrollTop;
    _browseBodyLockSaved = window.scrollY || document.documentElement.scrollTop;
    document.body.style.overflow = "hidden"; // lock the body too
  }

  _browseLock++;
  itemsEl.style.overflow = "hidden";
}

function unlockBrowseScroll() {
  if (_browseLock <= 0) return;
  _browseLock = Math.max(0, _browseLock - 1);

  if (_browseLock === 0) {
    itemsEl.style.overflow = "";
    document.body.style.overflow = ""; // restore the body

    if (_browseLockSaved) itemsEl.scrollTop = _browseLockSaved;

    if (_browseBodyLockSaved) {
      window.scrollTo(0, _browseBodyLockSaved); // restore body scroll position
    }

    _browseLockSaved = 0;
    _browseBodyLockSaved = 0;
  }
}

function openPanel(id) {
  closeSheets();
  $(id).classList.add("show");
  scrim.classList.add("show");
  lockBrowseScroll();
}

export function closeSheets() {
  ["#settings", "#navdrawer", "#kbd", "#statsheet", "#dupesheet"].forEach((s) =>
    $(s).classList.remove("show"),
  );

  if (drawer) drawer.setAttribute("aria-hidden", "true");
  scrim.classList.remove("show");

  // also collapse any open Relay-style inline strip (Epic 16 B3)
  closeRelay();
  // restore browse scroll when ALL sheets are closed (Epic 16: sidebar scroll-lock)
  unlockBrowseScroll();
}

function readError(err, fallback) {
  const body = err instanceof Response ? err.data : null;

  return (body && body.error) || fallback;
}

function formatCutoffDate(ts) {
  return new Date(ts * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function paintDoneRetention() {
  const current = $("#done-retention-current");
  const preview = $("#done-retention-preview");
  const confirm = $("#done-retention-confirm");
  const purge = $("#done-retention-purge");
  const feedback = $("#done-retention-feedback");

  if (!current || !preview || !confirm || !purge || !feedback) return;

  $$("#set-done-retention button").forEach((b) =>
    b.setAttribute("aria-pressed", String(parseInt(b.dataset.days, 10) === doneRetention.days)),
  );

  if (!doneRetention.loaded) {
    current.textContent = "Loading current window...";
    preview.textContent = "Checking what would be purged...";
    confirm.checked = false;
    purge.disabled = true;
    feedback.innerHTML =
      "The purge writes a timestamped DB backup and appends <code>delete-audit.jsonl</code>.";

    return;
  }

  current.textContent =
    "Current window: " + doneRetention.days + " day" + (doneRetention.days === 1 ? "" : "s") + ".";

  const plan = doneRetention.preview;

  if (!plan) {
    preview.textContent = "Could not load the current purge preview.";
  } else if (!plan.total) {
    preview.textContent =
      "Nothing is eligible right now. Done items older than " +
      formatCutoffDate(plan.cutoff) +
      " would be purged.";
  } else {
    preview.innerHTML =
      "<b>" +
      plan.total.toLocaleString() +
      "</b> Done item" +
      (plan.total === 1 ? "" : "s") +
      " older than <b>" +
      formatCutoffDate(plan.cutoff) +
      "</b> would be permanently deleted.";
  }

  purge.disabled = doneRetention.loading || !plan || !plan.total || !confirm.checked;
  feedback.innerHTML = doneRetention.loading
    ? "Working..."
    : "The purge writes a timestamped DB backup and appends <code>delete-audit.jsonl</code>.";
}

async function loadDoneRetention(force) {
  if (doneRetention.loading || (doneRetention.loaded && !force)) {
    paintDoneRetention();

    return;
  }

  doneRetention.loading = true;
  paintDoneRetention();

  try {
    const data = await api.getJSON("/settings/done-retention");
    doneRetention.days = parseInt(data.retention_days, 10) || 30;
    doneRetention.preview = data.preview || null;
    doneRetention.loaded = true;
  } catch {
    toast("Couldn't load Done retention.");
  }
}

export function toggleKbd() {
  const k = $("#kbd"),
    show = !k.classList.contains("show");

  closeSheets();

  if (show) {
    k.classList.add("show");
    scrim.classList.add("show");
  }
}

scrim.addEventListener("click", closeSheets);

$("#open-settings").addEventListener("click", () => {
  openPanel("#settings");
  loadDoneRetention(true);
});

$("#dock-settings").addEventListener("click", () => {
  openPanel("#settings");
  loadDoneRetention(true);
});

/* Swipe-DOWN-to-dismiss for the mobile bottom sheets. Engages only at scroll-top with a
   downward drag, so it never fights the sheet's own scroll or its toggle buttons. The
   preventDefault on the engaged drag also blocks the browser's pull-to-refresh, which
   otherwise hijacks the down-swipe and reloads the page instead of closing the sheet. */
function attachSheetDismiss(panel) {
  if (!panel) return;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");

  let startY = 0,
    dy = 0,
    dragging = false,
    engaged = false;

  const settle = (toY, after) => {
    let fired = false;

    const fin = () => {
      if (fired) return;
      fired = true;
      panel.removeEventListener("transitionend", fin);

      if (after) after(); // before clearing inline: closeSheets removes .show while
      panel.style.transition = ""; // the sheet is already off-screen → no flash back up
      panel.style.transform = "";
    };

    if (reduced.matches) {
      panel.style.transition = "none";
      panel.style.transform = toY;
      fin();

      return;
    }

    panel.style.transition = "transform 180ms var(--ease)";
    panel.style.transform = toY;
    panel.addEventListener("transitionend", fin);
    setTimeout(fin, 240); // fallback if transitionend never fires
  };

  panel.addEventListener(
    "touchstart",
    (e) => {
      if (e.touches.length !== 1) return;

      if (!window.matchMedia("(max-width:700px)").matches) return; // bottom-sheet layout only
      startY = e.touches[0].clientY;
      dy = 0;
      dragging = true;
      engaged = panel.scrollTop <= 0; // decide once, up front
      panel.style.transition = "none";
    },
    { passive: true },
  );

  panel.addEventListener(
    "touchmove",
    (e) => {
      if (!dragging || !engaged) return;
      dy = e.touches[0].clientY - startY;

      if (dy <= 0) return; // upward → let content scroll
      e.preventDefault(); // own the gesture (no pull-to-refresh)
      panel.style.transform = "translate(-50%," + dy + "px)";
    },
    { passive: false },
  );

  const end = () => {
    if (!dragging) return;
    dragging = false;

    if (engaged && dy > Math.min(120, panel.offsetHeight * 0.3))
      settle("translate(-50%,110%)", closeSheets);
    else if (dy > 0) settle("translate(-50%,0)");
  };

  panel.addEventListener("touchend", end);
  panel.addEventListener("touchcancel", end);
}

["#settings", "#statsheet", "#dupesheet", "#tagsheet"].forEach((s) => attachSheetDismiss($(s)));

/* ---- stats sheet (Epic 14: Stats lives in the settings menu) ---- */
function statsBarRows(obj, max) {
  return Object.entries(obj || {})
    .sort((a, b) => b[1] - a[1])
    .map(
      ([k, v]) =>
        '<div class="stat-row"><span class="sk">' +
        esc(k) +
        "</span>" +
        '<i class="bar" style="width:' +
        Math.round((v / max) * 100) +
        '%"></i>' +
        '<span class="sv">' +
        v.toLocaleString() +
        "</span></div>",
    )
    .join("");
}

function statsHtml(d) {
  const head =
    '<div class="stat-row"><span class="sk">Processed this week</span><span class="sv">' +
    (d.processed_this_week || 0).toLocaleString() +
    "</span></div>" +
    '<div class="stat-row"><span class="sk">Total saves</span><span class="sv">' +
    (d.total || 0).toLocaleString() +
    "</span></div>" +
    '<div class="stat-row"><span class="sk">With a link</span><span class="sv">' +
    (d.with_url || 0).toLocaleString() +
    "</span></div>";

  const maxOf = (o) => Math.max(...Object.values(o || {}), 1);

  return (
    head +
    '<div class="lab">BY SOURCE</div>' +
    statsBarRows(d.by_source, maxOf(d.by_source)) +
    '<div class="lab">BY STATUS</div>' +
    statsBarRows(d.by_status, maxOf(d.by_status))
  );
}

$("#open-stats").addEventListener("click", async () => {
  const list = $("#stats-list");
  list.textContent = "Counting the shelves…";
  openPanel("#statsheet");

  try {
    list.innerHTML = statsHtml(await api.fetchStats());
  } catch {
    list.textContent = "Couldn't load stats — try again.";
  }
});

let dupeBy = "url";

let dupeGroups = [];

function dupeItemHtml(it, keep) {
  const title = it.title || it.url || it.fullname;

  return (
    '<div class="dup-item' +
    (it.fullname === keep ? " keep" : "") +
    '">' +
    '<span class="dup-src">' +
    esc(it.source || "") +
    "</span>" +
    '<span class="dup-title">' +
    esc(title) +
    "</span>" +
    (it.fullname === keep ? '<span class="dup-keep">keep</span>' : "") +
    "</div>"
  );
}

function dupesHtml(groups) {
  if (!groups.length) return '<div class="dup-empty">No duplicate groups in Inbox.</div>';

  return groups
    .map((g, i) => {
      const keep = g.suggested_keep;

      const archive = (g.items || []).filter((it) => it.fullname !== keep).map((it) => it.fullname);

      return (
        '<section class="dup-group" data-dupe-idx="' +
        i +
        '">' +
        '<div class="dup-head"><b>' +
        esc(g.key || "") +
        "</b><span>" +
        g.count +
        " items</span></div>" +
        '<div class="dup-items">' +
        (g.items || []).map((it) => dupeItemHtml(it, keep)).join("") +
        "</div>" +
        '<button type="button" class="ambbtn primary" data-dupe-resolve="' +
        i +
        '"' +
        (archive.length ? "" : " disabled") +
        ">Archive others</button>" +
        "</section>"
      );
    })
    .join("");
}

async function loadDupes() {
  const list = $("#dup-list");
  list.textContent = "Finding duplicate saves...";

  try {
    const data = await api.fetchDuplicates({ by: dupeBy, status: "inbox" });
    dupeGroups = data.groups || [];
    list.innerHTML = dupesHtml(dupeGroups);
  } catch {
    list.textContent = "Couldn't load duplicates.";
  }
}

$("#open-dupes").addEventListener("click", () => {
  openPanel("#dupesheet");
  loadDupes();
});

$("#dupesheet").addEventListener("click", async (e) => {
  const by = e.target.closest("[data-dupe-by]");

  if (by) {
    dupeBy = by.dataset.dupeBy || "url";
    $$("#dupesheet [data-dupe-by]").forEach((b) =>
      b.setAttribute("aria-pressed", String(b === by)),
    );
    loadDupes();

    return;
  }

  const btn = e.target.closest("[data-dupe-resolve]");

  if (!btn) return;
  const group = dupeGroups[parseInt(btn.dataset.dupeResolve, 10)];

  if (!group) return;
  const keep = group.suggested_keep;

  const archive = (group.items || []).filter((it) => it.fullname !== keep).map((it) => it.fullname);

  if (!archive.length) return;
  btn.disabled = true;

  try {
    await api.resolveDuplicates(keep, archive);
    clearItemFirstPageCache();
    snackbar(
      "Archived " + archive.length + " duplicate" + (archive.length === 1 ? "." : "s."),
      async () => {
        await api.undoDuplicates(archive);
        clearItemFirstPageCache();
        loadDupes();
        loadItems(true);
        loadCounts();
        refreshPulse();
      },
    );
    loadDupes();
    loadItems(true);
    loadCounts();
    refreshPulse();
  } catch {
    toast("Duplicate resolve failed.");
    btn.disabled = false;
  }
});

$$("#set-theme button").forEach((b) =>
  b.addEventListener("click", () => {
    // theme.js owns persistence; mirror its storage contract ("ch-theme")
    document.documentElement.dataset.theme = b.dataset.theme;

    try {
      localStorage.setItem("ch-theme", b.dataset.theme);
    } catch {}

    $$("#set-theme button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
  }),
);

$$("#set-density button").forEach((b) =>
  b.addEventListener("click", () => {
    state.density = b.dataset.d;
    localStorage.chDensity = state.density;
    $$("#set-density button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    render();
  }),
);

$$("#set-loading button").forEach((b) =>
  b.addEventListener("click", () => {
    setFocus(b.dataset.focus === "1");
  }),
);

$$("#set-goal button").forEach((b) =>
  b.addEventListener("click", () => {
    state.goal = parseInt(b.dataset.g, 10) || 0;
    localStorage.chGoal = String(state.goal);
    $$("#set-goal button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    paintWins();
  }),
);

$$("#set-nsfw button").forEach((b) =>
  b.addEventListener("click", () => {
    state.safe = b.dataset.nsfw === "hide";
    localStorage.chSafe = state.safe ? "1" : "0";
    $$("#set-nsfw button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    refreshRail(); // surface/hide the nsfw_* facets to match the toggle (Epic 14)
    loadItems(true);
  }),
);

$$("#set-archive button").forEach((b) =>
  b.addEventListener("click", () => {
    state.archiveMedia = b.dataset.archive === "on"; // prefer local /media copies (Epic 4 P1)
    localStorage.chArchiveMedia = state.archiveMedia ? "1" : "0";
    setArchivePref(state.archiveMedia);
    $$("#set-archive button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    render(); // re-render with the new media-source preference
  }),
);

$("#done-retention-confirm").addEventListener("change", paintDoneRetention);

$$("#set-done-retention button").forEach((b) =>
  b.addEventListener("click", async () => {
    if (doneRetention.loading) return;
    const days = parseInt(b.dataset.days, 10);

    if (!days || days === doneRetention.days) return;
    doneRetention.loading = true;
    $("#done-retention-confirm").checked = false;
    paintDoneRetention();

    try {
      const data = await api.postJSON("/settings/done-retention", {
        retention_days: days,
      });

      doneRetention.days = parseInt(data.retention_days, 10) || days;
      doneRetention.preview = data.preview || null;
      doneRetention.loaded = true;
      toast("Done retention set to " + doneRetention.days + " days.");
    } catch (err) {
      toast(await readError(err, "Couldn't save Done retention."));
    } finally {
      doneRetention.loading = false;
      paintDoneRetention();
    }
  }),
);

$("#done-retention-purge").addEventListener("click", async () => {
  if (doneRetention.loading || !doneRetention.preview || !doneRetention.preview.total) return;

  if (!$("#done-retention-confirm").checked) {
    paintDoneRetention();

    return;
  }

  doneRetention.loading = true;
  paintDoneRetention();

  try {
    const data = await api.postJSON("/settings/done-retention/purge", {
      expected_total: doneRetention.preview.total,
      expected_cutoff: doneRetention.preview.cutoff,
    });

    doneRetention.preview = data.preview || null;
    doneRetention.loaded = true;
    $("#done-retention-confirm").checked = false;
    toast(
      "Purged " +
        (data.purged?.total || 0) +
        " Done item" +
        ((data.purged?.total || 0) === 1 ? "." : "s."),
    );
    clearItemFirstPageCache();
    loadItems(true);
    loadCounts();
    refreshRail();
    refreshPulse();
  } catch (err) {
    const body = err instanceof Response ? err.data : null;

    if (body && body.preview) {
      doneRetention.preview = body.preview;
      doneRetention.loaded = true;
      $("#done-retention-confirm").checked = false;
    }

    toast((body && body.error) || "Done purge failed.");
  } finally {
    doneRetention.loading = false;
    paintDoneRetention();
  }
});

/* ---- "Sync newest": surface the /reddit incremental sync on the browse view (Epic 9 / spec 06) ---- */
async function runSyncNewest(btn) {
  if (!btn || btn.disabled) return;
  const label = btn.textContent;
  const isIcon = btn.classList.contains("icon-btn");
  btn.disabled = true;

  if (!isIcon) btn.textContent = "Syncing newest…";

  try {
    const data = await api.postJSON("/reddit/sync", {});

    if (data.auth_error) toast("Sync needs a reddit_session cookie — set it up first.");
    else if (data.error) toast("Sync error: " + data.error);
    else {
      toast("+" + data.new + " new (" + data.fetched + " fetched · " + data.stopped + ").");
      clearItemFirstPageCache();
      loadItems(true);
      loadCounts();
      refreshRail();
      refreshPulse();
    }
  } catch {
    toast("Sync failed — network error.");
  }

  if (!isIcon) btn.textContent = label;
  btn.disabled = false;
}

const syncBtn = $("#open-sync");

if (syncBtn) syncBtn.addEventListener("click", () => runSyncNewest(syncBtn));

const syncHeaderBtn = $("#btn-sync-newest");

if (syncHeaderBtn) syncHeaderBtn.addEventListener("click", () => runSyncNewest(syncHeaderBtn));

/* reflect persisted settings into the panel */
$$("#set-density button").forEach((b) =>
  b.setAttribute("aria-pressed", String(b.dataset.d === state.density)),
);

$$("#set-loading button").forEach((b) =>
  b.setAttribute("aria-pressed", String((b.dataset.focus === "1") === state.focus)),
);

$$("#set-goal button").forEach((b) =>
  b.setAttribute("aria-pressed", String((parseInt(b.dataset.g, 10) || 0) === state.goal)),
);

$$("#set-nsfw button").forEach((b) =>
  b.setAttribute("aria-pressed", String((b.dataset.nsfw === "hide") === state.safe)),
);

$$("#set-archive button").forEach((b) =>
  b.setAttribute("aria-pressed", String((b.dataset.archive === "on") === state.archiveMedia)),
);

$$("#set-theme button").forEach((b) =>
  b.setAttribute(
    "aria-pressed",
    String((document.documentElement.dataset.theme || "dark") === b.dataset.theme),
  ),
);

paintDoneRetention();
