/* home/today.js — the Today room (lamp mode): one lit action ("Clear 10"), wins-only counts,
   sweeps (let a whole pile rest), an optional resurface whisper and a re-entry line.
   Never shows the remaining backlog size. Contract: docs/design/clear-overhaul.md §4.2. */

import * as api from "../core/api.js";
import { snackbar, toast } from "../core/toast.js";
import { ago, esc, isTypingTarget } from "../core/util.js";

const SIZES = [5, 10, 25];

const OFFLINE = "Couldn't reach the server — is it running?";

const THEME_SVG =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18z"/><path d="M12 17a5 5 0 0 0 0-10v10"/></svg>';

const fmt = (n) => Number(n || 0).toLocaleString();

const plural = (n, one, many) => (n === 1 ? one : many);

const COUNT_MS = 600;

const POP_MS = 500;

const SWEEP_COLLAPSE_MS = 200;

const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

function readJSON(store, key) {
  try {
    const raw = store.getItem(key);

    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function roundSize() {
  const n = parseInt(localStorage.getItem("chRoundSize") || "", 10);

  return SIZES.includes(n) ? n : 10;
}

function goal() {
  const g = parseInt(localStorage.getItem("chGoal") ?? "", 10);

  return Number.isFinite(g) && g >= 0 ? g : 8;
}

/* An unfinished round left in sessionStorage by round.js → {n, q, left} or null. */
function pendingRound() {
  const s = readJSON(sessionStorage, "ch.round");

  if (!s || !Array.isArray(s.items) || !Array.isArray(s.results)) return null;
  const left = s.items.length - s.results.length;

  if (s.items.length === 0 || left <= 0) return null;

  return { n: s.n || s.items.length, q: s.q || "", left };
}

function dateLine() {
  return new Date()
    .toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })
    .replace(/,/g, "")
    .toUpperCase();
}

function reentryLine() {
  const last = readJSON(localStorage, "ch.lastRound");

  if (!last || !last.at) return "";
  // round.js stamps `at`; accept ms or unix seconds.
  const at = last.at > 1e12 ? Math.floor(last.at / 1000) : last.at;

  if (Date.now() / 1000 - at > 3 * 86400) return "Welcome back. Nothing is owed — start small.";
  const when = ago(at);

  if (!when) return "";

  return "Last round " + when + " ago — " + fmt(last.cleared) + " cleared.";
}

function heroText(n, resume) {
  if (resume)
    return {
      verb: "Resume round",
      sub: resume.left + " " + plural(resume.left, "card", "cards") + " left",
    };
  const min = Math.max(1, Math.round((n * 12) / 60));

  return {
    verb: "Clear " + n,
    sub: "about " + min + " " + plural(min, "minute", "minutes") + " · smart picks",
  };
}

function sweepSample(s) {
  return (s.sample || [])
    .slice(0, 2)
    .map((t) => '"' + t + '"')
    .join(" · ");
}

function sweepRow(s) {
  const sample = sweepSample(s);

  return (
    '<li class="sweep" data-id="' +
    esc(s.id) +
    '"><div class="sweep-main"><p class="sweep-label">' +
    esc(s.label) +
    "</p>" +
    (sample ? '<p class="sweep-sample">' + esc(sample) + "</p>" : "") +
    '</div><span class="sweep-count">' +
    esc(fmt(s.count)) +
    '</span><button class="sweep-peek" type="button">Peek</button>' +
    '<button class="sweep-go" type="button">Let go</button></li>'
  );
}

/* Round query that shows exactly the pile a sweep would rest. */
function sweepQuery(s) {
  if (s.kind === "subreddit") return "subreddit:" + s.subreddit;
  const day = new Date((s.before_utc || 0) * 1000).toISOString().slice(0, 10);

  return "source:" + s.source + " before:" + day;
}

export function mountToday(root, ctx) {
  const ac = new AbortController();
  const on = { signal: ac.signal };
  let alive = true;
  let size = roundSize();
  let resume = pendingRound();
  let sweeps = [];
  let whisper = null;
  let shown = null; // last rendered wins {today, total}; null until the first pulse lands
  let countRaf = 0;
  let popTimer = 0;

  const sizeBtns = SIZES.map(
    (n) =>
      '<button type="button" role="radio" aria-checked="' +
      (n === size) +
      '" data-n="' +
      n +
      '">' +
      n +
      "</button>",
  ).join("");

  const hero = heroText(size, resume);
  const reentry = reentryLine();

  root.innerHTML =
    '<section class="today">' +
    '<header class="today-head"><p class="today-date">' +
    esc(dateLine()) +
    "</p>" +
    '<p class="today-reentry"' +
    (reentry ? "" : " hidden") +
    ">" +
    esc(reentry) +
    "</p></header>" +
    '<div class="hero"><button class="hero-go" id="go" type="button">' +
    '<span class="hero-verb">' +
    esc(hero.verb) +
    '</span><span class="hero-sub">' +
    esc(hero.sub) +
    "</span></button>" +
    '<div class="hero-sizes" role="radiogroup" aria-label="Round size">' +
    sizeBtns +
    "</div></div>" +
    '<section class="wins" aria-label="Wins"><div class="pebbles" aria-hidden="true" hidden></div>' +
    '<p class="wins-line">&nbsp;</p></section>' +
    '<section class="sweeps" aria-labelledby="sweeps-h" hidden>' +
    '<h2 id="sweeps-h" class="sec-h">Let a pile go</h2>' +
    '<p class="sec-sub">One tap rests the whole pile. Nothing is deleted; undo any time.</p>' +
    '<ul class="sweep-list"></ul></section>' +
    '<aside class="whisper" hidden><p class="whisper-q"></p><div class="whisper-acts">' +
    '<button class="whisper-peek" type="button">Peek 5</button>' +
    '<button class="whisper-later" type="button">Not now</button>' +
    '<button class="whisper-letgo" type="button">Let it go</button></div></aside>' +
    '<footer class="today-foot"><a href="/library">Search the library</a>' +
    '<button class="today-theme" type="button" aria-label="Switch light/dark">' +
    THEME_SVG +
    "</button></footer></section>";

  const $ = (sel) => root.querySelector(sel);
  const goBtn = $(".hero-go");
  const pebblesEl = $(".pebbles");
  const winsLine = $(".wins-line");
  const sweepsEl = $(".sweeps");
  const sweepList = $(".sweep-list");
  const whisperEl = $(".whisper");

  /* ---- hero ---- */
  function renderHero() {
    const t = heroText(size, resume);
    $(".hero-verb").textContent = t.verb;
    $(".hero-sub").textContent = t.sub;
    root.querySelectorAll(".hero-sizes [role=radio]").forEach((b) => {
      b.setAttribute("aria-checked", String(Number(b.dataset.n) === size && !resume));
    });
  }

  if (resume) renderHero();

  function start() {
    if (resume) {
      ctx.go("/clear?n=" + resume.n + (resume.q ? "&q=" + encodeURIComponent(resume.q) : ""));

      return;
    }

    ctx.go("/clear?n=" + size);
  }

  function pickSize(n) {
    size = n;
    localStorage.setItem("chRoundSize", String(n));

    if (resume) {
      // An explicit size choice means a fresh round, not the paused one.
      resume = null;
      sessionStorage.removeItem("ch.round");
    }

    renderHero();
  }

  /* ---- wins ---- */
  /* Count each <b> from → to over COUNT_MS, ease-out; reduced motion jumps straight there. */
  function countUp(els, from, to) {
    cancelAnimationFrame(countRaf);

    const paint = (k) => {
      els.forEach((el, i) => {
        el.textContent = fmt(Math.round(from[i] + (to[i] - from[i]) * k));
      });
    };

    if (reducedMotion() || from.every((v, i) => v === to[i])) return paint(1);

    const t0 = performance.now();

    const step = (now) => {
      if (!alive) return;

      const t = Math.min(1, (now - t0) / COUNT_MS);

      paint(1 - (1 - t) ** 3);

      if (t < 1) countRaf = requestAnimationFrame(step);
    };

    countRaf = requestAnimationFrame(step);
  }

  function renderWins(p) {
    const today = Number(p.cleared_today || 0) + Number(p.swept_today || 0);
    const total = Number(p.cleared_total || 0);
    const g = goal();
    const prev = shown;

    shown = { today, total };

    if (g > 0) {
      const filled = Math.min(today, g);
      const was = prev ? Math.min(prev.today, g) : filled;
      let html = "";

      for (let i = 0; i < g; i++) {
        if (i >= filled) html += "<i></i>";
        else html += i >= was ? '<i class="on pop"></i>' : '<i class="on"></i>';
      }

      pebblesEl.innerHTML = html;
      pebblesEl.hidden = false;
      clearTimeout(popTimer);
      popTimer = setTimeout(() => {
        pebblesEl.querySelectorAll(".pop").forEach((i) => i.classList.remove("pop"));
      }, POP_MS);
    } else {
      pebblesEl.hidden = true;
    }

    if (!winsLine.querySelector(".wins-today")) {
      winsLine.innerHTML =
        '<b class="wins-today"></b> cleared today · <b class="wins-total"></b> all-time';
    }

    countUp(
      [winsLine.querySelector(".wins-today"), winsLine.querySelector(".wins-total")],
      prev ? [prev.today, prev.total] : [today, total],
      [today, total],
    );
  }

  function loadPulse() {
    return api
      .fetchPulse()
      .then((p) => {
        if (alive) renderWins(p || {});
      })
      .catch(() => {
        if (!alive) return;
        cancelAnimationFrame(countRaf);
        shown = null;
        pebblesEl.hidden = true;
        winsLine.textContent = OFFLINE;
      });
  }

  /* ---- sweeps ---- */
  function renderSweeps() {
    sweepList.innerHTML = sweeps.map(sweepRow).join("");
    sweepsEl.hidden = sweeps.length === 0;
  }

  function loadSweeps() {
    return api
      .fetchSweeps(3)
      .then((d) => {
        if (!alive) return;
        sweeps = (d && d.sweeps) || [];
        renderSweeps();

        if (location.hash === "#sweeps" && !sweepsEl.hidden)
          sweepsEl.scrollIntoView({ block: "start" });
      })
      .catch(() => {
        if (!alive) return;
        sweeps = [];
        sweepList.innerHTML = '<li class="sec-sub today-err">' + esc(OFFLINE) + "</li>";
        sweepsEl.hidden = false;
      });
  }

  function letGo(row, s) {
    if (row.classList.contains("is-going")) return;
    window.chHaptic?.("archived");
    row.classList.add("is-going");
    row.querySelectorAll("button").forEach((b) => (b.disabled = true));
    api
      .applySweep({
        kind: s.kind,
        source: s.source,
        subreddit: s.subreddit,
        before_utc: s.before_utc,
      })
      .then((r) => {
        if (!alive) return;
        setTimeout(() => {
          if (!alive) return;
          row.remove();
          sweeps = sweeps.filter((x) => x.id !== s.id);
          sweepsEl.hidden = sweeps.length === 0;
          // Piles overlap (the age sweep shrinks too): refill to 3 rows with fresh counts.
          loadSweeps();
        }, SWEEP_COLLAPSE_MS);
        loadPulse();
        const what = s.kind === "subreddit" ? s.label + " saves" : s.label;
        snackbar(fmt(r.total) + " " + what + " rested.", () => {
          api
            .undoSweep(r.wave)
            .catch(() => toast("Undo didn't stick — try again in a moment."))
            .finally(() => {
              if (!alive) return;
              loadSweeps();
              loadPulse();
            });
        });
      })
      .catch(() => {
        if (!alive) return;
        row.classList.remove("is-going");
        row.querySelectorAll("button").forEach((b) => (b.disabled = false));
        toast("That didn't stick — the pile is still here.");
      });
  }

  /* ---- resurface whisper ---- */
  function loadWhisper() {
    api
      .fetchResurface()
      .then((card) => {
        if (!alive || !card) return;
        whisper = card;
        $(".whisper-q").innerHTML =
          "Still curious about <b>" + esc(card.label) + "</b>? " + esc(fmt(card.count)) + " saved.";
        whisperEl.hidden = false;
      })
      .catch(() => {});
  }

  function whisperAct(btn) {
    if (!whisper) return;
    const card = whisper;

    if (btn.classList.contains("whisper-peek")) {
      ctx.go("/clear?n=5&q=" + encodeURIComponent(card.cluster));
    } else if (btn.classList.contains("whisper-later")) {
      whisperEl.hidden = true;
      whisper = null;
      api.dismissResurface(card.cluster).catch(() => {});
    } else if (btn.classList.contains("whisper-letgo")) {
      whisperEl.hidden = true;
      whisper = null;
      api
        .letgoResurface(card.cluster)
        .then((r) => {
          if (alive) loadPulse();
          const wave = r && r.decayed_at;
          snackbar(
            card.label + " is resting now.",
            wave == null
              ? null
              : () =>
                  api
                    .undoLetgoResurface(card.cluster, wave)
                    .catch(() => toast("Undo didn't stick — try again in a moment."))
                    .finally(() => {
                      if (alive) loadPulse();
                    }),
          );
        })
        .catch(() => {
          if (!alive) return;
          whisper = card;
          whisperEl.hidden = false;
          toast("That didn't stick — try again in a moment.");
        });
    }
  }

  /* ---- events ---- */
  root.addEventListener(
    "click",
    (e) => {
      const t = e.target;

      if (!(t instanceof Element)) return;

      if (t.closest(".hero-go")) return start();
      const radio = t.closest(".hero-sizes [role=radio]");

      if (radio) return pickSize(Number(radio.dataset.n));

      if (t.closest(".today-theme")) return window.toggleTheme?.();
      const wbtn = t.closest(".whisper-acts button");

      if (wbtn) return whisperAct(wbtn);
      const row = t.closest(".sweep");

      if (!row) return;
      const s = sweeps.find((x) => x.id === row.dataset.id);

      if (!s) return;

      if (t.closest(".sweep-go")) letGo(row, s);
      else if (t.closest(".sweep-peek"))
        ctx.go("/clear?n=10&q=" + encodeURIComponent(sweepQuery(s)));
    },
    on,
  );

  // Enter anywhere starts the round — unless typing or another control has focus.
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Enter" || e.defaultPrevented || e.repeat) return;

      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const t = e.target;

      if (isTypingTarget(t)) return;

      if (
        t instanceof Element &&
        t !== goBtn &&
        t.closest("button, a, [role=radio], [contenteditable]")
      )
        return;
      e.preventDefault();
      start();
    },
    on,
  );

  document.addEventListener(
    "visibilitychange",
    () => {
      if (document.visibilityState === "visible") loadPulse();
    },
    on,
  );

  loadPulse();
  loadSweeps();
  loadWhisper();

  return {
    unmount() {
      alive = false;
      cancelAnimationFrame(countRaf);
      clearTimeout(popTimer);
      ac.abort();
    },
  };
}
