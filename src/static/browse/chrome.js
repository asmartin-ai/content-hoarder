import { esc } from "../core/util.js";
import { $, state, itemsEl } from "./shared.js";
import { installFastScroll } from "./fastscroll.js";

export function paintPulse() {
  const p = state.pulse;
  const newTxt = p.new_today ? "· " + p.new_today + " new" : "";
  $("#inbox-new").textContent = newTxt;
  $("#inbox-new-m").textContent = newTxt;
  const d = new Date();

  const day = d.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "long",
  });

  const freshLine = p.new_today
    ? "<b>" + p.new_today + " fresh</b> today. "
    : "<b>No fresh arrivals</b> today. ";

  $("#dateline").innerHTML = esc(day) + " — " + freshLine + '<em class="norush">No rush.</em>';
  $("#decayline").hidden = !p.swept_recent;
  $("#decay-n").textContent = p.swept_recent.toLocaleString();
}

const gotop = $("#gotop");

const GOTOP_AT = 700;

const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)");

const BROWSE_TOP_EPSILON = 1;

const BROWSE_SCROLL_SETTLE_MS = 140;

const PROGRAMMATIC_TOP_MAX_MS = 1800;

const browseTopScroll = (() => {
  let active = false;
  let settleTimer = 0;
  let hardTimer = 0;
  const startCallbacks = new Set();
  const endCallbacks = new Set();
  const atTop = () => (window.scrollY || 0) <= BROWSE_TOP_EPSILON;

  const clearSettle = () => {
    clearTimeout(settleTimer);
    settleTimer = 0;
  };

  const finish = () => {
    if (!active) return;
    active = false;
    clearSettle();
    clearTimeout(hardTimer);
    hardTimer = 0;
    endCallbacks.forEach((cb) => cb());
  };

  const finishIfTop = () => {
    if (atTop()) finish();
  };

  const scheduleTopSettle = () => {
    clearSettle();
    settleTimer = setTimeout(finishIfTop, BROWSE_SCROLL_SETTLE_MS);
  };

  return {
    get active() {
      return active;
    },
    onStart(cb) {
      startCallbacks.add(cb);
    },
    onEnd(cb) {
      endCallbacks.add(cb);
    },
    begin() {
      active = true;
      clearSettle();
      clearTimeout(hardTimer);
      startCallbacks.forEach((cb) => cb());
      hardTimer = setTimeout(finish, reducedMotion?.matches ? 300 : PROGRAMMATIC_TOP_MAX_MS);
    },
    noteScroll() {
      if (!active) return;

      if (atTop()) scheduleTopSettle();
      else clearSettle();
    },
    settleIfTop() {
      finishIfTop();
    },
  };
})();

let gotopTick = false;

function syncGotop() {
  gotopTick = false;
  const y = window.scrollY || 0;
  gotop.classList.toggle("show", browseTopScroll.active ? y > BROWSE_TOP_EPSILON : y > GOTOP_AT);
}

function scrollToBrowseTop() {
  browseTopScroll.begin();
  window.scrollTo({
    top: 0,
    left: 0,
    behavior: reducedMotion?.matches ? "auto" : "smooth",
  });

  if (reducedMotion?.matches) {
    requestAnimationFrame(() => {
      browseTopScroll.noteScroll();
      browseTopScroll.settleIfTop();
      syncGotop();
    });
  }
}

window.addEventListener(
  "scroll",
  () => {
    browseTopScroll.noteScroll();

    if (!gotopTick) {
      gotopTick = true;
      requestAnimationFrame(syncGotop);
    }
  },
  { passive: true },
);

if ("onscrollend" in window)
  window.addEventListener(
    "scrollend",
    () => {
      browseTopScroll.noteScroll();
      browseTopScroll.settleIfTop();
    },
    { passive: true },
  );

gotop.addEventListener("click", scrollToBrowseTop);

installFastScroll(itemsEl);

const APP_VERSION = "v140";

(() => {
  const ver = $("#set-version");

  if (ver) ver.textContent = APP_VERSION;
  const head = $(".console");

  if (!head) return;
  const COLLAPSE_AT = 110;
  const COMPACT_AT = 0.96;
  const UNCOMPACT_AT = 0.82;
  const SMOOTHING = 0.38;
  const OPEN_LOCK_AT = 0.25;
  const OPEN_LOCK_RELEASE_AT = 0.9;
  let targetCollapse = 0;
  let currentCollapse = 0;
  let openingTarget = null;
  let headerFrame = 0;
  let compact = false;
  const pageScrollLocked = () => document.body.style.position === "fixed";
  const clamp01 = (n) => Math.max(0, Math.min(1, n));
  const collapseForScroll = () => clamp01((window.scrollY || 0) / COLLAPSE_AT);

  function writeHeaderCollapse(amount) {
    const collapse = clamp01(amount);
    const open = 1 - collapse;
    head.style.setProperty("--console-collapse", collapse.toFixed(3));
    head.style.setProperty("--console-open", open.toFixed(3));

    if (!compact && collapse >= COMPACT_AT) compact = true;
    else if (compact && collapse <= UNCOMPACT_AT) compact = false;
    head.classList.toggle("compact", compact);
  }

  function animateHeaderCollapse() {
    if (pageScrollLocked()) {
      headerFrame = 0;

      return;
    }

    const diff = targetCollapse - currentCollapse;

    if (reducedMotion?.matches || Math.abs(diff) < 0.003) {
      currentCollapse = targetCollapse;
      writeHeaderCollapse(currentCollapse);
      openingTarget = null;
      headerFrame = 0;

      return;
    }

    currentCollapse += diff * SMOOTHING;
    writeHeaderCollapse(currentCollapse);
    headerFrame = requestAnimationFrame(animateHeaderCollapse);
  }

  const scheduleHeaderCollapse = (amount = collapseForScroll()) => {
    if (pageScrollLocked()) return;
    const measured = clamp01(amount);

    if (openingTarget != null) {
      if (measured > OPEN_LOCK_RELEASE_AT) openingTarget = null;
      else targetCollapse = openingTarget;
    }

    if (openingTarget == null) {
      if (measured < OPEN_LOCK_AT && currentCollapse > measured) openingTarget = measured;
      targetCollapse = openingTarget ?? measured;
    }

    if (!headerFrame) headerFrame = requestAnimationFrame(animateHeaderCollapse);
  };

  browseTopScroll.onStart(() => {
    openingTarget = null;
    targetCollapse = 0;
    currentCollapse = 0;
    writeHeaderCollapse(0);
  });
  browseTopScroll.onEnd(() => scheduleHeaderCollapse());
  window.addEventListener("scroll", () => scheduleHeaderCollapse(), {
    passive: true,
  });

  if ("onscrollend" in window)
    window.addEventListener("scrollend", () => scheduleHeaderCollapse(), {
      passive: true,
    });
  targetCollapse = collapseForScroll();
  currentCollapse = targetCollapse;
  writeHeaderCollapse(currentCollapse);
})();

document.addEventListener(
  "wheel",
  (e) => {
    if (e.target === document.body || e.target === document.documentElement) {
      window.scrollBy({ top: e.deltaY });
    }
  },
  { passive: true },
);
