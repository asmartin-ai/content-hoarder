import { esc } from "../core/util.js";

export function initPalette(inputEl, commands) {
  /* Build panel once — lives inside the search wrapper (position:relative) */
  const panel = document.createElement("div");
  panel.className = "palette";
  panel.id = "palette";
  panel.setAttribute("role", "listbox");
  inputEl.parentElement.appendChild(panel);
  /* collapsed combobox state must exist BEFORE any interaction, or AT announces nothing */
  inputEl.setAttribute("aria-expanded", "false");
  inputEl.setAttribute("aria-haspopup", "listbox");

  let active = false;
  let selIdx = -1;
  let matches = [];

  /* Fuzzy subsequence match with tiered scoring:
     prefix hit > word-boundary hits > scattered; stable order within tier */
  function fuzzyMatch(query, label) {
    if (!query) return { score: 0, ok: true };
    const q = query.toLowerCase();
    const l = label.toLowerCase();
    let qi = 0;
    const idx = [];
    for (let li = 0; li < l.length && qi < q.length; li++) {
      if (l[li] === q[qi]) { idx.push(li); qi++; }
    }
    if (qi < q.length) return { ok: false };
    let sc = 0;
    /* strict prefix only — a scattered match whose first char lands at 0 must not
       outrank true word-boundary matches */
    if (l.startsWith(q)) sc += 100;
    for (const i of idx) {                             // word-boundary tier
      if (i === 0 || " :_-".includes(label[i - 1])) sc += 10;
    }
    for (let i = 1; i < idx.length; i++) {             // contiguity within tier
      if (idx[i] === idx[i - 1] + 1) sc += 1;
    }
    return { score: sc, ok: true };
  }

  function getQuery() {
    const v = inputEl.value;
    return v.startsWith(">") ? v.slice(1).trim() : "";
  }

  function render() {
    const q = getQuery();
    const scored = commands.map((cmd, i) => {
      const m = fuzzyMatch(q, cmd.label);
      return m.ok ? { cmd, sc: m.score, oi: i } : null;
    }).filter(Boolean);
    /* stable sort: higher score first, then original index */
    scored.sort((a, b) => b.sc - a.sc || a.oi - b.oi);
    matches = scored.map((s) => s.cmd);

    if (!matches.length) {
      panel.classList.remove("show");
      inputEl.setAttribute("aria-expanded", "false");
      inputEl.removeAttribute("aria-activedescendant");
      active = false;
      return;
    }

    selIdx = 0;
    panel.innerHTML = matches.map((cmd, i) => {
      const id = `pal-opt-${i}`;
      const on = i === 0;
      return `<button type="button" class="pal-row${on ? " sel" : ""}" role="option"` +
        ` id="${id}" data-idx="${i}" aria-selected="${on}">` +
        `<span class="pal-label">${esc(cmd.label)}</span>` +
        `<span class="pal-hint">${esc(cmd.hint)}</span></button>`;
    }).join("");
    panel.classList.add("show");
    inputEl.setAttribute("aria-expanded", "true");
    inputEl.setAttribute("aria-activedescendant", "pal-opt-0");
    active = true;
  }

  function selectRow(i) {
    const rows = panel.querySelectorAll(".pal-row");
    rows.forEach((r, j) => {
      const on = j === i;
      r.classList.toggle("sel", on);
      r.setAttribute("aria-selected", String(on));
    });
    inputEl.setAttribute("aria-activedescendant", `pal-opt-${i}`);
    selIdx = i;
  }

  function runAndClose(i) {
    if (i < 0 || i >= matches.length) return;
    const fn = matches[i].run;
    inputEl.value = "";
    deactivate();
    fn();
  }

  function deactivate() {
    panel.classList.remove("show");
    panel.innerHTML = "";
    inputEl.setAttribute("aria-expanded", "false");
    inputEl.removeAttribute("aria-activedescendant");
    active = false;
    selIdx = -1;
    matches = [];
  }

  /* --- events --- */

  /* input drives activation + filtering */
  inputEl.addEventListener("input", () => {
    if (!inputEl.value.startsWith(">")) {
      if (active) deactivate();
      return;
    }
    /* entering command mode — dismiss operator popover */
    const oppop = document.querySelector("#oppop");
    if (oppop) oppop.classList.remove("show");
    render();
  });

  /* re-activate on re-focus while still in command mode */
  inputEl.addEventListener("focus", () => {
    if (inputEl.value.startsWith(">")) render();
  });

  /* close panel on blur (pointerdown+preventDefault on rows blocks this) */
  inputEl.addEventListener("blur", () => {
    if (active) deactivate();
  });

  /* keyboard navigation — only while in command mode */
  inputEl.addEventListener("keydown", (e) => {
    if (!inputEl.value.startsWith(">")) return;
    /* Escape always clears command mode, even with no visible panel */
    if (e.key === "Escape") {
      e.preventDefault();
      inputEl.value = "";
      deactivate();
      return;
    }
    if (!active) return;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        selectRow((selIdx + 1) % matches.length);
        break;
      case "ArrowUp":
        e.preventDefault();
        selectRow((selIdx - 1 + matches.length) % matches.length);
        break;
      case "Enter":
        e.preventDefault();
        runAndClose(selIdx);
        break;
    }
  });

  /* mouse: pointerdown + preventDefault keeps focus on input */
  panel.addEventListener("pointerdown", (e) => {
    const row = e.target.closest(".pal-row");
    if (!row) return;
    e.preventDefault();
    runAndClose(parseInt(row.dataset.idx, 10));
  });
}
