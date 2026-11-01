/* home/round.js — the Clear view: one card at a time, 5/10/25 per round, ends with the
   CLEARED stamp (contract §4.3 + §5). Decisions are optimistic: the card leaves at once and
   the POST runs in the background; a failed POST puts the card back. State persists in
   sessionStorage["ch.round"] so a reload or a trip to the reader resumes the round. */

import {
  getJSON,
  setStatus,
  undoItem,
  snoozeItem,
  undoSnooze,
  fetchItem,
  fetchPulse,
} from "../core/api.js";
import { esc, isTypingTarget } from "../core/util.js";
import { attachSwipe } from "../core/swipe.js";
import { toast, snackbar } from "../core/toast.js";
import { cardHtml } from "./card.js";

const KEY = "ch.round";

const SIZES = [5, 10, 25];

const ANIM_MS = 200;

const COMBO_MS = 6000;

const COMBO_MIN = 3;

const STATUS_ACTS = ["done", "archived", "keep"];

const BEAD = {
  done: "is-done",
  archived: "is-archived",
  keep: "is-keep",
  snooze: "is-snoozed",
  skip: "is-skip",
};

const KEYS = {
  d: "done",
  ArrowLeft: "done",
  a: "archived",
  ArrowRight: "archived",
  k: "keep",
  f: "keep",
  n: "snooze",
  s: "skip",
  ArrowDown: "skip",
  Enter: "open",
  o: "open",
  ArrowUp: "open",
  z: "undo",
  u: "undo",
};

const FRAME = `<section class="round" data-state="loading">
  <header class="round-bar">
    <button class="round-x" type="button" aria-label="End round">×</button>
    <ol class="beads" aria-label="0 of 0 decided"></ol>
    <span class="round-clock">0:00</span>
  </header>
  <div class="stage"></div>
  <div class="pad" role="group" aria-label="Decide">
    <div class="pad-minor">
      <button class="act act-keep" type="button" data-act="keep">Keep <kbd>K</kbd></button>
      <button class="act act-snooze" type="button" data-act="snooze">Not now <kbd>N</kbd></button>
      <button class="act act-skip" type="button" data-act="skip">Skip <kbd>S</kbd></button>
      <button class="act act-open" type="button" data-act="open">Open <kbd>↵</kbd></button>
    </div>
    <div class="pad-major">
      <button class="act act-done" type="button" data-act="done"><span>Done</span> <kbd>D</kbd></button>
      <button class="act act-archive" type="button" data-act="archived"><span>Archive</span> <kbd>A</kbd></button>
    </div>
    <button class="undo" type="button" data-act="undo" disabled>Undo <kbd>Z</kbd></button>
  </div>
  <div class="cleared" hidden>
    <p class="stamp">CLEARED</p>
    <p class="cleared-line"></p>
    <div class="cleared-today" hidden></div>
    <div class="cleared-acts">
      <button class="primary" type="button" data-next="again">One more round</button>
      <button type="button" data-next="sweep">Let a pile go</button>
      <button type="button" data-next="enough">That's enough for today</button>
    </div>
  </div>
</section>`;

const COMBO_HTML = '<p class="combo" aria-live="polite" hidden></p>';

const haptic = (kind) => window.chHaptic?.(kind);

const fmtClock = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));

  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
};

const readParams = () => {
  const p = new URLSearchParams(location.search);
  const n = Number(p.get("n"));

  return {
    n: SIZES.includes(n) ? n : 10,
    q: (p.get("q") || "").trim(),
    bare: !p.has("n") && !p.has("q"),
  };
};

const safeOn = () => localStorage.chSafe !== "0";

/* Daily goal in pebbles (Today shares the key); 0 = no goal. */
const dailyGoal = () => {
  const g = parseInt(localStorage.getItem("chGoal") ?? "", 10);

  return Number.isFinite(g) && g >= 0 ? g : 8;
};

/* "<pebbles> 12 cleared today — goal met. …" under the cleared summary. */
const todayHtml = (n, g) => {
  let pebbles = "";

  for (let i = 0; i < g; i++) pebbles += i < n ? '<i class="on"></i>' : "<i></i>";

  const line =
    n + " cleared today" + (g > 0 && n >= g ? " — goal met. Anything more is a bonus." : "");

  return (
    (g > 0 ? '<span class="pebbles" aria-hidden="true">' + pebbles + "</span>" : "") +
    '<span class="cleared-today-line">' +
    esc(line) +
    "</span>"
  );
};

const tagList = (v) => (Array.isArray(v) ? v : []);

const isNsfw = (item) => {
  const m = item.metadata || {};

  if (m.over_18) return true;

  return [...tagList(m.tags), ...tagList(m.tags_auto), ...tagList(m.tags_manual)].some((t) =>
    String(t).toLowerCase().includes("nsfw"),
  );
};

const loadSaved = (params) => {
  let r;

  try {
    r = JSON.parse(sessionStorage.getItem(KEY) || "null");
  } catch {
    return null;
  }

  if (!r || !Array.isArray(r.items) || !Array.isArray(r.results) || !r.items.length) return null;

  if (!(r.idx >= 0 && r.idx < r.items.length)) return null; // finished or corrupt

  // The reader returns to bare /clear (contract §6): resume whatever round is open.
  if (!params.bare && ((r.q || "") !== params.q || r.n !== params.n)) return null;

  return r;
};

export function mountRound(root, ctx) {
  const params = readParams();

  let alive = true;
  let round = null; // { q, n, items, idx, results:[{fullname, act, undo?}], startedAt }
  let state = "loading";
  let busy = false;
  let gen = 0; // bumps per fresh fetch so a stale response can't land
  let clock = null;
  let combo = 0;
  let shownAt = 0;
  let cardEl = null;

  const pending = new Map(); // fullname → Promise<boolean> for the in-flight decision POST
  const timers = new Set();

  document.body.classList.add("is-round");
  root.innerHTML = FRAME;

  const section = root.querySelector(".round");
  const beads = root.querySelector(".beads");
  const clockEl = root.querySelector(".round-clock");
  const stage = root.querySelector(".stage");
  const pad = root.querySelector(".pad");
  const undoBtn = root.querySelector(".undo");
  const cleared = root.querySelector(".cleared");
  const clearedLine = root.querySelector(".cleared-line");
  const clearedToday = root.querySelector(".cleared-today");

  let comboEl = null;

  const later = (fn, ms) => {
    const t = setTimeout(() => {
      timers.delete(t);

      if (alive) fn();
    }, ms);

    timers.add(t);
  };

  const save = () => {
    if (!round) return;

    try {
      sessionStorage.setItem(KEY, JSON.stringify(round));
    } catch {}
  };

  const forget = () => {
    try {
      sessionStorage.removeItem(KEY);
    } catch {}
  };

  /* ---- rendering ---- */

  function setState(s) {
    state = s;
    section.dataset.state = s;
    pad.hidden = s === "empty" || s === "done";
    cleared.hidden = s !== "done";
  }

  function setStage(html) {
    stage.innerHTML = html + COMBO_HTML;
    comboEl = stage.querySelector(".combo");
    cardEl = stage.querySelector(".card");
  }

  function renderProgress() {
    const total = round ? round.items.length : params.n;
    const decided = round ? round.idx : 0;
    let html = "";

    for (let i = 0; i < total; i++) {
      const res = round && i < decided ? round.results[i] : null;
      const cur = i === decided && state === "playing" ? " is-current" : "";
      const cls = res ? " " + (BEAD[res.act] || "") : cur;

      html += '<li class="bead' + cls + '"></li>';
    }

    beads.innerHTML = html;
    beads.setAttribute("aria-label", decided + " of " + total + " decided");
    undoBtn.disabled = !(round && round.results.length);
  }

  function renderCombo() {
    if (!comboEl) return;
    comboEl.hidden = combo < COMBO_MIN;
    comboEl.textContent = combo >= COMBO_MIN ? "on a roll · " + combo : "";
  }

  function tick() {
    if (round && round.startedAt) clockEl.textContent = fmtClock(Date.now() - round.startedAt);
  }

  function startClock() {
    if (clock) return;
    tick();
    clock = setInterval(tick, 1000);
  }

  function stopClock() {
    clearInterval(clock);
    clock = null;
  }

  function showCard() {
    const item = round.items[round.idx];
    const tpl = document.createElement("template");

    tpl.innerHTML = cardHtml(item);
    const el = tpl.content.firstElementChild;

    el.classList.add("enter");
    later(() => el.classList.remove("enter"), ANIM_MS);

    if (cardEl && cardEl.isConnected) cardEl.replaceWith(el);
    else setStage("");

    if (!el.isConnected) stage.prepend(el);
    cardEl = el;

    const img = el.querySelector(".card-thumb");

    if (img) img.addEventListener("error", () => img.remove(), { once: true });

    // attachSwipe slides the inner `.item-fg` (cardHtml marks `.card-fg` with it too);
    // its listeners live on the card element and go away with it.
    attachSwipe(el, {
      onRight: () => decide("archived"),
      onLeft: () => decide("done"),
      onUp: () => openCurrent(),
      onDown: () => decide("skip"),
      mouse: false,
    });

    shownAt = Date.now();

    if (!round.startedAt) {
      round.startedAt = shownAt;
      save();
    }

    setState("playing");
    startClock();
    renderProgress();
    renderCombo();
  }

  function showMessage(text, next, label) {
    stopClock();
    setStage(
      '<div class="round-empty"><p class="round-empty-msg">' +
        esc(text) +
        '</p><button class="primary" type="button" data-next="' +
        esc(next) +
        '">' +
        esc(label) +
        "</button></div>",
    );
    setState("empty");
    renderProgress();
  }

  /* ---- round lifecycle ---- */

  async function fetchBatch() {
    const want = params.n * 2;
    let items;

    if (params.q) {
      const qs = { q: params.q, status: "inbox", limit: String(want + 1) };

      if (safeOn()) qs.safe = "1";
      items = (await getJSON("/items?" + new URLSearchParams(qs))).items;
    } else {
      items = (await getJSON("/random?mode=smart&n=" + want)).items;
    }

    items = Array.isArray(items) ? items : [];

    if (safeOn()) items = items.filter((it) => !isNsfw(it));

    return items.slice(0, params.n);
  }

  async function fresh() {
    const my = ++gen;

    forget();
    stopClock();
    pending.clear();
    round = null;
    busy = false;
    combo = 0;
    clockEl.textContent = "0:00";
    setStage('<article class="card is-skeleton" aria-hidden="true"></article>');
    setState("loading");
    renderProgress();

    let items;

    try {
      items = await fetchBatch();
    } catch {
      if (alive && my === gen)
        showMessage("Couldn't reach the server — is it running?", "again", "Try again");

      return;
    }

    if (!alive || my !== gen) return;

    if (!items.length) {
      showMessage("Nothing waiting here. That's a clear deck.", "enough", "Back to Today");

      return;
    }

    round = { q: params.q, n: params.n, items, idx: 0, results: [], startedAt: 0 };
    save();
    showCard();
  }

  /* The current card may have been decided inside the reader (Open → Library → back). */
  async function reconcile() {
    const item = round.items[round.idx];
    let latest;

    try {
      latest = await fetchItem(item.fullname);
    } catch {
      return;
    }

    if (!latest || !alive) return;
    round.items[round.idx] = latest;
    const m = latest.metadata || {};
    const snoozed = m.snoozed_until && m.snoozed_until > Date.now() / 1000;
    let res = null;

    if (STATUS_ACTS.includes(latest.status))
      res = { fullname: latest.fullname, act: latest.status };
    else if (latest.status === "inbox" && snoozed)
      res = {
        fullname: latest.fullname,
        act: "snooze",
        undo: m.snoozed_wave ? { snoozed_wave: m.snoozed_wave } : null,
      };

    if (res) {
      round.results.push(res);
      round.idx += 1;
    }

    save();
  }

  async function resume(saved) {
    round = saved;
    // A bare /clear resumes whatever round was open; "One more round" keeps its size and pile.
    params.n = SIZES.includes(saved.n) ? saved.n : params.n;
    params.q = saved.q || "";
    const my = ++gen;

    setStage('<article class="card is-skeleton" aria-hidden="true"></article>');
    renderProgress();
    await reconcile();

    if (!alive || my !== gen) return;

    if (round.idx >= round.items.length) finish();
    else showCard();
  }

  function finish() {
    stopClock();
    const ms = round.startedAt ? Date.now() - round.startedAt : 0;
    const count = { done: 0, archived: 0, keep: 0, snooze: 0, skip: 0 };

    for (const r of round.results) if (r.act in count) count[r.act] += 1;
    const n = count.done + count.archived + count.keep + count.snooze;

    const parts = [
      count.done ? count.done + " done" : "",
      count.archived ? count.archived + " archived" : "",
      count.keep ? count.keep + " kept" : "",
      count.snooze ? count.snooze + " for later" : "",
    ].filter(Boolean);

    clockEl.textContent = fmtClock(ms);
    const summary = parts.length ? " — " + parts.join(" · ") : "";

    clearedLine.textContent = n + " in " + fmtClock(ms) + summary;
    clearedToday.hidden = true;
    clearedToday.innerHTML = "";
    showToday();
    combo = 0;
    setStage("");
    setState("done");
    renderProgress();
    haptic("milestone");

    try {
      localStorage.setItem("ch.lastRound", JSON.stringify({ at: Date.now(), cleared: n, ms }));
    } catch {}

    forget();
  }

  /* Today's count lands after this round's POSTs settle; a failed fetch just omits the line. */
  function showToday() {
    const my = gen;

    Promise.allSettled(pending.values())
      .then(() => fetchPulse())
      .then((p) => {
        if (!alive || my !== gen || state !== "done") return;

        const n = Number(p?.cleared_today || 0) + Number(p?.swept_today || 0);

        clearedToday.innerHTML = todayHtml(n, dailyGoal());
        clearedToday.hidden = false;
      })
      .catch(() => {});
  }

  function advance() {
    if (round.idx >= round.items.length) finish();
    else showCard();
  }

  /* ---- decisions ---- */

  function send(item, result) {
    const fn = item.fullname;

    const req =
      result.act === "snooze"
        ? snoozeItem(fn, { window_days: 7 }).then((res) => {
            result.undo =
              res && res.snoozed_wave
                ? { snoozed_wave: res.snoozed_wave }
                : res && res.decayed_at
                  ? { decayed_at: res.decayed_at }
                  : null;

            if (alive && round && round.results.includes(result)) save();

            if (res && res.decayed_at) snackbar("Snoozed enough times — it's resting now.");
          })
        : setStatus(fn, result.act);

    const p = req.then(
      () => true,
      () => {
        if (alive) putBack(item, result);

        return false;
      },
    );

    pending.set(fn, p);
    p.then(() => {
      if (pending.get(fn) === p) pending.delete(fn);
    });
  }

  /* A background POST failed: drop its result and make that item the current card again. */
  function putBack(item, result) {
    if (!round) return;
    const pos = round.results.indexOf(result);

    if (pos < 0) return; // already undone

    round.results.splice(pos, 1);
    round.items.splice(pos, 1);
    round.idx -= 1;
    round.items.splice(round.idx, 0, item);
    combo = 0;
    save();
    toast("That didn't stick — the card is back.");

    if (busy) return; // the running transition shows items[idx] — the card that came back

    showCard();
  }

  function decide(act) {
    if (busy || state !== "playing" || !round) return;
    const item = round.items[round.idx];

    if (!item) return;
    busy = true;

    combo = Date.now() - shownAt < COMBO_MS ? combo + 1 : 0;
    const result = { fullname: item.fullname, act };

    round.results.push(result);
    round.idx += 1;
    save();
    haptic(act === "skip" || act === "snooze" ? "skip" : act);

    if (act !== "skip") send(item, result);

    if (cardEl) cardEl.classList.add("leave-" + act);
    renderProgress();
    renderCombo();
    later(() => {
      busy = false;
      advance();
    }, ANIM_MS);
  }

  function revert(result) {
    if (result.act === "snooze") {
      return result.undo ? undoSnooze(result.undo) : Promise.reject(new Error("no snooze wave"));
    }

    return undoItem(result.fullname);
  }

  function undo() {
    if (busy || state !== "playing" || !round || !round.results.length) return;
    busy = true;
    const result = round.results.pop();

    round.idx -= 1;
    combo = 0;
    save();

    if (result.act !== "skip") {
      (pending.get(result.fullname) || Promise.resolve(true))
        .then((ok) => (ok ? revert(result) : null))
        .catch(() => toast("Undo didn't stick — try again."));
    }

    showCard();
    later(() => {
      busy = false;
    }, ANIM_MS);
  }

  function openCurrent() {
    if (busy || state !== "playing" || !round) return;
    const item = round.items[round.idx];

    if (!item) return;
    save();
    location.href = "/library?open=" + encodeURIComponent(item.fullname) + "&from=clear&enter=up";
  }

  function run(act) {
    if (act === "undo") undo();
    else if (act === "open") openCurrent();
    else if (act in BEAD) decide(act);
  }

  function next(kind) {
    if (kind === "again") fresh();
    else if (kind === "sweep") ctx.go("/#sweeps");
    else if (kind === "enough") ctx.go("/");
  }

  /* ---- input ---- */

  function onClick(e) {
    const t = e.target.closest(".round-x, [data-act], [data-next]");

    if (!t || !root.contains(t)) return;

    if (t.classList.contains("round-x")) ctx.go("/");
    else if (t.dataset.next) next(t.dataset.next);
    else if (t.dataset.act) run(t.dataset.act);
  }

  function onKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    if (isTypingTarget(e.target)) return;

    if (e.key === "Escape") {
      e.preventDefault();
      ctx.go("/");

      return;
    }

    // Enter/Space on a focused button is that button's click, not "open".
    if ((e.key === "Enter" || e.key === " ") && e.target.closest && e.target.closest("button, a"))
      return;

    const act = KEYS[e.key.length === 1 ? e.key.toLowerCase() : e.key];

    if (!act || state !== "playing") return;
    e.preventDefault();
    run(act);
  }

  root.addEventListener("click", onClick);
  document.addEventListener("keydown", onKey);

  const saved = loadSaved(params);

  if (saved) resume(saved);
  else fresh();

  return {
    unmount() {
      alive = false;
      gen += 1;
      stopClock();

      for (const t of timers) clearTimeout(t);
      timers.clear();
      root.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey);
      document.body.classList.remove("is-round");
    },
  };
}
