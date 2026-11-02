const $ = (id) => document.getElementById(id);

const preview = $("add-preview");

const previewLine = $("add-preview-line");

const previewList = $("add-preview-list");

const status = $("add-status");

let token = "";

function say(message, tone = "") {
  status.hidden = false;
  status.className = `add-note ${tone}`.trim();
  status.textContent = message;
}

function sayAdded(count) {
  status.hidden = false;
  status.className = "add-note is-ok";
  status.textContent = `Added ${count}. `;
  const link = document.createElement("a");

  link.href = "/clear?n=10";
  link.textContent = "Clear 10 →";
  status.append(link);
}

async function send(path, init) {
  const response = await fetch(path, { credentials: "same-origin", ...init });
  const body = await response.json().catch(() => ({}));

  if (response.status === 401) location.assign("/auth/login");

  if (!response.ok) throw new Error(body.error || `Server answered ${response.status}`);

  return body;
}

async function prepareFile(file, source = "") {
  const form = new FormData();

  form.append("file", file);

  if (source) form.append("source", source);
  preview.hidden = true;
  say("Reading…");

  try {
    const result = await send("/import/prepare", { method: "POST", body: form });

    token = result.token;
    previewLine.textContent = result.new
      ? `${result.new} new of ${result.count} from ${result.label}.`
      : `All ${result.count} from ${result.label} are already here.`;
    $("add-commit").textContent = result.new ? "Add them" : "Update them";
    previewList.replaceChildren(
      ...result.sample.map((entry) => {
        const item = document.createElement("li");

        item.textContent = entry.title;

        return item;
      }),
    );
    status.hidden = true;
    preview.hidden = false;
    $("add-commit").focus();
  } catch (error) {
    say(error.message, "is-error");
  }
}

async function commit() {
  if (!token) return;
  const button = $("add-commit");

  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  const label = button.textContent;

  button.textContent = "Adding…";

  try {
    const result = await send("/import/commit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });

    preview.hidden = true;
    token = "";
    sayAdded(result.imported);
  } catch (error) {
    say(error.message, "is-error");
  } finally {
    button.disabled = false;
    button.removeAttribute("aria-busy");
    button.textContent = label;
  }
}

function wire() {
  const drop = $("add-drop");
  const input = $("add-file");

  input.addEventListener("change", () => {
    if (input.files && input.files[0]) prepareFile(input.files[0]);
    input.value = "";
  });

  drop.addEventListener("dragover", (event) => {
    event.preventDefault();
    drop.classList.add("is-over");
  });

  drop.addEventListener("dragleave", () => drop.classList.remove("is-over"));

  drop.addEventListener("drop", (event) => {
    event.preventDefault();
    drop.classList.remove("is-over");
    const file = event.dataTransfer && event.dataTransfer.files[0];

    if (file) prepareFile(file);
  });

  $("add-paste-go").addEventListener("click", () => {
    const text = $("add-paste").value.trim();

    if (!text) return say("Paste some links first.", "is-error");
    prepareFile(new File([text], "links.txt", { type: "text/plain" }), "links");
  });

  $("add-commit").addEventListener("click", commit);

  $("add-cancel").addEventListener("click", () => {
    preview.hidden = true;
    token = "";
  });

  document.querySelector(".add-bookmarklet").addEventListener("click", (event) => {
    event.preventDefault();
    say("Drag it to your bookmarks bar instead, then click it on reddit.com.");
  });
}

wire();
