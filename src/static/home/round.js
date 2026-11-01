/* home/round.js — the Clear island: one card at a time, 5/10/25 per round, ends with the
   CLEARED stamp (clear-overhaul.md §4.3 + §5, clear-v2.md §5). The server renders the round
   frame (GET /clear) and every card's HTML (GET /clear/deal); this island only deals,
   animates and decides. Decisions are optimistic: the card leaves at once
   and the POST runs in the background; a failed POST puts the card back. State (card HTML
   included) persists in sessionStorage["ch.round"] so a reload or a trip to the reader
   resumes the round. */

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
import { ringSvg } from "../core/ring.js";
import { attachSwipe } from "../core/swipe.js";
import { toast, snackbar } from "../core/toast.js";

const KEY = "ch.round";

const SIZES = [5, 10, 25];

/* Animation lengths the island waits on (CSS owns the curves; JS only cleans up after them). */
const ENTER_MS = 260;

const LEAVE_MS = 300;

/* Card-mode gesture tuning (core/swipe.js): commit distance, flick speed (px/ms), tilt (deg/px). */
const COMMIT_PX = 90;

const FLING = 0.55;

const TILT = 0.06;

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

const COMBO_HTML = '<p class="combo" aria-live="polite" hidden></p>';

const MONTH_S = 30 * 24 * 60 * 60;

/* Leaving the page waits this long at most for in-flight decision POSTs to land. */
const LEAVE_WAIT_MS = 1500;

const haptic = (kind) => window.chHaptic?.(kind);

const fmtClock = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));

  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
};

/* "25 min", "1 h 10 min" */
const fmtMinutes = (m) => {
  const h = Math.floor(m / 60);

  return h ? h + " h" + (m % 60 ? " " + (m % 60) + " min" : "") : m + " min";
};

const reduceMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* Numbers on the cleared screen count up (Duolingo's lesson-end beat), once, ~0.7 s. */
const countUp = (el, to, fmt) => {
  if (reduceMotion() || to <= 1) {
    el.textContent = fmt(to);

    return;
  }

  const t0 = performance.now();
  const dur = 700;

  const step = (t) => {
    const k = Math.min(1, (t - t0) / dur);

    el.textContent = fmt(Math.round(to * (1 - Math.pow(1 - k, 3))));

    if (k < 1) requestAnimationFrame(step);
  };

  requestAnimationFrame(step);
};

const readParams = () => {
  const p = new URLSearchParams(location.search);
  const n = Number(p.get("n"));

  return {
    n: SIZES.includes(n) ? n : 10,
    q: (p.get("q") || "").trim(),
    ids: (p.get("ids") || "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
    bare: !p.has("n") && !p.has("q") && !p.has("ids"),
  };
};

const safeOn = () => localStorage.chSafe !== "0";

/* Daily goal in pebbles (Today shares the key); 0 = no goal. */
const dailyGoal = () => {
  const g = parseInt(localStorage.getItem("chGoal") ?? "", 10);

  return Number.isFinite(g) && g >= 0 ? g : 8;
};

/* "<ring> 12 cleared today — goal met. …" under the cleared summary (Today's ring, small). */
const todayHtml = (n, g) => {
  const line =
    n + " cleared today" + (g > 0 && n >= g ? " — goal met. Anything more is a bonus." : "");

  return ringSvg(n, g) + '<span class="cleared-today-line">' + esc(line) + "</span>";
};

/* Card HTML (server-rendered, trusted) → a detached `.card` element, or null. */
const cardFrom = (item) => {
  const tpl = document.createElement("template");

  tpl.innerHTML = item.html;

  return tpl.content.firstElementChild;
};

/* Broken media: try the archived copy once (data-fallback, mirrored into the blurred backdrop),
   then drop the figure and let the card fall back to its typeset poster layout. */
const wireMedia = (card) => {
  for (const img of card.querySelectorAll(".media-img, .md img[data-fallback]")) {
    let fellBack = false;
    const figure = img.closest(".card-media");
    const backdrop = figure && figure.querySelector(".media-bg");

    const onError = () => {
      const fallback = img.dataset.fallback;

      if (fallback && !fellBack) {
        fellBack = true;
        img.src = fallback;

        if (backdrop) backdrop.src = fallback;

        return;
      }

      img.removeEventListener("error", onError);

      if (figure) {
        figure.remove();
        card.dataset.layout = "text";
      } else img.remove();
    };

    img.addEventListener("error", onError);

    // Imgur serves a real 161×81 "image no longer available" PNG for deleted images.
    const onLoad = () => {
      if (img.naturalWidth === 161 && img.naturalHeight === 81) onError();
    };

    img.addEventListener("load", onLoad);

    if (img.complete) onLoad();
  }
};

const sameIds = (a, b) => (Array.isArray(a) ? a.join(",") : "") === b.join(",");

const loadSaved = (params) => {
  let r;

  try {
    r = JSON.parse(sessionStorage.getItem(KEY) || "null");
  } catch {
    return null;
  }

  if (!r || !Array.isArray(r.items) || !Array.isArray(r.results) || !r.items.length) return null;

  if (!(r.idx >= 0 && r.idx < r.items.length)) return null; // finished or corrupt

  // A pre-v2 round stored no card HTML; it can't be shown, so start fresh.
  if (!r.items.every((it) => it && it.fullname && it.html)) return null;

  // The reader returns to bare /clear (contract §6): resume whatever round is open.
  if (params.bare) return r;

  // Today's Up next deals exact ids: the same deal resumes, a different one starts fresh.
  if (params.ids.length) return sameIds(r.ids, params.ids) ? r : null;

  return (r.q || "") === params.q && r.n === params.n ? r : null;
};

export function mountRound(root) {
  const section = root && root.matches(".round") ? root : root?.querySelector(".round");

  if (!section || section.dataset.mounted) return;
  section.dataset.mounted = "1";

  const params = readParams();

  // { q, n, ids, items: [{ fullname, status, html }], idx, results: [{ fullname, act, undo? }],
  //   startedAt }
  let round = null;
  let state = "loading";
  let gen = 0; // bumps per fresh fetch so a stale response can't land
  let combo = 0;
  let shownAt = 0;
  let cardEl = null;
  let comboEl = null;
  let leaving = false;

  const pending = new Map(); // fullname → Promise<boolean> for the in-flight decision POST

  const beads = section.querySelector(".beads");
  const stage = section.querySelector(".stage");
  const pad = section.querySelector(".pad");
  const undoBtn = section.querySelector(".undo");
  const cleared = section.querySelector(".cleared");
  const clearedLine = section.querySelector(".cleared-line");
  const receipt = section.querySelector(".receipt");
  const statN = section.querySelector(".cs-n");
  const statFreed = section.querySelector(".cs-freed");
  const statFreedBox = section.querySelector(".cs-freed-box");
  const statTime = section.querySelector(".cs-time");
  const clearedToday = section.querySelector(".cleared-today");

  const later = (fn, ms) => setTimeout(fn, ms);

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

  /* Real navigation; in-flight decision POSTs get a moment to land so unload can't drop them. */
  function go(url) {
    if (leaving) return;
    leaving = true;
    const wait = new Promise((resolve) => setTimeout(resolve, LEAVE_WAIT_MS));

    Promise.race([Promise.allSettled(pending.values()), wait]).then(() => {
      location.href = url;
    });
  }

  /* ---- rendering ---- */

  function setState(s) {
    state = s;
    section.dataset.state = s;
    pad.hidden = s === "empty" || s === "done";
    cleared.hidden = s !== "done";
  }

  /* Replace the stage, keeping any card still flying off (it cleans itself up). */
  function setStage(html) {
    const ghosts = stage.querySelectorAll(":scope > .card.is-leaving");

    stage.innerHTML = html + COMBO_HTML;
    stage.append(...ghosts);
    comboEl = stage.querySelector(".combo");
    cardEl = stage.querySelector(".card:not(.is-leaving)");
  }

  function renderProgress() {
    const total = round ? round.items.length : params.n;
    const decided = round ? round.idx : 0;
    let html = "";

    for (let i = 0; i < total; i++) {
      const res = round && i < decided ? round.results[i] : null;
      const cur = i === decided && state === "playing" ? " is-current" : "";
      const fresh = i === decided - 1 ? " is-new" : "";
      const cls = res ? " " + (BEAD[res.act] || "") + fresh : cur;

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

  /* Long bodies are clamped by CSS; offer "Show more" only when this one actually overflows. */
  function measureBody(el) {
    const body = el.querySelector(".card-body");
    const more = el.querySelector(".card-more");

    if (!body || !more) return;

    const check = () => {
      if (more.hidden && body.scrollHeight > body.clientHeight + 4) more.hidden = false;
    };

    check();
    body.addEventListener("load", check, true); // inline images grow the body after mount
  }

  function toggleExpand() {
    const more = cardEl && cardEl.querySelector(".card-more");

    if (!more || more.hidden) return false;
    const on = cardEl.classList.toggle("is-expanded");

    more.textContent = on ? "Show less" : "Show more";
    more.setAttribute("aria-expanded", String(on));

    if (!on) {
      const fg = cardEl.querySelector(".card-fg");

      if (fg) fg.scrollTop = 0;
    }

    return true;
  }

  /* The stack peek: the next card, inert, behind the current one. */
  function peekFor(item) {
    const el = item ? cardFrom(item) : null;

    if (!el) return null;
    el.classList.add("is-next");
    el.setAttribute("aria-hidden", "true");
    el.inert = true;
    wireMedia(el);

    return el;
  }

  /* Drag feedback, once per frame from core/swipe.js: the stamp and tint follow the thumb and the
     card underneath rises toward the top — opacity and transform only, so it stays on the
     compositor at any refresh rate. (0, 0) = settle: hand back to the CSS resting pose. */
  function dragFeedback(card, dx, dy) {
    const pull = Math.min(1, Math.max(Math.abs(dx), Math.abs(dy)) / COMMIT_PX);
    const stamp = card.querySelector(".card-stamp");
    const wash = card.querySelector(".card-wash");
    const peek = stage.querySelector(":scope > .card.is-next");

    if (stamp) stamp.style.opacity = pull ? String(pull) : "";

    if (wash) wash.style.opacity = pull ? String(pull * 0.18) : "";

    if (!peek) return;

    if (!pull) {
      peek.style.transition = "";
      peek.style.transform = "";
      peek.style.opacity = "";

      return;
    }

    peek.style.transition = "none";
    peek.style.transform =
      "translateY(" +
      (12 - 8 * pull).toFixed(1) +
      "px) scale(" +
      (0.94 + 0.04 * pull).toFixed(3) +
      ")";
    peek.style.opacity = String(0.55 + 0.35 * pull);
  }

  /* Show round.items[idx] as the current card. When the peek already holds it, the peek itself is
     promoted (no re-render, no image re-decode: it just rises into place). Otherwise a fresh card
     arrives — from the side it left by when `back` names the undone decision (a rewind). */
  function showCard(back = "") {
    const item = round.items[round.idx];
    const peekEl = stage.querySelector(":scope > .card.is-next");
    let el;

    if (!back && peekEl && peekEl.dataset.fullname === item.fullname) {
      el = peekEl;
      el.classList.remove("is-next");
      el.removeAttribute("aria-hidden");
      el.inert = false;
      el.style.cssText = el.style.cssText.replace(/\s*(transition|transform|opacity):[^;]*;?/g, "");
    } else {
      el = cardFrom(item);

      if (!el) {
        showMessage("This card didn't come through. Try a fresh round.", "again", "New round");

        return;
      }

      const from = back ? "return-" + back : "enter";

      el.classList.add(from);
      later(() => el.classList.remove(from), ENTER_MS);
      wireMedia(el);
    }

    // a rewound card replaces its own ghost if that is still flying
    for (const c of stage.querySelectorAll(":scope > .card")) {
      if (c === el) continue;

      if (!c.classList.contains("is-leaving") || c.dataset.fullname === item.fullname) c.remove();
    }

    if (!comboEl || !comboEl.isConnected) {
      stage.insertAdjacentHTML("beforeend", COMBO_HTML);
      comboEl = stage.querySelector(".combo");
    }

    if (!el.isConnected) stage.insertBefore(el, comboEl);
    const peek = peekFor(round.items[round.idx + 1]);

    if (peek) {
      peek.classList.add("peek-in");
      later(() => peek.classList.remove("peek-in"), ENTER_MS);
      stage.insertBefore(peek, el);
    }

    cardEl = el;
    measureBody(el);

    // attachSwipe slides the inner `.item-fg` (the server marks `.card-fg` with it too);
    // its listeners live on the card element and go away with it.
    attachSwipe(el, {
      onRight: () => decide("archived", true),
      onLeft: () => decide("done", true),
      onUp: () => openCurrent(),
      onDown: () => decide("skip", true),
      onDrag: (dx, dy) => dragFeedback(el, dx, dy),
      mouse: false,
      commit: COMMIT_PX,
      fling: FLING,
      commitDelay: 0,
      tilt: TILT,
    });

    shownAt = Date.now();

    if (!round.startedAt) {
      round.startedAt = shownAt;
      save();
    }

    setState("playing");
    renderProgress();
    renderCombo();
  }

  function showMessage(text, next, label) {
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

  async function deal() {
    const qs = new URLSearchParams({ n: String(params.n) });

    if (params.q) qs.set("q", params.q);

    if (params.ids.length) qs.set("ids", params.ids.join(","));

    if (safeOn()) qs.set("safe", "1");
    const res = await getJSON("/clear/deal?" + qs);
    const items = res && Array.isArray(res.items) ? res.items : [];

    return items.filter((it) => it && it.fullname && it.html);
  }

  async function fresh() {
    const my = ++gen;

    forget();
    pending.clear();
    round = null;
    combo = 0;
    setStage('<article class="card is-skeleton" aria-hidden="true"></article>');
    setState("loading");
    renderProgress();

    let items;

    try {
      items = await deal();
    } catch {
      if (my === gen)
        showMessage("Couldn't reach the server — is it running?", "retry", "Try again");

      return;
    }

    if (my !== gen) return;

    if (!items.length) {
      showMessage("Nothing waiting here. That's a clear deck.", "enough", "Back to Today");

      return;
    }

    round = { q: params.q, n: params.n, ids: params.ids, items, idx: 0, results: [], startedAt: 0 };
    save();
    showCard();
  }

  /* The current card may have been decided inside the reader (Open → Library → back).
     Only the decision is read from the server; the stored card HTML stays as dealt. */
  async function reconcile() {
    const item = round.items[round.idx];
    let latest;

    try {
      latest = await fetchItem(item.fullname);
    } catch {
      return;
    }

    if (!latest) return;
    const m = latest.metadata || {};
    const snoozed = m.snoozed_until && m.snoozed_until > Date.now() / 1000;
    let res = null;

    if (STATUS_ACTS.includes(latest.status)) res = { fullname: item.fullname, act: latest.status };
    else if (latest.status === "inbox" && snoozed)
      res = {
        fullname: item.fullname,
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
    params.ids = Array.isArray(saved.ids) ? saved.ids : [];
    const my = ++gen;

    setStage('<article class="card is-skeleton" aria-hidden="true"></article>');
    renderProgress();
    await reconcile();

    if (my !== gen) return;

    if (round.idx >= round.items.length) finish();
    else showCard();
  }

  /* Minutes of reading/watching the round let go of (done + archived; data-cost per card). */
  function freedMinutes() {
    let total = 0;

    round.results.forEach((r, i) => {
      if (r.act !== "done" && r.act !== "archived") return;
      const el = cardFrom(round.items[i]);

      total += Number(el?.dataset.cost) || 0;
    });

    return total;
  }

  /* The round's receipt: one tile per card, in order, marked with its decision. */
  function renderReceipt() {
    let html = "";

    round.results.forEach((r, i) => {
      const el = cardFrom(round.items[i]);

      if (!el) return;
      const hue = el.style.getPropertyValue("--hue").trim();
      const thumb = el.dataset.thumb || "";
      const title = (el.querySelector(".card-title, .card-context b")?.textContent || "").trim();

      html +=
        '<li class="rc ' +
        (BEAD[r.act] || "") +
        '" style="--hue: ' +
        esc(hue || "0") +
        "; --i: " +
        i +
        '" title="' +
        esc(title) +
        '">' +
        (thumb
          ? '<img src="' + esc(thumb) + '" alt="" loading="lazy" decoding="async" />'
          : '<span aria-hidden="true">' + esc(Array.from(title)[0] || "") + "</span>") +
        "</li>";
    });

    receipt.innerHTML = html;

    for (const img of receipt.querySelectorAll("img"))
      img.addEventListener("error", () => img.remove(), { once: true });
  }

  function finish() {
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

    const freed = freedMinutes();

    clearedLine.textContent = parts.join(" · ");
    renderReceipt();
    statFreedBox.hidden = freed < 1;
    countUp(statN, n, String);
    countUp(statFreed, Math.round(freed), fmtMinutes);
    statTime.textContent = fmtClock(ms);
    clearedToday.hidden = true;
    clearedToday.innerHTML = "";
    showToday();
    combo = 0;
    setStage("");
    setState("done");
    renderProgress();
    haptic("milestone");
    const at = Date.now();

    try {
      localStorage.setItem("ch.lastRound", JSON.stringify({ at, cleared: n, ms }));
    } catch {}

    // Today renders its re-entry line server-side from this cookie (clear-v2.md §6).
    document.cookie =
      "ch_last_round=" + at + "." + n + "; Path=/; SameSite=Lax; Max-Age=" + MONTH_S;

    forget();
  }

  /* Today's count lands after this round's POSTs settle; a failed fetch just omits the line. */
  function showToday() {
    const my = gen;

    Promise.allSettled(pending.values())
      .then(() => fetchPulse())
      .then((p) => {
        if (my !== gen || state !== "done") return;

        const n = Number(p?.cleared_today || 0) + Number(p?.swept_today || 0);

        clearedToday.innerHTML = todayHtml(n, dailyGoal());
        clearedToday.hidden = false;
      })
      .catch(() => {});
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

            if (round && round.results.includes(result)) save();

            if (res && res.decayed_at) snackbar("Snoozed enough times — it's resting now.");
          })
        : setStatus(fn, result.act);

    const p = req.then(
      () => true,
      () => {
        putBack(item, result);

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

    if (state === "playing") showCard();
  }

  /* Decide the current card. Input never waits on animation: the card becomes a ghost that flies
     off on its own (a flung card keeps the finger's flight; a button/key decision plays its leave
     animation) while the next card is promoted at once, so D D D D clears four cards as fast as
     the keys go. */
  function decide(act, flung = false) {
    if (leaving || state !== "playing" || !round) return;
    const item = round.items[round.idx];

    if (!item) return;

    combo = Date.now() - shownAt < COMBO_MS ? combo + 1 : 0;
    const result = { fullname: item.fullname, act };

    round.results.push(result);
    round.idx += 1;
    save();
    haptic(act === "skip" || act === "snooze" ? "skip" : act);

    if (act !== "skip") send(item, result);

    const ghost = cardEl;

    if (ghost) {
      ghost.classList.add("is-leaving", "leave-" + act);

      if (flung) ghost.classList.add("is-flung");

      ghost.inert = true;
      later(() => ghost.remove(), LEAVE_MS);
    }

    renderProgress();
    renderCombo();

    if (round.idx < round.items.length) {
      showCard();

      return;
    }

    // the last card: let it finish flying before the stamp lands (unless undone meanwhile)
    cardEl = null;
    const at = round.idx;

    later(() => {
      if (round && state === "playing" && round.idx === at) finish();
    }, LEAVE_MS - 60);
  }

  function revert(result) {
    if (result.act === "snooze") {
      return result.undo ? undoSnooze(result.undo) : Promise.reject(new Error("no snooze wave"));
    }

    return undoItem(result.fullname);
  }

  function undo() {
    if (state !== "playing" || !round || !round.results.length) return;
    const result = round.results.pop();

    round.idx -= 1;
    combo = 0;
    save();

    if (result.act !== "skip") {
      (pending.get(result.fullname) || Promise.resolve(true))
        .then((ok) => (ok ? revert(result) : null))
        .catch(() => toast("Undo didn't stick — try again."));
    }

    showCard(result.act);
  }

  function openCurrent() {
    if (state !== "playing" || !round) return;
    const item = round.items[round.idx];

    if (!item) return;
    save();
    go("/library?open=" + encodeURIComponent(item.fullname) + "&from=clear&enter=up");
  }

  function run(act) {
    if (act === "undo") undo();
    else if (act === "open") openCurrent();
    else if (act in BEAD) decide(act);
  }

  function next(kind) {
    if (kind === "retry") {
      fresh();
    } else if (kind === "again") {
      const qs = new URLSearchParams({ n: String(params.n) });

      if (params.q) qs.set("q", params.q);
      forget();
      go("/clear?" + qs);
    } else if (kind === "sweep") {
      go("/#piles");
    } else if (kind === "enough") {
      go("/");
    }
  }

  /* ---- input ---- */

  function onClick(e) {
    if (leaving) return;

    // NSFW media is blurred until tapped; the first tap only reveals it.
    const veiled = e.target.closest(".card-media.is-nsfw");

    if (veiled && cardEl && cardEl.contains(veiled)) {
      e.preventDefault();
      e.stopPropagation();
      veiled.classList.remove("is-nsfw");

      return;
    }

    // Tapping linkable media (video, link preview, gallery) is the Open action; plain images
    // carry no data-open and do nothing.
    const media = e.target.closest(".card-media[data-open]");

    if (media && cardEl && cardEl.contains(media)) {
      e.preventDefault();
      openCurrent();

      return;
    }

    const t = e.target.closest(".round-x, .card-more, [data-act], [data-next]");

    if (!t || !section.contains(t)) return;

    if (t.classList.contains("round-x")) go("/");
    else if (t.classList.contains("card-more")) toggleExpand();
    else if (t.dataset.next) next(t.dataset.next);
    else if (t.dataset.act) run(t.dataset.act);
  }

  function onKey(e) {
    if (leaving || e.ctrlKey || e.metaKey || e.altKey) return;

    if (isTypingTarget(e.target)) return;

    if (e.key === "Escape") {
      e.preventDefault();
      go("/");

      return;
    }

    // Enter/Space on a focused button is that button's click, not "open".
    if ((e.key === "Enter" || e.key === " ") && e.target.closest && e.target.closest("button, a"))
      return;

    if (e.key === " ") {
      if (state === "playing" && toggleExpand()) e.preventDefault();

      return;
    }

    const act = KEYS[e.key.length === 1 ? e.key.toLowerCase() : e.key];

    if (!act || state !== "playing") return;
    e.preventDefault();
    run(act);
  }

  section.addEventListener("click", onClick);
  document.addEventListener("keydown", onKey);

  // Back from the reader via the bfcache: the page is restored mid-leave, so re-check the
  // current card against the server (it may have been decided there) and take input again.
  window.addEventListener("pageshow", (e) => {
    if (!e.persisted) return;
    leaving = false;

    if (round && state === "playing") resume(round);
  });

  const saved = loadSaved(params);

  if (saved) resume(saved);
  else fresh();
}
