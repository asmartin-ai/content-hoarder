import { track } from "../core/track.js";

const endpoint = "/settings/ai";

async function sendConsent(enabled) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled }),
  });

  if (!response.ok) throw new Error("consent not saved");

  return response.json();
}

function paintToggle(toggle, on) {
  toggle.setAttribute("aria-pressed", String(on));
  toggle.classList.toggle("is-primary", on);

  const state = toggle.querySelector("[data-ai-toggle-state]");

  if (state) state.textContent = on ? "On" : "Off";
}

function announce(on) {
  document.dispatchEvent(new CustomEvent("ch:ai-consent", { detail: { on } }));
}

function showDialog(dialog) {
  if (dialog.showModal === undefined) {
    dialog.setAttribute("open", "");

    return;
  }

  try {
    dialog.showModal();
  } catch {
    dialog.setAttribute("open", "");
  }
}

const dialog = document.querySelector("[data-ai-consent]");

if (dialog) {
  const error = dialog.querySelector("[data-ai-consent-error]");
  const enable = dialog.querySelector("[data-ai-consent-enable]");
  const decline = dialog.querySelector("[data-ai-consent-decline]");
  const buttons = [enable, decline].filter(Boolean);

  const decide = async (enabled) => {
    for (const button of buttons) button.disabled = true;

    try {
      const result = await sendConsent(enabled);
      const on = result?.consent === "on";
      const toggle = document.querySelector("[data-ai-toggle]");

      if (toggle) paintToggle(toggle, on);

      announce(on);
      track("consent_choice", { on, where: "popup" });
      dialog.close();
    } catch {
      if (error) {
        error.textContent = "Couldn't save that. Try again.";
        error.hidden = false;
      }

      for (const button of buttons) button.disabled = false;
    }
  };

  enable?.addEventListener("click", () => decide(true));
  decline?.addEventListener("click", () => decide(false));
  showDialog(dialog);

  document.addEventListener(
    "keydown",
    (event) => {
      if (dialog.open) event.stopPropagation();
    },
    true,
  );
}

const toggle = document.querySelector("[data-ai-toggle]");

if (toggle) {
  const error = document.querySelector("[data-ai-toggle-error]");

  paintToggle(toggle, toggle.getAttribute("aria-pressed") === "true");

  toggle.addEventListener("click", async () => {
    const next = toggle.getAttribute("aria-pressed") !== "true";

    toggle.disabled = true;

    if (error) error.hidden = true;

    try {
      const result = await sendConsent(next);
      const on = result?.consent === "on";

      paintToggle(toggle, on);
      announce(on);
      track("consent_choice", { on, where: "add" });
    } catch {
      if (error) {
        error.textContent = "Couldn't save that. Try again.";
        error.hidden = false;
      }
    } finally {
      toggle.disabled = false;
    }
  });
}
