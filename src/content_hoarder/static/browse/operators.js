/* operators.js — Gmail/Discord-style search-operator discovery (Epic 12).

   Makes the (previously invisible) search operators discoverable: as you type it
   suggests operator KEYS, and after "key:" it suggests VALUES (e.g. after `source:`
   it lists the sources). Applied operators render as removable chips. Keyboard-
   navigable (↑/↓ + Enter/Tab to complete, Esc to dismiss); mouse too. The fuzzy hint
   + Exact checkbox in the popover are left untouched.

   The operator vocabulary mirrors search_query.py — keep them in sync. */

import { esc } from "../core/util.js";

const KEYS = [
  { key: "source:", hint: "by source", vals: ["reddit", "youtube", "hackernews", "firefox", "obsidian", "keep"] },
  { key: "status:", hint: "triage state", vals: ["inbox", "keep", "archived", "done"] },
  { key: "kind:", hint: "item type", vals: ["post", "video", "comment", "story", "tab"] },
  { key: "is:", hint: "a flag", vals: ["saved", "unsaved", "nsfw", "decayed", "swept"] },
  { key: "has:", hint: "media type", vals: ["video", "image", "gallery"] },
  { key: "tag:", hint: "by tag", dyn: "tags" },
  { key: "subreddit:", hint: "by subreddit", dyn: "subs" },
  { key: "before:", hint: "date YYYY-MM-DD" },
  { key: "after:", hint: "date YYYY-MM-DD" },
  { key: "score:", hint: "e.g. score:>100" },
];
const KEYSET = new Set(KEYS.map((k) => k.key));

/* the token under the cursor, plus the text up to the caret (what we complete on) */
function activeToken(input) {
  const v = input.value;
  const c = input.selectionStart ?? v.length;
  let s = c;
  while (s > 0 && !/\s/.test(v[s - 1])) s -= 1;
  let e = c;
  while (e < v.length && !/\s/.test(v[e])) e += 1;
  return { start: s, end: e, typed: v.slice(s, c) };
}

/* context-aware suggestion list for the active token */
function suggestFor(typed, getDyn) {
  const ci = typed.indexOf(":");
  if (ci >= 0) {
    const key = typed.slice(0, ci + 1).toLowerCase();
    const partial = typed.slice(ci + 1).toLowerCase();
    const spec = KEYS.find((k) => k.key === key);
    if (!spec) return [];
    const vals = spec.dyn ? (getDyn(spec.dyn) || []) : (spec.vals || []);
    return vals
      .filter((v) => v.toLowerCase().startsWith(partial))
      .slice(0, 8)
      .map((v) => ({ complete: key + v, label: key + v, hint: spec.hint }));
  }
  const p = typed.toLowerCase();
  return KEYS.filter((k) => !p || k.key.startsWith(p))
    .slice(0, 10)
    .map((k) => ({ complete: k.key, label: k.key, hint: k.hint }));
}

/* applied operators in the whole query → chips (value-keys + is:/has: + -excl + "exact") */
function appliedOps(value) {
  const out = [];
  const re = /"[^"]*"|\S+/g;
  let m;
  while ((m = re.exec(value))) {
    const t = m[0];
    if (t.startsWith('"') && t.length > 1) out.push({ raw: t, label: t });
    else if (t.startsWith("-") && t.length > 1 && !t.includes(":")) out.push({ raw: t, label: t });
    else {
      const ci = t.indexOf(":");
      if (ci > 0 && t.slice(ci + 1)) {
        const key = t.slice(0, ci + 1).toLowerCase();
        if (KEYSET.has(key)) out.push({ raw: t, label: t });
      }
    }
  }
  return out;
}

export function initOperators(input, pop, opts = {}) {
  const opsEl = pop.querySelector(".ops");
  const getDyn = opts.getDyn || (() => []);
  const onApply = opts.onApply || (() => {});
  let rows = [];
  let sel = -1;

  const inCommandMode = () => input.value.startsWith(">");

  function chipsHtml(value) {
    const ops = appliedOps(value);
    if (!ops.length) return "";
    return (
      '<div class="opapplied">' +
      ops
        .map(
          (o) =>
            '<span class="opchip-on">' +
            esc(o.label) +
            '<button type="button" class="opx" data-raw="' +
            esc(o.raw) +
            '" aria-label="remove ' +
            esc(o.label) +
            '">×</button></span>'
        )
        .join("") +
      "</div>"
    );
  }

  function render() {
    if (inCommandMode()) {
      pop.classList.remove("show");
      return;
    }
    rows = suggestFor(activeToken(input).typed, getDyn);
    sel = rows.length ? 0 : -1;
    const sug = rows
      .map(
        (r, i) =>
          '<button type="button" class="opsug' +
          (i === 0 ? " sel" : "") +
          '" role="option" data-i="' +
          i +
          '"><span class="opk">' +
          esc(r.label) +
          '</span><span class="oph">' +
          esc(r.hint) +
          "</span></button>"
      )
      .join("");
    opsEl.innerHTML = chipsHtml(input.value) + sug;
    pop.classList.add("show");
  }

  function setSel(i) {
    const els = opsEl.querySelectorAll(".opsug");
    els.forEach((el, j) => el.classList.toggle("sel", j === i));
    sel = i;
    if (els[i]) els[i].scrollIntoView({ block: "nearest" });
  }

  function complete(i) {
    if (i < 0 || i >= rows.length) return;
    const tok = activeToken(input);
    const v = input.value;
    const ins = rows[i].complete;
    const trailing = ins.endsWith(":") ? "" : " "; // keys keep the caret to type a value
    const before = v.slice(0, tok.start);
    const after = v.slice(tok.end);
    const head = before + ins + trailing;
    input.value = (head + after).replace(/\s{2,}/g, " ");
    const caret = head.length;
    input.setSelectionRange(caret, caret);
    input.focus();
    onApply();
    render(); // after a key, immediately surface its values
  }

  function removeOp(raw) {
    // remove the exact operator token (first occurrence) from the query
    const toks = input.value.match(/"[^"]*"|\S+/g) || [];
    const idx = toks.indexOf(raw);
    if (idx >= 0) toks.splice(idx, 1);
    input.value = toks.join(" ");
    input.focus();
    onApply();
    render();
  }

  input.addEventListener("input", render);
  input.addEventListener("focus", render);
  input.addEventListener("blur", () => setTimeout(() => pop.classList.remove("show"), 160));

  input.addEventListener("keydown", (e) => {
    if (inCommandMode() || !pop.classList.contains("show")) return;
    if (e.key === "ArrowDown" && rows.length) {
      e.preventDefault();
      setSel((sel + 1) % rows.length);
    } else if (e.key === "ArrowUp" && rows.length) {
      e.preventDefault();
      setSel((sel - 1 + rows.length) % rows.length);
    } else if ((e.key === "Enter" || e.key === "Tab") && sel >= 0) {
      e.preventDefault();
      complete(sel);
    } else if (e.key === "Escape") {
      pop.classList.remove("show");
    }
  });

  // pointerdown + preventDefault keeps focus on the input (mirrors palette.js)
  opsEl.addEventListener("pointerdown", (e) => {
    const x = e.target.closest(".opx");
    if (x) {
      e.preventDefault();
      removeOp(x.dataset.raw);
      return;
    }
    const row = e.target.closest(".opsug");
    if (row) {
      e.preventDefault();
      complete(parseInt(row.dataset.i, 10));
    }
  });
}
