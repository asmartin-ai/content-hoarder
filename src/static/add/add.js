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

const MAX_MB = 100;

const TOO_BIG = `That file is over ${MAX_MB} MB, too big to bring in here.`;

async function send(path, init) {
  const response = await fetch(path, { credentials: "same-origin", ...init });
  const body = await response.json().catch(() => ({}));

  if (response.status === 401) location.assign("/auth/login");

  if (response.status === 413) throw new Error(TOO_BIG);

  if (!response.ok) throw new Error(body.error || `Server answered ${response.status}`);

  return body;
}

async function prepareFile(file, source = "") {
  if (file.size > MAX_MB * 1024 * 1024) return say(TOO_BIG, "is-error");

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

let youtubePending = false;

function youtubePanel() {
  return $("add-youtube");
}

function youtubeBoxes() {
  const panel = youtubePanel();

  return panel ? [...panel.querySelectorAll('input[name="ids"]')] : [];
}

function youtubeTicked() {
  return youtubeBoxes().filter((box) => box.checked);
}

function youtubeSync() {
  const all = $("add-youtube-all");
  const button = $("add-youtube-import");

  if (!all || !button) return;
  const boxes = youtubeBoxes();
  const ticked = youtubeTicked().length;

  for (const box of boxes) box.disabled = youtubePending;
  all.disabled = youtubePending;
  button.disabled = youtubePending || ticked === 0;

  if (!youtubePending)
    button.textContent =
      ticked === 0
        ? "Import playlists"
        : `Import ${ticked} ${ticked === 1 ? "playlist" : "playlists"}`;

  const every = boxes.length > 0 && ticked === boxes.length;

  all.textContent = every ? "Uncheck all" : "Select all";
  all.setAttribute("aria-pressed", every ? "true" : "false");
}

function youtubeSay(message) {
  const line = $("add-youtube-status");

  line.hidden = false;
  line.className = "add-note is-error";
  line.textContent = message;
}

function youtubeTitle() {
  const title = document.createElement("h2");

  title.id = "add-youtube-title";
  title.tabIndex = -1;
  title.textContent = "Choose YouTube playlists";

  return title;
}

function youtubeRow(playlist) {
  const row = document.createElement("label");

  row.className = "add-yt-row";
  const box = document.createElement("input");

  box.className = "add-yt-check";
  box.type = "checkbox";
  box.name = "ids";
  box.value = playlist.id;
  box.disabled = youtubePending;

  const main = document.createElement("span");

  main.className = "add-yt-main";
  const name = document.createElement("span");

  name.className = "add-yt-name";
  name.textContent = playlist.title;
  main.append(name);

  if (playlist.count !== null) {
    const count = document.createElement("span");

    count.className = "add-yt-count";
    count.textContent = `${playlist.count} ${playlist.count === 1 ? "item" : "items"}`;
    main.append(count);
  }

  row.append(box, main);

  if (playlist.imported) {
    const tag = document.createElement("span");

    tag.className = "add-yt-tag";
    tag.textContent = "Already imported";
    row.append(tag);
  }

  return row;
}

function showYoutubeStopped(state) {
  const panel = youtubePanel();

  if (!panel) return;

  const title = youtubeTitle();
  const line = document.createElement("p");

  line.className = "add-note";
  line.setAttribute("role", "status");
  line.textContent =
    state === "expired" ? "Your YouTube sign-in timed out." : "Nothing to choose yet.";

  const link = document.createElement("a");

  link.className = "add-btn";
  link.href = "/oauth/google/start?return=/add%3Fyoutube%3Dchoose";
  link.textContent = "Choose YouTube playlists";
  panel.hidden = false;
  panel.removeAttribute("data-youtube-choice");
  panel.replaceChildren(title, line, link);
  title.focus({ preventScroll: true });
}

function youtubeBuild(playlists, generation) {
  const panel = youtubePanel();

  if (!panel) return;

  const title = youtubeTitle();
  const help = document.createElement("p");

  help.className = "add-help";
  help.textContent = "Pick what to bring over. Nothing is ticked yet.";

  const form = document.createElement("form");

  form.id = "add-youtube-form";
  form.dataset.generation = generation;

  const fieldset = document.createElement("fieldset");

  fieldset.className = "add-yt-list";
  const legend = document.createElement("legend");

  legend.className = "add-label";
  legend.textContent = "Playlists";
  fieldset.append(legend, ...playlists.map(youtubeRow));

  const hint = document.createElement("p");

  hint.className = "add-help";
  hint.textContent = "This list stays open for 10 minutes.";

  const acts = document.createElement("div");

  acts.className = "add-preview-actions";
  const all = document.createElement("button");

  all.id = "add-youtube-all";
  all.className = "add-yt-all";
  all.type = "button";
  all.setAttribute("aria-pressed", "false");
  all.textContent = "Select all";

  const button = document.createElement("button");

  button.id = "add-youtube-import";
  button.className = "add-btn is-primary";
  button.type = "submit";
  button.disabled = true;
  button.textContent = "Import playlists";
  acts.append(all, button);
  form.append(fieldset, hint, acts);

  const line = document.createElement("p");

  line.id = "add-youtube-status";
  line.className = "add-note";
  line.hidden = true;
  line.setAttribute("role", "status");
  panel.hidden = false;
  panel.setAttribute("data-youtube-choice", "");
  panel.replaceChildren(title, help, form, line);
  youtubeBind();
  youtubeSync();
  title.focus({ preventScroll: true });
}

async function youtubeStillOpen() {
  const response = await fetch("/youtube/playlists", { credentials: "same-origin" }).catch(
    () => null,
  );

  const state = response && response.ok ? await response.json().catch(() => null) : null;

  return !state || state.state === "choose";
}

async function youtubeReload() {
  const response = await fetch("/youtube/playlists", { credentials: "same-origin" }).catch(
    () => null,
  );

  const body = response && response.ok ? await response.json().catch(() => null) : null;

  youtubePending = false;

  if (!body) {
    youtubeSync();
    youtubeSay("Couldn't refresh the list. Try the Choose button again.");

    return;
  }

  if (body.state !== "choose") {
    showYoutubeStopped(body.state);

    return;
  }

  youtubeBuild(body.playlists, body.generation);
}

async function showPull() {
  const host = $("add-pull");
  const response = await fetch("/hx/add/pull", { credentials: "same-origin" }).catch(() => null);

  if (!host || !response || !response.ok) return;

  host.innerHTML = await response.text();

  if (window.htmx) window.htmx.process(host);
}

async function importYoutube(event) {
  event.preventDefault();

  if (youtubePending) return;
  const panel = youtubePanel();
  const ids = youtubeTicked().map((box) => box.value);

  if (!panel || !ids.length) return;
  const form = $("add-youtube-form");
  const generation = form ? form.dataset.generation || "" : "";
  const button = $("add-youtube-import");

  youtubePending = true;
  youtubeSync();
  button.textContent = "Starting…";
  button.setAttribute("aria-busy", "true");

  try {
    const response = await fetch("/youtube/import", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids, generation }),
    });

    const body = await response.json().catch(() => ({}));

    if (response.status === 401) {
      location.assign("/auth/login");

      return;
    }

    youtubePending = false;
    button.removeAttribute("aria-busy");

    if (response.status === 409) {
      if (body.state === "stale") {
        await youtubeReload();

        return;
      }

      youtubeSync();
      youtubeSay("An import is already running — try again in a moment.");

      return;
    }

    if (!response.ok) throw new Error(body.error || `Server answered ${response.status}`);
    panel.hidden = true;
    await showPull();
  } catch (error) {
    youtubePending = false;
    button.removeAttribute("aria-busy");

    if (!(await youtubeStillOpen())) {
      showYoutubeStopped("expired");

      return;
    }

    youtubeSync();
    youtubeSay(error.message);
  }
}

function youtubeBind() {
  for (const box of youtubeBoxes()) box.addEventListener("change", youtubeSync);

  const all = $("add-youtube-all");
  const form = $("add-youtube-form");

  if (all)
    all.addEventListener("click", () => {
      const boxes = youtubeBoxes();
      const check = youtubeTicked().length !== boxes.length;

      for (const box of boxes) box.checked = check;
      youtubeSync();
    });

  if (form) form.addEventListener("submit", importYoutube);
}

function wireYoutube() {
  const panel = youtubePanel();

  if (!panel) return;

  youtubeBind();
  youtubeSync();
  panel.querySelector("h2").focus({ preventScroll: true });
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

  wireYoutube();
}

wire();
