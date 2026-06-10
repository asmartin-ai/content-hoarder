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
   Usage: attachSwipe(el, { onRight, onLeft, edge, commit, mouse }). */

export function attachSwipe(el, opts) {
  opts = opts || {};
  const EDGE = opts.edge || 30, COMMIT = opts.commit || 80;
  const fg = el.querySelector(".item-fg") || el;
  let startX = 0, startY = 0, dragging = false, decided = false, horizontal = false;

  fg.style.touchAction = "pan-y";

  function reset() {
    fg.style.transition = "transform .25s cubic-bezier(.25,.9,.35,1.15)";  // soft spring settle
    fg.style.transform = "";
    el.classList.remove("swipe-arch", "swipe-done");
  }

  el.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && !opts.mouse) return;   // touch-only by default
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (e.target.closest("a, button, input, select, textarea")) return;
    if (e.clientX < EDGE || e.clientX > window.innerWidth - EDGE) return;  // back-gesture zone
    dragging = true; decided = false; horizontal = false;
    startX = e.clientX; startY = e.clientY;
    fg.style.transition = "none";
  });

  el.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX, dy = e.clientY - startY;
    if (!decided) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      decided = true;
      horizontal = Math.abs(dx) > Math.abs(dy);
      if (horizontal) { try { el.setPointerCapture(e.pointerId); } catch (_e) {} }
    }
    if (!horizontal) return;                 // vertical → let the list scroll
    fg.style.transform = "translateX(" + dx + "px)";
    el.classList.toggle("swipe-arch", dx > 40);   // drag right → archive (left-edge reveal)
    el.classList.toggle("swipe-done", dx < -40);  // drag left → done (right-edge reveal)
  });

  function end(e) {
    if (!dragging) return;
    dragging = false;
    const dx = e.clientX - startX;
    if (horizontal && Math.abs(dx) >= COMMIT) {
      const dir = dx > 0 ? 1 : -1;
      fg.style.transition = "transform .2s ease-out";
      fg.style.transform = "translateX(" + (dir * 130) + "%)";
      const cb = dir > 0 ? opts.onRight : opts.onLeft;
      setTimeout(() => { if (cb) cb(); }, 160);
    } else {
      reset();
    }
  }
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", () => { dragging = false; reset(); });
}
