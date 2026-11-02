import { track } from "../core/track.js";

const endpoint = "/settings/ai";

const channel = "BroadcastChannel" in globalThis ? new BroadcastChannel("ch-settings") : null;

async function sendConsent(enabled) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled }),
  });

  if (!response.ok) throw new Error("consent not saved");

  return response.json();
}

function announce(on) {
  document.dispatchEvent(new CustomEvent("ch:ai-consent", { detail: { on } }));
  channel?.postMessage({ type: "ai", on });
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

  let busy = false;

  const decide = async (enabled) => {
    if (busy) return;
    busy = true;

    for (const button of buttons) button.disabled = true;

    try {
      const result = await sendConsent(enabled);
      const on = result?.consent === "on";

      announce(on);
      track("consent_choice", { on, where: "popup" });
      dialog.close();
    } catch {
      if (error) {
        error.textContent = "Couldn't save that. Try again.";
        error.hidden = false;
      }

      for (const button of buttons) button.disabled = false;
    } finally {
      busy = false;
    }
  };

  enable?.addEventListener("click", () => decide(true));
  decline?.addEventListener("click", () => decide(false));
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    decide(false);
  });
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) event.stopPropagation();
  });
  showDialog(dialog);

  document.addEventListener(
    "keydown",
    (event) => {
      if (dialog.open) event.stopPropagation();
    },
    true,
  );
}
