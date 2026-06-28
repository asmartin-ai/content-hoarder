/* core/swipe.js — ES-module port of static/swipe.js, extended for Epic 16:
   - touch-only by default (16:444 — desktop uses buttons/hover; pass
     {mouse:true} to allow pointer drags, e.g. for demos)
   - never causes horizontal page scroll: the drag is transform-only and the
     element gets touch-action pan-y (16:436)
   - springy settle: snap-back animates on a soft cubic-bezier (16:441)
   - Android-edge-safe: ignores pointerdown within `edge` px of a screen edge
     (system back-gesture zone)
   - distinguishes horizontal swipe from vertical scroll (lists still scroll)
   - slides an inner `.item-fg` (falls back to the element itself) revealing a
     fixed `.item-bg` underneath, Gmail/Sync-style
   - optional TWO-STAGE right swipe (Epic 20, locked 2026-06-11): pass
     {commit2, onRightLong} — crossing commit2 toggles .swipe-keep (the page's
     underlay flips to the Keep treatment) + one haptic pulse; releasing past it
     fires onRightLong instead of onRight. The extra travel is the deliberate
     friction on the one action that PRESERVES backlog (the hoarder tax).
   Usage: attachSwipe(el, { onRight, onRightLong, onLeft, onLeftLong, edge, commit, commit2, mouse }). */

export function attachSwipe(el, opts) {
  opts = opts || {};
  const EDGE = opts.edge || 30,
    COMMIT = opts.commit || 80;
  const COMMIT2 = opts.onRightLong ? opts.commit2 || 170 : Infinity;
  const fg = el.querySelector(".item-fg") || el;
  let startX = 0,
    startY = 0,
    dragging = false,
    decided = false,
    horizontal = false;
  let stage2 = false,
    stage2left = false,
    armed = false,
    lpTimer = null;
  let relayCloseMode = false; // when the relay strip is open, a swipe closes it (no triage)

  fg.style.touchAction = "pan-y";

  function reset() {
    fg.style.transition = "transform .25s cubic-bezier(.25,.9,.35,1.15)"; // soft spring settle
    fg.style.transform = "";
    el.classList.remove(
      "swipe-arch",
      "swipe-done",
      "swipe-keep",
      "swipe-snooze",
    );
    stage2 = false;
    stage2left = false;
    armed = false;
  }

  // After a horizontal swipe the browser still synthesizes a click on the original
  // target (title <a>, thumbnail <button>, …). Swallow that one click so an
  // archive-swipe starting on a link doesn't ALSO navigate / open the reader.
  function suppressNextClick() {
    const swallow = (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
    };
    window.addEventListener("click", swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener("click", swallow, true), 350);
  }

  el.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && !opts.mouse) return; // touch-only by default
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (e.target.closest("input, select, textarea")) return;
    if (e.clientX < EDGE || e.clientX > window.innerWidth - EDGE) return; // back-gesture zone

    // If the relay strip is open on this row, swipes CLOSE it instead of triaging —
    // the two states are mutually exclusive (user 2026-06-27).
    relayCloseMode = el.classList.contains("relay-open");

    dragging = true;
    decided = false;
    horizontal = false;
    startX = e.clientX;
    startY = e.clientY;
    fg.style.transition = "none";

    if (relayCloseMode) {
      // no long-press, no triage — a rightward release closes the relay
      clearTimeout(lpTimer);
      return;
    }
    // long-press opens the relay menu. T3 peek-flicker: do NOT let the lpTimer's
    // suppressNextClick() run when the press started on a [data-media] element -- media has
    // its own hold-to-preview (B4), and the 450ms suppressNextClick() would race the peek
    // release. The swipe itself still works from a media target (dragging is set above);
    // only the long-press click-suppression is skipped.
    if (opts.onLongPress) {
      clearTimeout(lpTimer);
      const target = e.target;
      lpTimer = setTimeout(() => {
        lpTimer = null;
        if (horizontal) return; // a decided swipe already cleared this; guard anyway
        if (target.closest("[data-media]")) return; // media has its own hold-to-preview
        suppressNextClick(); // swallow the click that follows finger-up
        if (navigator.vibrate) navigator.vibrate(15);
        opts.onLongPress(el);
      }, opts.longPressMs || 450);
    }
  });

  el.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX,
      dy = e.clientY - startY;
    if (!decided) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      decided = true;
      clearTimeout(lpTimer); // a real drag cancels the long-press
      horizontal = Math.abs(dx) > Math.abs(dy);
      if (horizontal) {
        try {
          el.setPointerCapture(e.pointerId);
        } catch (_e) {}
      }
    }
    if (!horizontal) return; // vertical → let the list scroll
    // In relay-close mode, don't translate (no blank space to the right on
    // leftward swipes); we just track the direction for the close gesture.
    if (relayCloseMode) return;
    if (e.cancelable) e.preventDefault(); // claim the gesture: block link activation / native drag
    fg.style.transform = "translateX(" + dx + "px)";
    el.classList.toggle("swipe-arch", dx > 40 && dx <= COMMIT2); // right → archive
    el.classList.toggle("swipe-done", dx < -40 && dx >= -COMMIT2); // left → done
    el.classList.toggle("swipe-snooze", opts.onLeftLong && dx < -COMMIT2); // long-left → snooze
    // Detent when an action crosses its COMMIT threshold (release-to-fire): one firm pulse per arm,
    // for done (left) AND archive (right, below the Keep stage) — was Keep-only (user 2026-06-22).
    const a = Math.abs(dx) >= COMMIT && dx <= COMMIT2;
    if (a !== armed) {
      armed = a;
      if (a && navigator.vibrate) navigator.vibrate(12); // done/archive "armed" detent (firm tick)
    }
    const s2 = dx > COMMIT2;
    const s2left = opts.onLeftLong && dx < -COMMIT2;
    if (s2 !== stage2) {
      stage2 = s2;
      el.classList.toggle("swipe-keep", s2);
      if (s2 && navigator.vibrate) navigator.vibrate(15); // Keep stage detent
    }
    // separate detent for the long-left (Snooze) stage
    if (s2left !== stage2left) {
      stage2left = s2left;
      if (s2left && navigator.vibrate) navigator.vibrate(15); // Snooze stage detent
    }
  });

  function end(e) {
    if (!dragging) return;
    dragging = false;
    clearTimeout(lpTimer);
    const dx = e.clientX - startX;
    // relay-close mode: a rightward swipe ("swipe back") closes the strip;
    // leftward does nothing. No triage fires while the relay is open.
    if (relayCloseMode) {
      relayCloseMode = false;
      if (horizontal && dx > 40 && opts.onRelayClose) {
        opts.onRelayClose(el);
      }
      return;
    }
    if (horizontal) suppressNextClick(); // any decided h-swipe: don't let the trailing click fire
    if (horizontal && Math.abs(dx) >= COMMIT) {
      const dir = dx > 0 ? 1 : -1;
      fg.style.transition = "transform .2s ease-out";
      fg.style.transform = "translateX(" + dir * 130 + "%)";
      const cb =
        dir > 0
          ? dx > COMMIT2
            ? opts.onRightLong
            : opts.onRight
          : opts.onLeftLong && dx < -COMMIT2
            ? opts.onLeftLong
            : opts.onLeft;
      setTimeout(() => {
        if (cb) cb();
      }, 160);
    } else {
      reset();
    }
  }
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", () => {
    dragging = false;
    relayCloseMode = false;
    clearTimeout(lpTimer);
    reset();
  });
}
