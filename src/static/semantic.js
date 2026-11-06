const query = document.querySelector("#query");

const status = document.querySelector("#status");

const sources = document.querySelector("#sources");

const answer = document.querySelector("#answer");

const controls = [...document.querySelectorAll("button")];

let busy = false;

async function api(path, body) {
  const response = await fetch(
    path,
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );

  const data = await response.json();

  if (!response.ok) throw new Error(data.error || "Request failed");

  return data;
}

async function indexStatus() {
  try {
    const state = await api("/api/semantic/status");
    document.querySelector("#index-status").textContent =
      `${state.indexed} indexed · ${state.stale} stale · ${state.missing} not indexed${state.running ? " · Indexing…" : ""}${state.offline ? " · Offline" : ""}`;
  } catch (error) {
    document.querySelector("#index-status").textContent = error.message;
  }
}

async function run(action) {
  if (busy) return;

  if (action !== "index" && !query.reportValidity()) return;
  const consent = document.querySelector("#consent");

  if (action === "ask" && !consent.checked) {
    status.textContent =
      "Please consent to sending this question and its retrieved passages first.";

    return;
  }

  busy = true;
  controls.forEach((button) => (button.disabled = true));
  status.textContent =
    action === "index"
      ? "Indexing locally. First use may download the model; keep this page open."
      : action === "ask"
        ? "Retrieving sources and generating an answer…"
        : "Searching locally…";

  if (action !== "index") {
    sources.replaceChildren();
    answer.hidden = true;
  }

  try {
    const data = await api(
      `/api/semantic/${action}?safe=${document.querySelector("#safe").checked ? "1" : "0"}`,
      action === "index"
        ? {}
        : { query: query.value, consent: action === "ask" && consent.checked },
    );

    if (action === "index")
      status.textContent = `Indexed ${data.indexed}; unchanged ${data.skipped}; removed ${data.removed}.`;
    else {
      status.textContent = `${data.mode === "hybrid" ? "Hybrid semantic + lexical" : "Lexical only"} · ${data.evidence.length} sources. ${data.warning || ""}`;

      if (data.answer) {
        answer.hidden = false;
        document.querySelector("#answer-text").textContent = data.answer;
      }

      for (const item of data.evidence) {
        const article = document.createElement("article");
        article.id = item.id;
        const heading = document.createElement("h3");
        heading.textContent = `[${item.id}] ${item.title}`;
        const text = document.createElement("p");
        text.textContent = item.text;
        const location = document.createElement("small");
        location.textContent = `${item.ref} · lines ${item.startLine}–${item.endLine}`;
        article.append(heading, location, text);

        if (item.url && /^https?:\/\//i.test(item.url)) {
          const link = document.createElement("a");
          link.href = item.url;
          link.rel = "noopener noreferrer";
          link.target = "_blank";
          link.textContent = "Open original source";
          article.append(link);
        }

        sources.append(article);
      }

      if (!data.evidence.length)
        sources.textContent = "No matching sources. Try different terms or index this library.";
    }
  } catch (error) {
    status.textContent = error.message;
  } finally {
    if (action === "ask") consent.checked = false;
    busy = false;
    controls.forEach((button) => (button.disabled = false));
    await indexStatus();
  }
}

document.querySelector("#search-form").addEventListener("submit", (event) => {
  event.preventDefault();
  run("search");
});

document.querySelector("#ask").addEventListener("click", () => run("ask"));

document.querySelector("#index").addEventListener("click", () => run("index"));

query.addEventListener("input", () => {
  document.querySelector("#consent").checked = false;
});

indexStatus();
