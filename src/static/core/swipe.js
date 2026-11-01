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
   - optional TWO-STAGE swipe (Epic 20, locked 2026-06-11): pass
     {commit2, onRightLong} and/or {commit2, onLeftLong}. Right-long toggles
     .swipe-keep (the page's underlay flips to the Keep treatment); left-long
     toggles .swipe-snooze. Crossing a second stage emits one haptic pulse unless
     {haptics:false} is passed.
   - optional vertical callbacks for focus-card flows: pass {onUp, onDown}. When
     absent, vertical movement is left to native scrolling (browse behavior).
   - frame-batched: pointer events only record the finger; the transform, classes and detents are
     applied once per animation frame (touch screens sample at 120–240 Hz, faster than they paint),
     so a drag costs one style recalc of the moving element per frame at any refresh rate
   - optional card mode (focus rounds): {tilt} degrees of rotation per px of horizontal drag (a card
     in the hand); {onDrag(dx, dy)} once per frame while dragging and (0, 0) on settle, for
     compositor-only feedback the caller owns (stamp/peek opacity); {fling} px/ms — a flick faster
     than this commits from a short drag and the fly-out keeps the flick's speed; {commitDelay} ms
     between commit and the callback (default 160; 0 = decide at once, the card flies on regardless).
     With {tilt}, a cancelled drag springs back with a little overshoot.
   Usage: attachSwipe(el, { onRight, onRightLong, onLeft, onLeftLong, onUp, onDown, edge, commit, commit2, mouse, haptics, tilt, onDrag, fling, commitDelay }). */

export function attachSwipe(el, opts) {
  opts = opts || {};

  const EDGE = opts.edge || 30,
    COMMIT = opts.commit || 80;

  const COMMIT2 = opts.onRightLong || opts.onLeftLong ? opts.commit2 || 170 : Infinity;

  const HAS_VERTICAL = !!(opts.onUp || opts.onDown);
  const HAPTICS = opts.haptics !== false;
  const TILT = opts.tilt || 0;
  const FLING = opts.fling || Infinity;
  const COMMIT_DELAY = opts.commitDelay ?? 160;

  const SETTLE = TILT
    ? "transform .42s cubic-bezier(.18, 1.35, .4, 1)"
    : "transform .2s var(--ease)";

  const fg = el.querySelector(".item-fg") || el;

  let startX = 0,
    startY = 0,
    dragging = false,
    decided = false,
    horizontal = false,
    vertical = false;

  let stage2 = false,
    stage2left = false,
    armed = false,
    lpTimer = null;

  let relayCloseMode = false; // when the relay strip is open, a swipe closes it (no triage)

  // latest finger position + smoothed velocity (px/ms); painted by the next animation frame
  let curX = 0,
    curY = 0,
    lastX = 0,
    lastY = 0,
    lastT = 0,
    vx = 0,
    vy = 0,
    frame = 0;

  fg.style.touchAction = HAS_VERTICAL ? "none" : "pan-y";

  function reset() {
    cancelAnimationFrame(frame);
    frame = 0;
    fg.style.transition = SETTLE;
    fg.style.transform = "";
    el.classList.remove(
      "swipe-arch",
      "swipe-done",
      "swipe-keep",
      "swipe-snooze",
      "swipe-open",
      "swipe-skip",
    );
    fg.style.opacity = "";

    if (opts.onDrag) opts.onDrag(0, 0);

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
    vertical = false;
    startX = e.clientX;
    startY = e.clientY;
    lastX = e.clientX;
    lastY = e.clientY;
    lastT = e.timeStamp;
    vx = 0;
    vy = 0;

    if (!relayCloseMode) {
      fg.style.transition = "none"; // only disable transition when we're actually dragging the fg
    }

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
      const anchorTop = el.getBoundingClientRect().top;

      const restoreAnchor = () => {
        if (!el.isConnected) return;
        const delta = el.getBoundingClientRect().top - anchorTop;

        if (Math.abs(delta) > 1) window.scrollTo(window.scrollX, window.scrollY + delta);
      };

      lpTimer = setTimeout(() => {
        lpTimer = null;

        if (horizontal || vertical) return; // a decided swipe already cleared this; guard anyway

        if (target.closest("[data-media]")) return; // media has its own hold-to-preview
        suppressNextClick(); // swallow the click that follows finger-up

        if (HAPTICS && navigator.vibrate) navigator.vibrate(15);
        opts.onLongPress(el);
        requestAnimationFrame(() => requestAnimationFrame(restoreAnchor));
      }, opts.longPressMs || 450);
    }
  });

  /* One frame's worth of drag: transform, direction classes, detents, caller feedback. */
  function paint() {
    frame = 0;

    if (!dragging) return;

    const dx = curX - startX,
      dy = curY - startY;

    if (vertical && HAS_VERTICAL) {
      fg.style.transform = "translateY(" + dy + "px) scale(.98)";
      fg.style.opacity = String(Math.max(0.5, 1 - Math.abs(dy) / 360));
      el.classList.toggle("swipe-open", dy < -40);
      el.classList.toggle("swipe-skip", dy > 40);

      if (opts.onDrag) opts.onDrag(0, dy);

      return;
    }

    fg.style.transform =
      "translateX(" + dx + "px)" + (TILT ? " rotate(" + (dx * TILT).toFixed(2) + "deg)" : "");
    el.classList.toggle("swipe-arch", dx > 40 && (!opts.onRightLong || dx <= COMMIT2)); // right → archive
    el.classList.toggle("swipe-done", dx < -40 && (!opts.onLeftLong || dx >= -COMMIT2)); // left → done
    el.classList.toggle("swipe-snooze", opts.onLeftLong && dx < -COMMIT2); // long-left → snooze

    if (opts.onDrag) opts.onDrag(dx, 0);

    // Detent when an action crosses its COMMIT threshold (release-to-fire): one firm pulse per arm,
    // for done (left) AND archive (right, below the Keep stage) — was Keep-only (user 2026-06-22).
    const a =
      Math.abs(dx) >= COMMIT &&
      (dx > 0 ? !opts.onRightLong || dx <= COMMIT2 : !opts.onLeftLong || dx >= -COMMIT2);

    if (a !== armed) {
      armed = a;

      if (a && HAPTICS && navigator.vibrate) navigator.vibrate(12); // done/archive "armed" detent (firm tick)
    }

    const s2 = opts.onRightLong && dx > COMMIT2;
    const s2left = opts.onLeftLong && dx < -COMMIT2;

    if (s2 !== stage2) {
      stage2 = s2;
      el.classList.toggle("swipe-keep", s2);

      if (s2 && HAPTICS && navigator.vibrate) navigator.vibrate(15); // Keep stage detent
    }

    // separate detent for the long-left (Snooze) stage
    if (s2left !== stage2left) {
      stage2left = s2left;

      if (s2left && HAPTICS && navigator.vibrate) navigator.vibrate(15); // Snooze stage detent
    }
  }

  el.addEventListener("pointermove", (e) => {
    if (!dragging) return;

    const dx = e.clientX - startX,
      dy = e.clientY - startY;

    if (!decided) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      decided = true;
      clearTimeout(lpTimer); // a real drag cancels the long-press
      horizontal = Math.abs(dx) > Math.abs(dy);
      vertical = !horizontal;

      if (horizontal || (vertical && HAS_VERTICAL)) {
        try {
          el.setPointerCapture(e.pointerId);
        } catch {}
      }
    }

    if (vertical && !HAS_VERTICAL) return; // vertical without callbacks → let the list scroll

    // Claim the gesture (block link activation / native drag / scroll) — synchronously, per event.
    if (e.cancelable) e.preventDefault();

    // In relay-close mode, don't translate (no blank space to the right on
    // leftward swipes); we just track the direction for the close gesture.
    if (relayCloseMode) return;

    const dt = e.timeStamp - lastT;

    if (dt > 0) {
      vx = vx * 0.4 + ((e.clientX - lastX) / dt) * 0.6;
      vy = vy * 0.4 + ((e.clientY - lastY) / dt) * 0.6;
    }

    lastX = curX = e.clientX;
    lastY = curY = e.clientY;
    lastT = e.timeStamp;

    if (!frame) frame = requestAnimationFrame(paint);
  });

  /* Fly the card off, as fast as the finger was going (never slower than a calm exit). */
  function flyOut(transform, remaining, speed) {
    const ms = Math.round(Math.min(240, Math.max(110, remaining / Math.max(speed, 1.5))));

    fg.style.transition = "transform " + ms + "ms cubic-bezier(.2,.7,.3,1), opacity " + ms + "ms";
    fg.style.transform = transform;
  }

  function end(e) {
    if (!dragging) return;
    dragging = false;
    clearTimeout(lpTimer);
    cancelAnimationFrame(frame);
    frame = 0;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

    // relay-close mode: a rightward swipe ("swipe back") closes the strip;
    // leftward does nothing. No triage fires while the relay is open.
    if (relayCloseMode) {
      relayCloseMode = false;

      // Any deliberate rightward motion closes the relay -- bypass the horizontal decision.
      // (Triage swipes are disabled in relayCloseMode regardless.)
      if (decided || Math.abs(dx) > 8) suppressNextClick();

      if (dx > 10 && opts.onRelayClose) {
        opts.onRelayClose(el);
      }

      reset(); // ALWAYS reset, even if we didn't close: clears inline transition/transform

      return;
    }

    if (horizontal || (vertical && HAS_VERTICAL)) suppressNextClick(); // owned gestures: swallow trailing click

    const flungY = Math.abs(vy) > FLING && Math.abs(dy) > 24 && Math.sign(vy) === Math.sign(dy);
    const flungX = Math.abs(vx) > FLING && Math.abs(dx) > 24 && Math.sign(vx) === Math.sign(dx);

    if (vertical && HAS_VERTICAL && (Math.abs(dy) >= COMMIT || flungY)) {
      const dir = dy > 0 ? 1 : -1;

      flyOut(
        dir > 0 ? "translateY(16%) scale(.96)" : "translateY(-16%) scale(.98)",
        200,
        Math.abs(vy),
      );
      fg.style.opacity = dir > 0 ? "0" : "1";
      const cb = dir > 0 ? opts.onDown : opts.onUp;

      setTimeout(
        () => {
          if (cb) cb();
        },
        Math.min(COMMIT_DELAY, 120),
      );
    } else if (horizontal && (Math.abs(dx) >= COMMIT || flungX)) {
      const dir = dx > 0 ? 1 : -1;

      flyOut(
        "translateX(" + dir * 130 + "%)" + (TILT ? " rotate(" + dir * TILT * 240 + "deg)" : ""),
        window.innerWidth * 1.3 - Math.abs(dx),
        Math.abs(vx),
      );

      const cb =
        dir > 0
          ? opts.onRightLong && dx > COMMIT2
            ? opts.onRightLong
            : opts.onRight
          : opts.onLeftLong && dx < -COMMIT2
            ? opts.onLeftLong
            : opts.onLeft;

      if (COMMIT_DELAY) {
        setTimeout(() => {
          if (cb) cb();
        }, COMMIT_DELAY);
      } else if (cb) cb();
    } else {
      reset();
    }
  }

  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", () => {
    dragging = false;
    relayCloseMode = false;
    vertical = false;
    clearTimeout(lpTimer);
    reset();
  });
}
