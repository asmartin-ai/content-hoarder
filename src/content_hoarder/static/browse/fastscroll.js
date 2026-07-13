/* browse/fastscroll.js — Nova-style right-edge scrub handle (#46).
   Spec: docs/specs/mobile-scrollbar.md

   Browse scrolls the document (window), not #items itself. Hit-test still
   starts on the list element so we don't steal chrome gestures; scroll
   mapping uses document.scrollingElement. Desktop (fine pointer + hover)
   is a no-op. */

const EDGE_PX = 24;
const HANDLE_H = 36;
const FADE_MS = 300;

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
 * Install the fast-scroll handle.
 * @param {HTMLElement | null} listEl  browse list (#items); hit-test surface
 * @returns {() => void} teardown
 */
export function installFastScroll(listEl) {
  if (!listEl || isDesktopPointer()) return () => {};

  let handle = null;
  let dragging = false;
  let fadeTimer = 0;
  let moveRaf = 0;
  let pendingY = 0;
  let activePointerId = null;

  function ensureHandle() {
    if (handle) return handle;
    handle = document.createElement("div");
    handle.className = "fastscroll-handle";
    handle.setAttribute("aria-hidden", "true");
    document.body.appendChild(handle);
    return handle;
  }

  function setHandleY(clientY) {
    const h = ensureHandle();
    const y = clamp(clientY - HANDLE_H / 2, 0, (window.innerHeight || 0) - HANDLE_H);
    h.style.setProperty("--fastscroll-y", `${y}px`);
  }

  function scrubTo(clientY) {
    const { se, viewH, max } = scrollMetrics();
    if (max <= 0) return;
    const ratio = clamp(clientY / viewH, 0, 1);
    se.scrollTop = ratio * max;
    setHandleY(clientY);
  }

  function showActive() {
    clearTimeout(fadeTimer);
    ensureHandle().classList.add("active");
  }

  function scheduleHide() {
    clearTimeout(fadeTimer);
    fadeTimer = setTimeout(() => {
      if (handle) handle.classList.remove("active");
    }, FADE_MS);
  }

  function onPointerDown(e) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    // Only the right-edge strip; leave the rest of the list to swipe/relay.
    if (e.clientX < window.innerWidth - EDGE_PX) return;
    // Ignore when the list isn't under the finger (e.g. empty overlay).
    if (!listEl.getBoundingClientRect) return;

    dragging = true;
    activePointerId = e.pointerId;
    pendingY = e.clientY;
    showActive();
    scrubTo(pendingY);
    try {
      listEl.setPointerCapture?.(e.pointerId);
    } catch {
      /* ignore */
    }
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
      scrubTo(pendingY);
    });
  }

  function endDrag(e) {
    if (!dragging) return;
    if (
      e &&
      activePointerId != null &&
      e.pointerId != null &&
      e.pointerId !== activePointerId
    ) {
      return;
    }
    dragging = false;
    activePointerId = null;
    if (moveRaf) {
      cancelAnimationFrame(moveRaf);
      moveRaf = 0;
    }
    try {
      if (e?.pointerId != null) listEl.releasePointerCapture?.(e.pointerId);
    } catch {
      /* ignore */
    }
    scheduleHide();
  }

  listEl.addEventListener("pointerdown", onPointerDown, { passive: false });
  window.addEventListener("pointermove", onPointerMove, { passive: true });
  window.addEventListener("pointerup", endDrag, { passive: true });
  window.addEventListener("pointercancel", endDrag, { passive: true });

  return () => {
    listEl.removeEventListener("pointerdown", onPointerDown);
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", endDrag);
    window.removeEventListener("pointercancel", endDrag);
    clearTimeout(fadeTimer);
    if (moveRaf) cancelAnimationFrame(moveRaf);
    handle?.remove();
    handle = null;
  };
}
