/* Shared horizontal-swipe helper (pointer events).
   - Android-edge-safe: ignores a pointerdown within `edge` px of a screen edge.
   - Distinguishes horizontal swipe from vertical scroll (so lists still scroll).
   - Slides an inner `.item-fg` (falls back to the element itself) so a fixed
     `.item-bg` with keep/archive icons is revealed underneath, Gmail-style.
   - Calls opts.onRight / opts.onLeft when dragged past `commit` px.
   Usage: window.attachSwipe(el, { onRight: fn, onLeft: fn }). */
(function () {
  "use strict";
  window.attachSwipe = function (el, opts) {
    opts = opts || {};
    var EDGE = opts.edge || 30, COMMIT = opts.commit || 80;
    var fg = el.querySelector(".item-fg") || el;
    var startX = 0, startY = 0, dragging = false, decided = false, horizontal = false;

    function reset() {
      fg.style.transform = "";
      el.classList.remove("swipe-keep", "swipe-arch");
    }

    el.addEventListener("pointerdown", function (e) {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      if (e.target.closest("a, button, input, select, textarea")) return;
      if (e.clientX < EDGE || e.clientX > window.innerWidth - EDGE) return;  // back-gesture zone
      dragging = true; decided = false; horizontal = false;
      startX = e.clientX; startY = e.clientY;
      fg.style.transition = "none";
    });

    el.addEventListener("pointermove", function (e) {
      if (!dragging) return;
      var dx = e.clientX - startX, dy = e.clientY - startY;
      if (!decided) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        decided = true;
        horizontal = Math.abs(dx) > Math.abs(dy);
        if (horizontal) { try { el.setPointerCapture(e.pointerId); } catch (_e) {} }
      }
      if (!horizontal) return;                 // vertical → let the list scroll
      fg.style.transform = "translateX(" + dx + "px)";
      el.classList.toggle("swipe-keep", dx > 40);   // reveals the left (keep) icon
      el.classList.toggle("swipe-arch", dx < -40);  // reveals the right (archive) icon
    });

    function end(e) {
      if (!dragging) return;
      dragging = false;
      var dx = e.clientX - startX;
      fg.style.transition = "transform .2s ease-out";
      if (horizontal && Math.abs(dx) >= COMMIT) {
        var dir = dx > 0 ? 1 : -1;
        fg.style.transform = "translateX(" + (dir * 130) + "%)";
        var cb = dir > 0 ? opts.onRight : opts.onLeft;
        setTimeout(function () { if (cb) cb(); }, 160);
      } else {
        reset();
      }
    }
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", function () { dragging = false; reset(); });
  };
})();
