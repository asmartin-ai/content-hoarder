import { track } from "../core/track.js";

const $ = (selector) => document.querySelector(selector);

const $$ = (selector) => [...document.querySelectorAll(selector)];

const channel = "BroadcastChannel" in globalThis ? new BroadcastChannel("ch-settings") : null;

async function post(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(data.error || "not saved");

    error.data = data;
    throw error;
  }

  return data;
}

function announce(type, on) {
  if (type === "ai") document.dispatchEvent(new CustomEvent("ch:ai-consent", { detail: { on } }));

  channel?.postMessage({ type, on });
}

function setupToggle(selector, save) {
  const button = $(selector);

  if (!button) return;

  button.addEventListener("click", async () => {
    const next = button.getAttribute("aria-pressed") !== "true";
    button.disabled = true;

    try {
      await save(next, button);
    } catch {
      const state = switchState(button);

      if (state) state.textContent = "Try again";
    } finally {
      button.disabled = false;
    }
  });
}

function switchState(button) {
  return button.querySelector("[data-settings-ai-state], [data-settings-unsave-state]");
}

setupToggle("[data-settings-ai]", async (next, button) => {
  const data = await post("/settings/ai", { enabled: next });
  const on = data.consent === "on";

  button.setAttribute("aria-pressed", String(on));
  const state = switchState(button);

  if (state) state.textContent = on ? "On" : "Off";
  announce("ai", on);
  track("consent_choice", { on, where: "settings" });
});

function paintToggle(selector, on) {
  const button = $(selector);

  if (!button) return;

  button.setAttribute("aria-pressed", String(on));
  const state = switchState(button);

  if (state) state.textContent = on ? "On" : "Off";
}

document.addEventListener("ch:ai-consent", (event) => {
  if (event.detail) paintToggle("[data-settings-ai]", event.detail.on === true);
});

channel?.addEventListener("message", (event) => {
  const message = event.data;

  if (!message) return;

  if (message.type === "ai") paintToggle("[data-settings-ai]", message.on === true);
});

function paintTheme() {
  const current = document.documentElement.dataset.theme || "dark";

  $$("[data-settings-theme]").forEach((button) =>
    button.setAttribute("aria-pressed", String(button.dataset.settingsTheme === current)),
  );
}

$$("[data-settings-theme]").forEach((button) =>
  button.addEventListener("click", () => {
    const theme = button.dataset.settingsTheme || "dark";

    document.documentElement.dataset.theme = theme;

    try {
      localStorage.setItem("ch-theme", theme);
    } catch {}

    paintTheme();
  }),
);

paintTheme();

new MutationObserver(paintTheme).observe(document.documentElement, {
  attributes: true,
  attributeFilter: ["data-theme"],
});

function paintDensity() {
  const density = localStorage.chDensity || "comfortable";

  $$("[data-settings-density]").forEach((button) =>
    button.setAttribute("aria-pressed", String(button.dataset.settingsDensity === density)),
  );
}

function paintGoal() {
  const goal = localStorage.chGoal === undefined ? 8 : parseInt(localStorage.chGoal, 10) || 0;

  $$("[data-settings-goal]").forEach((button) =>
    button.setAttribute("aria-pressed", String(Number(button.dataset.settingsGoal) === goal)),
  );
}

function paintNsfw() {
  const hide = localStorage.chSafe !== "0";

  $$("[data-settings-nsfw]").forEach((button) =>
    button.setAttribute("aria-pressed", String((button.dataset.settingsNsfw === "hide") === hide)),
  );
}

function paintArchive() {
  const on = localStorage.chArchiveMedia === "1";

  $$("[data-settings-archive]").forEach((button) =>
    button.setAttribute("aria-pressed", String((button.dataset.settingsArchive === "on") === on)),
  );
}

$$("[data-settings-density]").forEach((button) =>
  button.addEventListener("click", () => {
    localStorage.chDensity = button.dataset.settingsDensity;
    paintDensity();
  }),
);

$$("[data-settings-goal]").forEach((button) =>
  button.addEventListener("click", () => {
    localStorage.chGoal = button.dataset.settingsGoal;
    paintGoal();
  }),
);

$$("[data-settings-nsfw]").forEach((button) =>
  button.addEventListener("click", () => {
    localStorage.chSafe = button.dataset.settingsNsfw === "hide" ? "1" : "0";
    paintNsfw();
  }),
);

$$("[data-settings-archive]").forEach((button) =>
  button.addEventListener("click", () => {
    localStorage.chArchiveMedia = button.dataset.settingsArchive === "on" ? "1" : "0";
    paintArchive();
  }),
);

paintDensity();

paintGoal();

paintNsfw();

paintArchive();

const retentionPreview = $("#settings-retention-preview");

const retentionCurrent = $("#settings-retention-current");

const retentionConfirm = $("#settings-retention-confirm");

const retentionPurge = $("#settings-retention-purge");

const retentionFeedback = $("#settings-retention-feedback");

let retention = {
  days: Number(retentionPreview?.dataset.days || 30),
  total: Number(retentionPreview?.dataset.total || 0),
  cutoff: Number(retentionPreview?.dataset.cutoff || 0),
  loading: false,
};

function dateOf(ts) {
  return new Date(ts * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function paintRetention() {
  $$("[data-settings-retention]").forEach((button) =>
    button.setAttribute(
      "aria-pressed",
      String(Number(button.dataset.settingsRetention) === retention.days),
    ),
  );

  if (retentionCurrent)
    retentionCurrent.textContent = `Current window: ${retention.days} ${
      retention.days === 1 ? "day" : "days"
    }.`;

  if (retentionPreview) {
    retentionPreview.textContent = retention.loading
      ? "Checking what would be purged..."
      : retention.total
        ? `${retention.total.toLocaleString()} Done ${
            retention.total === 1 ? "item" : "items"
          } older than ${dateOf(retention.cutoff)} would be permanently deleted.`
        : "Nothing is eligible right now.";
  }

  if (retentionPurge)
    retentionPurge.disabled = retention.loading || !retention.total || !retentionConfirm?.checked;
}

retentionConfirm?.addEventListener("change", paintRetention);

$$("[data-settings-retention]").forEach((button) =>
  button.addEventListener("click", async () => {
    if (retention.loading) return;
    const days = Number(button.dataset.settingsRetention);

    if (!days || days === retention.days) return;
    retention.loading = true;

    if (retentionConfirm) retentionConfirm.checked = false;
    paintRetention();

    try {
      const data = await post("/settings/done-retention", { retention_days: days });

      retention.days = Number(data.retention_days) || days;
      retention.total = Number(data.preview?.total || 0);
      retention.cutoff = Number(data.preview?.cutoff || 0);

      if (retentionFeedback)
        retentionFeedback.textContent = `Done retention set to ${retention.days} days.`;
    } catch (error) {
      if (retentionFeedback)
        retentionFeedback.textContent = error.data?.error || "Couldn't save Done retention.";
    } finally {
      retention.loading = false;
      paintRetention();
    }
  }),
);

retentionPurge?.addEventListener("click", async () => {
  if (retention.loading || !retention.total || !retentionConfirm?.checked) return;
  retention.loading = true;
  paintRetention();

  try {
    const data = await post("/settings/done-retention/purge", {
      expected_total: retention.total,
      expected_cutoff: retention.cutoff,
    });

    retention.total = Number(data.preview?.total || 0);
    retention.cutoff = Number(data.preview?.cutoff || 0);
    retentionConfirm.checked = false;

    if (retentionFeedback) {
      const count = Number(data.purged?.total || 0);

      retentionFeedback.textContent = `Purged ${count} Done ${count === 1 ? "item" : "items"}.`;
    }
  } catch (error) {
    const body = error.data || {};

    if (body.preview) {
      retention.total = Number(body.preview.total || 0);
      retention.cutoff = Number(body.preview.cutoff || 0);
      retentionConfirm.checked = false;
    }

    if (retentionFeedback) retentionFeedback.textContent = body.error || "Done purge failed.";
  } finally {
    retention.loading = false;
    paintRetention();
  }
});

const unsaveButton = $("[data-settings-unsave]");

const unsaveState = $("#settings-unsave-state");

const unsaveAuth = $("#settings-unsave-auth");

const unsaveCookie = $("#settings-unsave-cookie");

const unsaveFeedback = $("#settings-unsave-feedback");

function paintUnsave(enabled, username, pending, failed) {
  if (unsaveButton) {
    unsaveButton.setAttribute("aria-pressed", String(enabled));
    const state = switchState(unsaveButton);

    if (state) state.textContent = enabled ? "On" : "Off";
  }

  if (unsaveState) {
    unsaveState.textContent = `${
      username ? `Connected as u/${username}` : "No Reddit session saved yet"
    } · ${pending} queued · ${failed} failed`;
  }
}

let unsaveRead = 0;

async function refreshUnsave() {
  const generation = ++unsaveRead;

  try {
    const response = await fetch("/reddit/unsave/status");

    if (!response.ok) return;
    const data = await response.json();

    if (generation !== unsaveRead) return;
    paintUnsave(data.enabled, data.username, data.pending, data.failed);
  } catch {}
}

unsaveButton?.addEventListener("click", async () => {
  const next = unsaveButton.getAttribute("aria-pressed") !== "true";

  unsaveRead += 1;
  unsaveButton.disabled = true;

  try {
    await post("/reddit/unsave/enable", { enabled: next });
    await refreshUnsave();
  } catch {
    if (unsaveFeedback) unsaveFeedback.textContent = "Couldn't save that. Try again.";
  } finally {
    unsaveButton.disabled = false;
  }
});

unsaveAuth?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const cookie = unsaveCookie?.value.trim() || "";

  if (!cookie) {
    if (unsaveFeedback) unsaveFeedback.textContent = "Paste your reddit_session cookie first.";

    return;
  }

  const submit = unsaveAuth.querySelector("button");

  if (submit) submit.disabled = true;

  unsaveRead += 1;

  try {
    const data = await post("/reddit/unsave/auth", { cookie });

    if (unsaveFeedback)
      unsaveFeedback.textContent = `Cookie saved${data.username ? ` for u/${data.username}` : ""}.`;

    if (unsaveCookie) unsaveCookie.value = "";
    await refreshUnsave();
  } catch (error) {
    if (unsaveFeedback) unsaveFeedback.textContent = error.data?.error || "Couldn't save that.";
  } finally {
    if (submit) submit.disabled = false;
  }
});

refreshUnsave();

$("#settings-sync")?.addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const status = $("#settings-status");

  button.disabled = true;

  if (status) status.textContent = "Syncing...";

  try {
    const data = await post("/reddit/sync", {});

    if (status) {
      if (data.auth_error) status.textContent = "Sync needs a reddit_session cookie.";
      else if (data.error) status.textContent = `Sync error: ${data.error}`;
      else status.textContent = `+${data.new ?? 0} new (${data.fetched ?? 0} fetched).`;
    }
  } catch (error) {
    if (status) status.textContent = error.data?.error || "Sync failed.";
  } finally {
    button.disabled = false;
  }
});

paintRetention();
