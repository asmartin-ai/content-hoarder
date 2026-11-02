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

  let relayCloseMode = false;

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

  function suppressNextClick() {
    const swallow = (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
    };

    window.addEventListener("click", swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener("click", swallow, true), 350);
  }

  el.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && !opts.mouse) return;

    if (e.pointerType === "mouse" && e.button !== 0) return;

    if (e.target.closest("input, select, textarea, video")) return;

    if (e.clientX < EDGE || e.clientX > window.innerWidth - EDGE) return;

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
      fg.style.transition = "none";
    }

    if (relayCloseMode) {
      clearTimeout(lpTimer);

      return;
    }

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

        if (horizontal || vertical) return;

        if (target.closest("[data-media]")) return;
        suppressNextClick();

        if (HAPTICS && navigator.vibrate) navigator.vibrate(15);
        opts.onLongPress(el);
        requestAnimationFrame(() => requestAnimationFrame(restoreAnchor));
      }, opts.longPressMs || 450);
    }
  });

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
    el.classList.toggle("swipe-arch", dx > 40 && (!opts.onRightLong || dx <= COMMIT2));
    el.classList.toggle("swipe-done", dx < -40 && (!opts.onLeftLong || dx >= -COMMIT2));
    el.classList.toggle("swipe-snooze", opts.onLeftLong && dx < -COMMIT2);

    if (opts.onDrag) opts.onDrag(dx, 0);

    const a =
      Math.abs(dx) >= COMMIT &&
      (dx > 0 ? !opts.onRightLong || dx <= COMMIT2 : !opts.onLeftLong || dx >= -COMMIT2);

    if (a !== armed) {
      armed = a;

      if (a && HAPTICS && navigator.vibrate) navigator.vibrate(12);
    }

    const s2 = opts.onRightLong && dx > COMMIT2;
    const s2left = opts.onLeftLong && dx < -COMMIT2;

    if (s2 !== stage2) {
      stage2 = s2;
      el.classList.toggle("swipe-keep", s2);

      if (s2 && HAPTICS && navigator.vibrate) navigator.vibrate(15);
    }

    if (s2left !== stage2left) {
      stage2left = s2left;

      if (s2left && HAPTICS && navigator.vibrate) navigator.vibrate(15);
    }
  }

  el.addEventListener("pointermove", (e) => {
    if (!dragging) return;

    const dx = e.clientX - startX,
      dy = e.clientY - startY;

    if (!decided) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      decided = true;
      clearTimeout(lpTimer);
      horizontal = Math.abs(dx) > Math.abs(dy);
      vertical = !horizontal;

      if (horizontal || (vertical && HAS_VERTICAL)) {
        try {
          el.setPointerCapture(e.pointerId);
        } catch {}
      }
    }

    if (vertical && !HAS_VERTICAL) return;

    if (e.cancelable) e.preventDefault();

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

    if (relayCloseMode) {
      relayCloseMode = false;

      if (decided || Math.abs(dx) > 8) suppressNextClick();

      if (dx > 10 && opts.onRelayClose) {
        opts.onRelayClose(el);
      }

      reset();

      return;
    }

    if (horizontal || (vertical && HAS_VERTICAL)) suppressNextClick();

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
