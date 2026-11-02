import {
  getJSON,
  setStatus,
  undoItem,
  snoozeItem,
  undoSnooze,
  fetchItem,
  fetchPulse,
} from "../core/api.js";
import { mountVideo } from "../core/media.js";
import { esc, isTypingTarget } from "../core/util.js";
import { ringSvg } from "../core/ring.js";
import { attachSwipe } from "../core/swipe.js";
import { toast, snackbar } from "../core/toast.js";
import { track, flush } from "../core/track.js";

const KEY = "ch.round";

const HOWTO_KEY = "ch.howto";

const SIZES = [5, 10, 25];

const ENTER_MS = 260;

const LEAVE_MS = 300;

const COMMIT_PX = 90;

const FLING = 0.55;

const TILT = 0.06;

const TAP_GUARD_MS = 300;

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

const LEAVE_WAIT_MS = 1500;

const HINT_PULL_MS = [2500, 6000, 12000, 20000];

const HINT_RESUME_MS = [300, ...HINT_PULL_MS];

const HINT_BATCH = 30;

const HINT_POLL_MS = 5000;

const HINT_WINDOW_MS = 60000;

const haptic = (kind) => window.chHaptic?.(kind);

const fmtClock = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));

  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
};

const fmtMinutes = (m) => {
  const h = Math.floor(m / 60);

  return h ? h + " h" + (m % 60 ? " " + (m % 60) + " min" : "") : m + " min";
};

const reduceMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

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

const dailyGoal = () => {
  const g = parseInt(localStorage.getItem("chGoal") ?? "", 10);

  return Number.isFinite(g) && g >= 0 ? g : 8;
};

const todayHtml = (n, g) => {
  const line =
    n + " cleared today" + (g > 0 && n >= g ? " — goal met. Anything more is a bonus." : "");

  return ringSvg(n, g) + '<span class="cleared-today-line">' + esc(line) + "</span>";
};

const cardFrom = (item) => {
  const tpl = document.createElement("template");

  tpl.innerHTML = item.html;

  return tpl.content.firstElementChild;
};

const hintOf = (node) => {
  const verdict = node ? node.dataset.hint : "";

  if (verdict !== "keep" && verdict !== "skip") return null;

  return { verdict, by: node.dataset.hintBy === "history" ? "history" : "ai" };
};

const hintFrom = (markup) => {
  const el = markup ? cardFrom({ html: markup }) : null;

  if (!el) return null;

  return hintOf(el.matches("[data-hint]") ? el : el.querySelector("[data-hint]"));
};

const cardIn = (root, fullname) => {
  for (const el of root.querySelectorAll(".card")) if (el.dataset.fullname === fullname) return el;

  return null;
};

const itemHint = (item) => {
  if (!item) return null;

  if (item.hint === undefined) item.hint = hintFrom(item.html);

  return item.hint;
};

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

    const onLoad = () => {
      if (img.naturalWidth === 161 && img.naturalHeight === 81) onError();
    };

    img.addEventListener("load", onLoad);

    if (img.complete) onLoad();
  }
};

const sameIds = (a, b) => (Array.isArray(a) ? a.join(",") : "") === b.join(",");

const newRoundId = () =>
  (
    globalThis.crypto?.randomUUID?.() ||
    Math.random().toString(36).slice(2) + Date.now().toString(36)
  )
    .replace(/-/g, "")
    .slice(0, 32);

const loadSaved = (params) => {
  let r;

  try {
    r = JSON.parse(sessionStorage.getItem(KEY) || "null");
  } catch {
    return null;
  }

  if (!r || !Array.isArray(r.items) || !Array.isArray(r.results) || !r.items.length) return null;

  if (!(r.idx >= 0 && r.idx < r.items.length)) return null;

  if (!r.items.every((it) => it && it.fullname && it.html)) return null;

  if (params.bare) return r;

  if (params.ids.length) return sameIds(r.ids, params.ids) ? r : null;

  return (r.q || "") === params.q && r.n === params.n ? r : null;
};

export function mountRound(root) {
  const section = root && root.matches(".round") ? root : root?.querySelector(".round");

  if (!section || section.dataset.mounted) return;
  section.dataset.mounted = "1";

  const params = readParams();

  let round = null;
  let state = "loading";
  let gen = 0;
  let combo = 0;
  let shownAt = 0;
  let cardEl = null;
  let comboEl = null;
  let leaving = false;
  let clip = null;

  const viewed = new Set();

  const hintKeys = new Set();

  let hintUntil = 0;

  let announced = "";

  let finalised = "";

  const pending = new Map();

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
  const howto = section.querySelector(".howto");

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

  const stopClip = () => {
    if (!clip) return;

    if (clip.video) clip.video.pause();

    if (clip.destroy) clip.destroy();
    clip = null;
  };

  const playClip = (figure) => {
    stopClip();
    figure.classList.remove("is-missing");
    figure.classList.add("is-playing");
    figure.removeAttribute("data-open");
    clip = mountVideo(figure, figure.dataset.play, figure.querySelector(".media-img")?.src, {
      autoplay: true,
    });
  };

  function go(url) {
    if (leaving) return;
    leaving = true;
    stopClip();
    const wait = new Promise((resolve) => setTimeout(resolve, LEAVE_WAIT_MS));

    Promise.race([Promise.allSettled(pending.values()), wait]).then(() => {
      location.href = url;
    });
  }

  function setState(s) {
    state = s;
    section.dataset.state = s;
    pad.hidden = s === "empty" || s === "done";
    cleared.hidden = s !== "done";
  }

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

  function measureBody(el) {
    const body = el.querySelector(".card-body");
    const more = el.querySelector(".card-more");

    if (!body || !more) return;

    const check = () => {
      if (more.hidden && body.scrollHeight > body.clientHeight + 4) more.hidden = false;
    };

    check();
    body.addEventListener("load", check, true);
  }

  function toggleExpand() {
    const more = cardEl && cardEl.querySelector(".card-more");

    if (!more || more.hidden) return false;
    const on = cardEl.classList.toggle("is-expanded");

    more.textContent = on ? "Show less" : "Show more";
    more.setAttribute("aria-expanded", String(on));
    const fg = cardEl.querySelector(".card-fg");

    if (fg) {
      fg.style.touchAction = on ? "pan-y" : "none";

      if (!on) fg.scrollTop = 0;
    }

    return true;
  }

  function peekFor(item) {
    const el = item ? cardFrom(item) : null;

    if (!el) return null;
    el.classList.add("is-next");
    el.setAttribute("aria-hidden", "true");
    el.inert = true;
    wireMedia(el);

    return el;
  }

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

  function showCard(back = "") {
    stopClip();
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

    attachSwipe(el, {
      allowVertical: () => !el.classList.contains("is-expanded"),
      onRight: () => decide("archived", "swipe", true),
      onLeft: () => decide("done", "swipe", true),
      onUp: () => openCurrent(),
      onDown: () => decide("skip", "swipe", true),
      onDrag: (dx, dy) => dragFeedback(el, dx, dy),
      mouse: false,
      commit: COMMIT_PX,
      fling: FLING,
      commitDelay: 0,
      tilt: TILT,
    });

    const hint = hintOf(el.querySelector(".card-hint-slot [data-hint]"));

    if (!viewed.has(item.fullname)) {
      viewed.add(item.fullname);
      const data = { idx: round.idx, hinted: Boolean(hint) };

      if (hint) data.hint_by = hint.by;

      track("card_view", data, { fullname: item.fullname });
    }

    if (hint) {
      const key = item.fullname + "\u0000" + hint.by;

      if (!hintKeys.has(key)) {
        hintKeys.add(key);
        track("hint_shown", { by: hint.by, idx: round.idx });
      }
    }

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

  async function deal() {
    const qs = new URLSearchParams({ n: String(params.n) });

    if (params.q) qs.set("q", params.q);

    if (params.ids.length) qs.set("ids", params.ids.join(","));

    if (safeOn()) qs.set("safe", "1");
    const res = await getJSON("/clear/deal?" + qs);
    const items = res && Array.isArray(res.items) ? res.items : [];

    return items.filter((it) => it && it.fullname && it.html);
  }

  function patchHints(hints) {
    let changed = false;

    for (const [idx, item] of round.items.entries()) {
      if (!item || !item.fullname) continue;

      if (!Object.hasOwn(hints, item.fullname)) continue;
      const markup = hints[item.fullname];
      const el = cardFrom(item);
      const slot = el ? el.querySelector(".card-hint-slot") : null;

      if (!slot) continue;

      slot.innerHTML = markup;
      item.html = el.outerHTML;
      item.hint = hintFrom(markup);
      changed = true;

      for (const live of stage.querySelectorAll(".card")) {
        if (live.dataset.fullname !== item.fullname) continue;
        const liveSlot = live.querySelector(".card-hint-slot");

        if (liveSlot) liveSlot.innerHTML = markup;
      }

      const current = round.items[round.idx];
      const hint = item.hint;

      if (hint && viewed.has(item.fullname) && current && current.fullname === item.fullname) {
        const key = item.fullname + "\u0000" + hint.by;

        if (!hintKeys.has(key)) {
          hintKeys.add(key);
          track("hint_shown", { by: hint.by, idx });
        }
      }
    }

    return changed;
  }

  function clearAiHints() {
    if (!round) return;

    for (const item of round.items) {
      if (!item || !item.fullname) continue;
      const hint = itemHint(item);

      if (!hint || hint.by !== "ai") continue;
      const el = cardFrom(item);
      const slot = el ? el.querySelector(".card-hint-slot") : null;

      if (slot) slot.innerHTML = "";

      if (el) item.html = el.outerHTML;
      item.hint = null;
    }

    for (const live of stage.querySelectorAll(".card .card-hint-slot [data-hint-by='ai']")) {
      const slot = live.closest(".card-hint-slot");

      if (slot) slot.innerHTML = "";
    }

    save();
  }

  function requestHints(my, ids) {
    if (!ids.length) return;

    getJSON("/clear/hints?ids=" + encodeURIComponent(ids.join(",")))
      .then((res) => {
        if (my !== gen || !round || !res || !res.hints) return;

        if (patchHints(res.hints)) {
          hintUntil = Date.now() + HINT_WINDOW_MS;
          save();
        }
      })
      .catch(() => {});
  }

  function pullHints(my) {
    if (my !== gen || !round || state !== "playing") return;

    const ids = round.items
      .slice(round.idx)
      .map((item) => (item ? item.fullname : ""))
      .filter(Boolean);

    for (let start = 0; start < ids.length; start += HINT_BATCH)
      requestHints(my, ids.slice(start, start + HINT_BATCH));
  }

  function allHinted() {
    if (!round) return true;

    return round.items.slice(round.idx).every((item) => Boolean(itemHint(item)));
  }

  function scheduleHints(delays, forceFirst = false) {
    const my = gen;

    delays.forEach((ms, i) => {
      later(() => {
        if (my !== gen || !round || state !== "playing") return;

        if (!(forceFirst && i === 0) && allHinted()) return;
        pullHints(my);
      }, ms);
    });
  }

  function pollHints(my) {
    if (my !== gen || !round || state !== "playing") return;

    if (Date.now() >= hintUntil || allHinted()) return;

    pullHints(my);
    later(() => pollHints(my), HINT_POLL_MS);
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

    round = {
      rid: newRoundId(),
      q: params.q,
      n: params.n,
      ids: params.ids,
      items,
      idx: 0,
      results: [],
      startedAt: 0,
    };
    viewed.clear();
    hintKeys.clear();
    announced = round.rid;
    save();
    track("round_start", { size: items.length, resumed: false, round_id: round.rid });
    hintUntil = Date.now() + HINT_WINDOW_MS;
    showCard();
    scheduleHints(HINT_PULL_MS);
    later(() => pollHints(my), HINT_POLL_MS);
  }

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

    if (!round.rid) {
      round.rid = newRoundId();
      save();
    }

    params.n = SIZES.includes(saved.n) ? saved.n : params.n;
    params.q = saved.q || "";
    params.ids = Array.isArray(saved.ids) ? saved.ids : [];
    const my = ++gen;

    if (announced !== round.rid) {
      announced = round.rid;
      track("round_start", { size: round.items.length, resumed: true, round_id: round.rid });
    }

    setState("loading");
    setStage('<article class="card is-skeleton" aria-hidden="true"></article>');
    renderProgress();
    await reconcile();

    if (my !== gen) return;

    if (round.idx >= round.items.length) finish();
    else {
      hintUntil = Date.now() + HINT_WINDOW_MS;
      showCard();
      scheduleHints(HINT_RESUME_MS, true);
      later(() => pollHints(my), HINT_POLL_MS);
    }
  }

  function freedMinutes() {
    let total = 0;

    round.results.forEach((r, i) => {
      if (r.act !== "done" && r.act !== "archived") return;
      const el = cardFrom(round.items[i]);

      total += Number(el?.dataset.cost) || 0;
    });

    return total;
  }

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
    const n = count.done + count.archived + count.keep;

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

    if (finalised !== round.rid) {
      finalised = round.rid;
      track("round_end", {
        completed: true,
        decided: round.results.length,
        ms,
        round_id: round.rid,
      });
    }

    const at = Date.now();

    try {
      localStorage.setItem("ch.lastRound", JSON.stringify({ at, cleared: n, ms }));
    } catch {}

    document.cookie =
      "ch_last_round=" + at + "." + n + "; Path=/; SameSite=Lax; Max-Age=" + MONTH_S;

    forget();
  }

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

  function hintBody(item) {
    if (!item) return undefined;

    const current = cardEl && cardEl.dataset.fullname === item.fullname ? cardEl : null;
    const card = current || cardIn(stage, item.fullname);

    const hint = card
      ? hintOf(card.querySelector(".card-hint-slot [data-hint]"))
      : hintFrom(item.html);

    item.hint = hint;

    return hint ? { hint } : undefined;
  }

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
        : setStatus(fn, result.act, hintBody(item));

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

  function putBack(item, result) {
    if (!round) return;
    const pos = round.results.indexOf(result);

    if (pos < 0) return;

    if (state !== "playing" || pos !== round.results.length - 1) {
      toast("One card didn't save. It stays in your inbox.");

      return;
    }

    round.results.splice(pos, 1);
    round.items.splice(pos, 1);
    round.idx -= 1;
    round.items.splice(round.idx, 0, item);
    combo = 0;
    save();
    toast("That didn't stick — the card is back.");
    showCard();
  }

  function decide(act, method = "tap", flung = false) {
    if (leaving || state !== "playing" || !round) return;
    const item = round.items[round.idx];

    if (!item) return;

    combo = Date.now() - shownAt < COMBO_MS ? combo + 1 : 0;
    const result = { fullname: item.fullname, act };

    const hint = cardEl ? hintOf(cardEl.querySelector(".card-hint-slot [data-hint]")) : null;
    const data = { act, method, dwell_ms: Math.max(0, Date.now() - shownAt) };

    if (hint) {
      data.hint = hint.verdict;
      data.hint_by = hint.by;
    }

    track("decision", data, { fullname: item.fullname });

    round.results.push(result);
    round.idx += 1;
    save();
    haptic(act === "skip" || act === "snooze" ? "skip" : act);

    if (act !== "skip") send(item, result);

    const ghost = cardEl;

    stopClip();

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
    if ((state !== "playing" && state !== "done") || !round || !round.results.length) return;
    const result = round.results.pop();

    round.idx -= 1;
    combo = 0;
    save();
    track("undo", {});

    if (result.act !== "skip") {
      (pending.get(result.fullname) || Promise.resolve(true))
        .then((ok) => (ok ? revert(result) : null))
        .catch(() => toast("Undo didn't stick — try again."));
    }

    showCard(result.act);
    hintUntil = Date.now() + HINT_WINDOW_MS;
    pullHints(gen);
  }

  function openCurrent() {
    if (state !== "playing" || !round) return;
    const item = round.items[round.idx];

    if (!item) return;
    save();
    track("reader_open", {}, { fullname: item.fullname });
    go("/library?open=" + encodeURIComponent(item.fullname) + "&from=clear&enter=up");
  }

  function run(act, method = "tap") {
    if (act === "undo") undo();
    else if (act === "open") openCurrent();
    else if (act in BEAD) decide(act, method);
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

  function onClick(e) {
    if (leaving) return;

    const accept = e.target.closest("[data-hint-accept]");

    if (accept && cardEl && cardEl.contains(accept)) {
      e.preventDefault();
      const hint = accept.closest("[data-hint]");

      if (!hint) return;

      decide(hint.dataset.hint === "skip" ? "archived" : "keep", "hint");

      return;
    }

    const veiled = e.target.closest(".card-media.is-nsfw");

    if (veiled && cardEl && cardEl.contains(veiled)) {
      e.preventDefault();
      e.stopPropagation();
      veiled.classList.remove("is-nsfw");

      return;
    }

    const playing = e.target.closest(".card-media.is-playing");

    if (playing && cardEl && cardEl.contains(playing)) return;

    const playable = e.target.closest(".card-media[data-play]");

    if (playable && cardEl && cardEl.contains(playable)) {
      e.preventDefault();
      playClip(playable);

      return;
    }

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
    else if (t.dataset.act) {
      if (t.dataset.act in BEAD && Date.now() - shownAt < TAP_GUARD_MS) return;

      run(t.dataset.act);
    }
  }

  function onKey(e) {
    if (leaving || howto?.open || e.ctrlKey || e.metaKey || e.altKey) return;

    if (isTypingTarget(e.target)) return;

    if (e.key === "Escape") {
      e.preventDefault();
      go("/");

      return;
    }

    if ((e.key === "Enter" || e.key === " ") && e.target.closest && e.target.closest("button, a"))
      return;

    if (e.key === " ") {
      if (state === "playing" && toggleExpand()) e.preventDefault();

      return;
    }

    const act = KEYS[e.key.length === 1 ? e.key.toLowerCase() : e.key];

    if (!act || (state !== "playing" && !(state === "done" && act === "undo"))) return;
    e.preventDefault();

    if (e.repeat && act !== "open") return;
    run(act, "key");
  }

  section.addEventListener(
    "pointerdown",
    (e) => {
      if (e.target.closest && e.target.closest("[data-hint-accept]")) e.stopPropagation();
    },
    true,
  );

  section.addEventListener("click", onClick);
  document.addEventListener("keydown", onKey);
  document.addEventListener("ch:ai-consent", (e) => {
    if (e.detail && e.detail.on === false) clearAiHints();

    hintUntil = Date.now() + HINT_WINDOW_MS;
    pullHints(gen);
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;

    hintUntil = Date.now() + HINT_WINDOW_MS;
    pullHints(gen);
  });

  if (howto) {
    const openHowto = () => {
      if (!howto.open) howto.showModal();
    };

    section.querySelector(".round-help")?.addEventListener("click", openHowto);
    howto.querySelector(".howto-ok").addEventListener("click", () => howto.close());
    howto.addEventListener("click", (e) => {
      if (e.target === howto) howto.close();
    });
    howto.addEventListener("close", () => {
      try {
        localStorage.setItem(HOWTO_KEY, "1");
      } catch {}
    });

    try {
      if (!localStorage.getItem(HOWTO_KEY)) openHowto();
    } catch {}
  }

  window.addEventListener("pagehide", () => {
    if (!round || state !== "playing") return;

    track("round_suspend", {
      round_id: round.rid,
      decided: round.results.length,
      ms: round.startedAt ? Date.now() - round.startedAt : 0,
    });
    flush();
  });

  window.addEventListener("pageshow", (e) => {
    if (!e.persisted) return;
    leaving = false;

    if (round && state === "playing") resume(round);
  });

  const saved = loadSaved(params);

  if (saved) resume(saved);
  else fresh();
}
