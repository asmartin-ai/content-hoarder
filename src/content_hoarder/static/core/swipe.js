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
   Usage: attachSwipe(el, { onRight, onRightLong, onLeft, edge, commit, commit2, mouse }). */

export function attachSwipe(el, opts) {
  opts = opts || {};
  const EDGE = opts.edge || 30, COMMIT = opts.commit || 80;
  const COMMIT2 = opts.onRightLong ? (opts.commit2 || 170) : Infinity;
  const fg = el.querySelector(".item-fg") || el;
  let startX = 0, startY = 0, dragging = false, decided = false, horizontal = false;
  let stage2 = false, armed = false, lpTimer = null;

  fg.style.touchAction = "pan-y";

  function reset() {
    fg.style.transition = "transform .25s cubic-bezier(.25,.9,.35,1.15)";  // soft spring settle
    fg.style.transform = "";
    el.classList.remove("swipe-arch", "swipe-done", "swipe-keep");
    stage2 = false;
    armed = false;
  }

  // After a horizontal swipe the browser still synthesizes a click on the original
  // target (title <a>, thumbnail <button>, …). Swallow that one click so an
  // archive-swipe starting on a link doesn't ALSO navigate / open the reader.
  function suppressNextClick() {
    const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
    window.addEventListener("click", swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener("click", swallow, true), 350);
  }

  el.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && !opts.mouse) return;   // touch-only by default
    if (e.pointerType === "mouse" && e.button !== 0) return;
    // Only text-entry controls keep their native horizontal caret/selection; links and
    // buttons no longer block the swipe — taps on them still work because we don't claim
    // the gesture until it's decided horizontal (and clicks are delegated on itemsEl).
    if (e.target.closest("input, select, textarea")) return;
    if (e.clientX < EDGE || e.clientX > window.innerWidth - EDGE) return;  // back-gesture zone
    dragging = true; decided = false; horizontal = false;
    startX = e.clientX; startY = e.clientY;
    fg.style.transition = "none";
    if (opts.onLongPress) {                    // press-and-hold (no drag) → open the row action menu
      clearTimeout(lpTimer);
      lpTimer = setTimeout(() => {
        lpTimer = null;
        if (horizontal) return;                // a decided swipe already cleared this; guard anyway
        suppressNextClick();                   // swallow the click that follows finger-up
        if (navigator.vibrate) navigator.vibrate(15);
        opts.onLongPress(el);
      }, opts.longPressMs || 450);
    }
  });

  el.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX, dy = e.clientY - startY;
    if (!decided) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      decided = true;
      clearTimeout(lpTimer);                 // a real drag cancels the long-press
      horizontal = Math.abs(dx) > Math.abs(dy);
      if (horizontal) { try { el.setPointerCapture(e.pointerId); } catch (_e) {} }
    }
    if (!horizontal) return;                 // vertical → let the list scroll
    if (e.cancelable) e.preventDefault();    // claim the gesture: block link activation / native drag
    fg.style.transform = "translateX(" + dx + "px)";
    el.classList.toggle("swipe-arch", dx > 40 && dx <= COMMIT2);  // right → archive
    el.classList.toggle("swipe-done", dx < -40);                  // left → done
    // Detent when an action crosses its COMMIT threshold (release-to-fire): one firm pulse per arm,
    // for done (left) AND archive (right, below the Keep stage) — was Keep-only (user 2026-06-22).
    const a = Math.abs(dx) >= COMMIT && dx <= COMMIT2;
    if (a !== armed) {
      armed = a;
      if (a && navigator.vibrate) navigator.vibrate(12);  // done/archive "armed" detent (firm tick)
    }
    const s2 = dx > COMMIT2;
    if (s2 !== stage2) {
      stage2 = s2;
      el.classList.toggle("swipe-keep", s2);
      if (s2 && navigator.vibrate) navigator.vibrate(15);  // Keep stage detent — firmer (more travel/commitment)
    }
  });

  function end(e) {
    if (!dragging) return;
    dragging = false;
    clearTimeout(lpTimer);
    const dx = e.clientX - startX;
    if (horizontal) suppressNextClick();     // any decided h-swipe: don't let the trailing click fire
    if (horizontal && Math.abs(dx) >= COMMIT) {
      const dir = dx > 0 ? 1 : -1;
      fg.style.transition = "transform .2s ease-out";
      fg.style.transform = "translateX(" + (dir * 130) + "%)";
      const cb = dir > 0 ? (dx > COMMIT2 ? opts.onRightLong : opts.onRight) : opts.onLeft;
      setTimeout(() => { if (cb) cb(); }, 160);
    } else {
      reset();
    }
  }
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", () => { dragging = false; clearTimeout(lpTimer); reset(); });
}
