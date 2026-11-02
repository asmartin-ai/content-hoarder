const ENDPOINT = "/events";

const SID_KEY = "ch.sid";

const MAX_EVENTS = 50;

const MAX_DATA = 2048;

const MAX_BODY = 60 * 1024;

const FLUSH_MS = 5000;

let queue = [];

let timer = 0;

let sid = "";

let visibleAt = 0;

let shownMs = 0;

let hidden = false;

const bytes = (value) => {
  try {
    return new TextEncoder().encode(value).length;
  } catch {
    return value.length;
  }
};

const send = (sidValue, batch) => {
  if (!batch.length) return;
  const payload = '{"sid":' + JSON.stringify(sidValue) + ',"events":[' + batch.join(",") + "]}";

  try {
    if (navigator.sendBeacon?.(ENDPOINT, new Blob([payload], { type: "application/json" }))) return;

    fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
      keepalive: true,
    }).catch(() => {});
  } catch {}
};

const on = () => {
  try {
    return document.body?.dataset.analytics === "1";
  } catch {
    return false;
  }
};

const now = () => performance.now();

const sessionId = () => {
  if (sid) return sid;

  try {
    sid = sessionStorage.getItem(SID_KEY) || "";
  } catch {}

  if (!sid) {
    sid = (
      globalThis.crypto?.randomUUID?.() ||
      Math.random().toString(36).slice(2) + Date.now().toString(36)
    )
      .replace(/-/g, "")
      .slice(0, 32);

    try {
      sessionStorage.setItem(SID_KEY, sid);
    } catch {}
  }

  return sid;
};

const pageName = () => {
  try {
    return document.body?.dataset.page || undefined;
  } catch {
    return undefined;
  }
};

export function flush() {
  if (timer) {
    clearTimeout(timer);
    timer = 0;
  }

  if (!queue.length) return;
  const events = queue;

  queue = [];
  const sidValue = sessionId();
  const head = '{"sid":' + JSON.stringify(sidValue) + ',"events":[';
  const base = bytes(head) + 2;
  let batch = [];
  let size = base;

  for (const event of events) {
    let encoded;

    try {
      encoded = JSON.stringify(event);
    } catch {
      continue;
    }

    if (encoded === undefined) continue;
    const n = bytes(encoded);

    if (base + n > MAX_BODY) continue;

    if (batch.length && (batch.length >= MAX_EVENTS || size + n + 1 > MAX_BODY)) {
      send(sidValue, batch);
      batch = [];
      size = base;
    }

    size += n + (batch.length ? 1 : 0);
    batch.push(encoded);
  }

  send(sidValue, batch);
}

function schedule() {
  if (timer) return;
  timer = setTimeout(flush, FLUSH_MS);
}

export function track(kind, data, opts) {
  try {
    if (!kind || !on()) return;
    const event = { kind, at: Date.now() };
    const page = pageName();

    if (page) event.page = page;

    if (opts?.fullname) event.fullname = String(opts.fullname).slice(0, 200);

    if (data !== null && data !== undefined) {
      let encoded;

      try {
        encoded = JSON.stringify(data);
      } catch {
        return;
      }

      if (encoded === undefined || bytes(encoded) > MAX_DATA) return;

      event.data = data;
    }

    queue.push(event);

    if (queue.length >= MAX_EVENTS) flush();
    else schedule();
  } catch {}
}

if (on()) {
  if (document.visibilityState === "visible") visibleAt = now();

  track("page_view", { path: location.pathname });

  const hide = () => {
    if (hidden) return;
    hidden = true;

    if (visibleAt) shownMs += now() - visibleAt;
    visibleAt = 0;
    track("page_hide", { visible_ms: Math.round(shownMs) });
    flush();
  };

  document.addEventListener("visibilitychange", () => {
    try {
      if (document.visibilityState === "visible") {
        hidden = false;
        shownMs = 0;
        visibleAt = now();

        return;
      }

      hide();
    } catch {}
  });

  window.addEventListener("pagehide", () => {
    try {
      hide();
    } catch {}
  });

  window.addEventListener("pageshow", (e) => {
    try {
      if (!e.persisted) return;
      shownMs = 0;

      if (document.visibilityState === "visible") {
        hidden = false;
        visibleAt = now();
      } else {
        hidden = true;
        visibleAt = 0;
      }
    } catch {}
  });
}
