const MIN_HANDLE_H = 24;

const FADE_IDLE_MS = 900;

const SETTLE_MS = 250;

let scrubbing = false;

let settleTimer = 0;

export function isFastScrollScrubbing() {
  return scrubbing;
}

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
  let dragOffsetY = 0;
  let moveRaf = 0;
  let pendingY = 0;
  let idleTimer = 0;
  let activePointerId = null;
  let lastMax = -1;
  let dragMt = null;
  let layoutPending = false;
  let scrollRaf = 0;
  let pendingScrollTop = 0;

  function metrics() {
    const { se, viewH, max, scrollHeight } = scrollMetrics();
    const barH = window.innerHeight || 1;
    const barStyle = getComputedStyle(bar);

    const trackTop = parseFloat(barStyle.getPropertyValue("--fastscroll-track-top")) || 0;

    const trackBottom = parseFloat(barStyle.getPropertyValue("--fastscroll-track-bottom")) || 0;

    const trackH = Math.max(40, barH - trackTop - trackBottom);

    const handleH =
      max <= 0 ? trackH : clamp((viewH / scrollHeight) * trackH, MIN_HANDLE_H, trackH);

    const handleMaxTop = trackH - handleH;
    const scrollTop = se.scrollTop || 0;
    const handleTop = max <= 0 ? 0 : (scrollTop / max) * handleMaxTop;

    return { se, viewH, max, scrollHeight, trackTop, trackH, handleH, handleMaxTop, handleTop };
  }

  function layout() {
    if (dragging) {
      layoutPending = true;

      return;
    }

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
    const mt = dragMt || metrics();

    if (mt.max <= 0) return;
    const rel = clientY - mt.trackTop;
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

  function onPointerDown(e) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const mt = metrics();

    if (mt.max <= 0) return;
    const rel = e.clientY - mt.trackTop;
    const handleRectTop = mt.trackTop + mt.handleTop;

    if (e.clientY >= handleRectTop && e.clientY <= handleRectTop + mt.handleH) {
      dragOffsetY = rel - mt.handleTop;
    } else {
      dragOffsetY = mt.handleH / 2;
    }

    dragging = true;
    dragMt = mt;
    bar.classList.add("dragging");
    clearTimeout(settleTimer);
    scrubbing = true;
    activePointerId = e.pointerId;

    try {
      bar.setPointerCapture?.(e.pointerId);
    } catch {}

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
    dragMt = null;
    bar.classList.remove("dragging");

    if (layoutPending) {
      layoutPending = false;
      layout();
    }

    activePointerId = null;

    if (moveRaf) {
      cancelAnimationFrame(moveRaf);
      moveRaf = 0;
    }

    try {
      if (e?.pointerId != null) bar.releasePointerCapture?.(e.pointerId);
    } catch {}

    scheduleIdleHide();
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      scrubbing = false;
      window.dispatchEvent(new Event("fastscroll:settle"));
    }, SETTLE_MS);
  }

  function onScroll() {
    if (dragging) return;
    const mt = metrics();

    if (mt.max <= 0) {
      layout();

      return;
    }

    pendingScrollTop = mt.handleMaxTop <= 0 ? 0 : (mt.se.scrollTop / mt.max) * mt.handleMaxTop;
    showActive();
    scheduleIdleHide();

    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0;

      if (dragging) return;
      handle.style.transform = `translateY(${pendingScrollTop}px)`;
    });
  }

  bar.addEventListener("pointerdown", onPointerDown, { passive: false });
  bar.addEventListener("pointermove", onPointerMove, { passive: false });
  bar.addEventListener("pointerup", endDrag, { passive: true });
  bar.addEventListener("pointercancel", endDrag, { passive: true });
  window.addEventListener("scroll", onScroll, { passive: true });
  const onResize = () => layout();
  window.addEventListener("resize", onResize, { passive: true });

  layout();
  let layoutRaf = 0;

  function scheduleLayout() {
    if (layoutRaf) return;
    layoutRaf = requestAnimationFrame(() => {
      layoutRaf = 0;
      layout();
    });
  }

  const mo = new MutationObserver(() => scheduleLayout());
  mo.observe(document.body, { childList: true, subtree: true, attributes: false });
  let ro = null;

  if (typeof ResizeObserver !== "undefined") {
    ro = new ResizeObserver(() => scheduleLayout());
    ro.observe(document.body);
  }

  return () => {
    clearTimeout(idleTimer);
    clearTimeout(settleTimer);
    scrubbing = false;

    if (moveRaf) cancelAnimationFrame(moveRaf);

    if (layoutRaf) cancelAnimationFrame(layoutRaf);

    if (scrollRaf) cancelAnimationFrame(scrollRaf);
    bar.removeEventListener("pointerdown", onPointerDown);
    bar.removeEventListener("pointermove", onPointerMove);
    bar.removeEventListener("pointerup", endDrag);
    bar.removeEventListener("pointercancel", endDrag);
    window.removeEventListener("scroll", onScroll);
    window.removeEventListener("resize", onResize);
    mo.disconnect();

    if (ro) ro.disconnect();
    bar.remove();
  };
}
