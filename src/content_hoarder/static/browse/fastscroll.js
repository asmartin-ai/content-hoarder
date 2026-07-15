/* browse/fastscroll.js — Nova Launcher–style fast-scroll bar (#46).
   Spec: docs/specs/mobile-scrollbar.md (reworked 2026-07-13 from hidden-pill
   to an always-visible track + proportional handle).

   Mental model (Nova Launcher / Android contacts scrollbar):
   - A thin track sits at the right edge, always visible while the list is long.
   - The handle height = viewport / scrollHeight (small list = tall handle;
     huge list = tiny handle). Its top = scrollTop / maxScroll.
   - Dragging the HANDLE scrubs (pointer down on the handle = grab; moves = scrub).
   - Dragging the track pages or jumps to that position.
   - The list area itself is untouched — normal native scroll, no capture,
     no preventDefault on #items.

   Browse scrolls the document (window), not #items. Desktop (fine pointer +
   hover) is a no-op (native scrollbar stays). */

// Widths live in browse.css: .fastscroll-bar is the 22px touch target,
// .fastscroll-track/.fastscroll-handle the visuals.
const MIN_HANDLE_H = 24; // never smaller than this even for enormous lists
const FADE_IDLE_MS = 900; // hide shortly after scroll stops (Nova hides too)

function isDesktopPointer() {
  try {
    return (
      window.matchMedia("(hover: hover) and (pointer: fine)").matches &&
      !(navigator.maxTouchPoints > 0)
    );
  } catch {
    return false;
  }
}

function scrollMetrics() {
  const se = document.scrollingElement || document.documentElement;
  const viewH = window.innerHeight || se.clientHeight || 1;
  const max = Math.max(0, se.scrollHeight - viewH);
  return { se, viewH, max, scrollHeight: se.scrollHeight };
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Install the fast-scroll bar.
 * @param {HTMLElement | null} _listEl  (unused; kept for call-site compat)
 * @returns {() => void} teardown
 */
export function installFastScroll(_listEl) {
  if (isDesktopPointer()) return () => {};

  const bar = document.createElement("div");
  bar.className = "fastscroll-bar";
  bar.setAttribute("aria-hidden", "true");
  const track = document.createElement("div");
  track.className = "fastscroll-track";
  const handle = document.createElement("div");
  handle.className = "fastscroll-handle";
  track.appendChild(handle);
  bar.appendChild(track);
  document.body.appendChild(bar);

  let dragging = false;
  let dragOffsetY = 0; // grab offset within the handle
  let moveRaf = 0;
  let pendingY = 0;
  let idleTimer = 0;
  let activePointerId = null;
  let lastMax = -1;

  function metrics() {
    const { se, viewH, max, scrollHeight } = scrollMetrics();
    const barH = window.innerHeight || 1;
    // Track covers the safe vertical area; reserve space for the top bar + dock.
    const barStyle = getComputedStyle(bar);
    const trackTop =
      parseFloat(barStyle.getPropertyValue("--fastscroll-track-top")) || 0;
    const trackBottom =
      parseFloat(barStyle.getPropertyValue("--fastscroll-track-bottom")) || 0;
    const trackH = Math.max(40, barH - trackTop - trackBottom);
    const handleH =
      max <= 0
        ? trackH
        : clamp((viewH / scrollHeight) * trackH, MIN_HANDLE_H, trackH);
    const handleMaxTop = trackH - handleH;
    const scrollTop = se.scrollTop || 0;
    const handleTop = max <= 0 ? 0 : (scrollTop / max) * handleMaxTop;
    return { se, viewH, max, scrollHeight, trackTop, trackH, handleH, handleMaxTop, handleTop };
  }

  function layout() {
    const mt = metrics();
    if (mt.max <= 0) {
      bar.style.display = "none";
      lastMax = 0;
      return;
    }
    bar.style.display = "";
    if (mt.max !== lastMax) lastMax = mt.max;
    handle.style.height = `${mt.handleH}px`;
    handle.style.transform = `translateY(${mt.handleTop}px)`;
  }

  function scrubToTrackY(clientY) {
    const mt = metrics();
    if (mt.max <= 0) return;
    const rel = clientY - mt.trackTop; // y within the track
    const targetTop = clamp(rel - dragOffsetY, 0, mt.handleMaxTop);
    const ratio = mt.handleMaxTop <= 0 ? 0 : targetTop / mt.handleMaxTop;
    mt.se.scrollTop = ratio * mt.max;
    handle.style.transform = `translateY(${targetTop}px)`;
  }

  function showActive() {
    clearTimeout(idleTimer);
    bar.classList.add("active");
  }

  function scheduleIdleHide() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      bar.classList.remove("active");
    }, FADE_IDLE_MS);
  }

  // --- handle / track dragging (pointer events on the bar only) ---
  function onPointerDown(e) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const mt = metrics();
    if (mt.max <= 0) return;
    const rel = e.clientY - mt.trackTop;
    const handleRectTop = mt.trackTop + mt.handleTop;
    // Grab the handle if the press lands on it; otherwise jump the handle
    // center to the press (track tap → jump, Nova-style).
    if (
      e.clientY >= handleRectTop &&
      e.clientY <= handleRectTop + mt.handleH
    ) {
      dragOffsetY = rel - mt.handleTop;
    } else {
      dragOffsetY = mt.handleH / 2;
    }
    dragging = true;
    activePointerId = e.pointerId;
    try {
      bar.setPointerCapture?.(e.pointerId);
    } catch {
      /* pointer may already be inactive (fast tap) — scrub still works */
    }
    showActive();
    pendingY = e.clientY;
    scrubToTrackY(pendingY);
    e.preventDefault();
  }

  function onPointerMove(e) {
    if (!dragging) return;
    if (activePointerId != null && e.pointerId !== activePointerId) return;
    pendingY = e.clientY;
    if (moveRaf) return;
    moveRaf = requestAnimationFrame(() => {
      moveRaf = 0;
      if (!dragging) return;
      scrubToTrackY(pendingY);
    });
  }

  function endDrag(e) {
    if (!dragging) return;
    if (e && activePointerId != null && e.pointerId !== activePointerId) return;
    dragging = false;
    activePointerId = null;
    if (moveRaf) {
      cancelAnimationFrame(moveRaf);
      moveRaf = 0;
    }
    try {
      if (e?.pointerId != null) bar.releasePointerCapture?.(e.pointerId);
    } catch {
      /* ignore */
    }
    scheduleIdleHide();
  }

  // --- keep the handle in sync with native scroll ---
  function onScroll() {
    if (dragging) return; // we drive the handle while scrubbing
    const mt = metrics();
    if (mt.max <= 0) {
      layout();
      return;
    }
    const targetTop = mt.handleMaxTop <= 0 ? 0 : (mt.se.scrollTop / mt.max) * mt.handleMaxTop;
    handle.style.transform = `translateY(${targetTop}px)`;
    showActive();
    scheduleIdleHide();
  }

  bar.addEventListener("pointerdown", onPointerDown, { passive: false });
  bar.addEventListener("pointermove", onPointerMove, { passive: false });
  bar.addEventListener("pointerup", endDrag, { passive: true });
  bar.addEventListener("pointercancel", endDrag, { passive: true });
  window.addEventListener("scroll", onScroll, { passive: true });
  const onResize = () => layout();
  window.addEventListener("resize", onResize, { passive: true });

  // Initial layout + observation for dynamic content height changes.
  // Coalesce mutation bursts (list hydration) into one layout per frame —
  // layout() forces reflow (scrollHeight + getComputedStyle).
  layout();
  let layoutRaf = 0;
  const mo = new MutationObserver(() => {
    if (layoutRaf) return;
    layoutRaf = requestAnimationFrame(() => {
      layoutRaf = 0;
      layout();
    });
  });
  mo.observe(document.body, { childList: true, subtree: true, attributes: false });

  return () => {
    clearTimeout(idleTimer);
    if (moveRaf) cancelAnimationFrame(moveRaf);
    if (layoutRaf) cancelAnimationFrame(layoutRaf);
    bar.removeEventListener("pointerdown", onPointerDown);
    bar.removeEventListener("pointermove", onPointerMove);
    bar.removeEventListener("pointerup", endDrag);
    bar.removeEventListener("pointercancel", endDrag);
    window.removeEventListener("scroll", onScroll);
    window.removeEventListener("resize", onResize);
    mo.disconnect();
    bar.remove();
  };
}
