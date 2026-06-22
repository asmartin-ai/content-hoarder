/* browse/tagedit.js — per-item manual tag editor (Epic 5/26 P2, browse surface).

   A single reusable popover: shows an item's current tags as removable chips and an
   autocomplete input that adds an existing tag OR creates a new one on the fly. Posts
   to the (already-merged) POST /items/<fn>/tags endpoint, which stamps adds in
   metadata.tags_manual so a re-categorize / re-import can't clobber them.

   Display of tags stays in core/render.js `tagChips()` (shared with the triage/reader
   surfaces GLM owns) — this module only EDITS, so the two never collide. Desktop:
   anchored popover. Mobile (≤700px): bottom sheet. Own backdrop catches outside-clicks. */

import { esc } from "../core/util.js";
import * as api from "../core/api.js";
import { toast } from "../core/toast.js";

const isPhone = () => window.matchMedia("(max-width:700px)").matches;
const norm = (t) => t.trim().toLowerCase();

export function initTagEditor({ getItem, getKnownTags, onChange }) {
  const scrim = document.createElement("div");
  scrim.className = "tagpop-scrim";
  scrim.hidden = true;
  const pop = document.createElement("div");
  pop.className = "tagpop";
  pop.id = "tagpop";
  pop.hidden = true;
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", "Edit tags");
  document.body.append(scrim, pop);

  let curFn = null;        // the item being edited
  let curTags = [];        // local working copy (kept in sync with the server's returned list)
  let selIdx = 0;          // highlighted suggestion option
  let busy = false;        // single-flight guard so a double-tap can't double-post

  const isOpen = () => !pop.hidden;

  function close() {
    if (!isOpen()) return;
    pop.hidden = true; scrim.hidden = true;
    pop.innerHTML = "";
    curFn = null; curTags = []; selIdx = 0;
    document.removeEventListener("keydown", onKeydown, true);
    window.removeEventListener("resize", close);
  }

  function onKeydown(e) {
    if (!isOpen()) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
  }

  /* the visible suggestion options for the current input: matching known tags first,
     then a "create new" option when the typed text isn't already an exact tag. */
  function options() {
    const input = pop.querySelector(".tp-input");
    const q = input ? norm(input.value) : "";
    const applied = new Set(curTags.map(norm));
    const known = getKnownTags().filter((t) => !applied.has(norm(t)));
    const matches = (q ? known.filter((t) => norm(t).includes(q)) : known).slice(0, 8);
    const opts = matches.map((t) => ({ tag: t, create: false }));
    const exists = !q || applied.has(q) || known.some((t) => norm(t) === q);
    if (q && !exists) opts.push({ tag: q, create: true });
    return opts;
  }

  function renderSuggest() {
    const box = pop.querySelector(".tp-sugg");
    if (!box) return;
    const opts = options();
    if (selIdx >= opts.length) selIdx = Math.max(0, opts.length - 1);
    if (!opts.length) { box.hidden = true; box.innerHTML = ""; return; }
    box.hidden = false;
    box.innerHTML = opts.map((o, i) =>
      '<button type="button" class="tp-opt' + (i === selIdx ? " sel" : "") +
      '" data-opt="' + esc(o.tag) + '" data-create="' + (o.create ? "1" : "") + '">' +
      (o.create ? '<span class="tp-new">create</span> ' : "") + esc(o.tag) + "</button>"
    ).join("");
  }

  function render() {
    const chips = curTags.length
      ? curTags.map((t) =>
          '<span class="tp-chip">' + esc(t) +
          '<button type="button" class="tp-rm" data-rm="' + esc(t) +
          '" aria-label="Remove ' + esc(t) + '">&#10005;</button></span>').join("")
      : '<span class="tp-empty">No tags yet.</span>';
    pop.innerHTML =
      '<div class="tp-head"><span class="tp-title">Tags</span>' +
      '<button type="button" class="tp-x" data-tp="close" aria-label="Close">&#10005;</button></div>' +
      '<div class="tp-chips">' + chips + "</div>" +
      '<input type="text" class="tp-input" placeholder="add or create a tag&hellip;" ' +
      'autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Add a tag">' +
      '<div class="tp-sugg" hidden></div>';
    selIdx = 0;
    renderSuggest();
  }

  async function commit(body) {
    if (busy || !curFn) return;
    busy = true;
    pop.classList.add("busy");
    try {
      const r = await api.postJSON("/items/" + encodeURIComponent(curFn) + "/tags", body);
      curTags = r.tags || [];
      onChange(curFn, curTags);          // let the page sync state + rail
      const fn = curFn;
      render();                          // rebuild chips + suggestions
      const input = pop.querySelector(".tp-input");
      if (input && fn === curFn) input.focus();
    } catch (e) {
      toast("Tag didn't save — try again.");
    } finally {
      busy = false;
      pop.classList.remove("busy");
    }
  }

  const add = (tag) => { const t = (tag || "").trim(); if (t) commit({ add: [t] }); };
  const remove = (tag) => commit({ remove: [tag] });

  pop.addEventListener("click", (e) => {
    if (e.target.closest('[data-tp="close"]')) { close(); return; }
    const rm = e.target.closest(".tp-rm");
    if (rm) { remove(rm.dataset.rm); return; }
    const opt = e.target.closest(".tp-opt");
    if (opt) {
      add(opt.dataset.opt);
      const input = pop.querySelector(".tp-input");
      if (input) input.value = "";
      return;
    }
  });
  pop.addEventListener("input", (e) => {
    if (!e.target.classList.contains("tp-input")) return;
    selIdx = 0; renderSuggest();
  });
  pop.addEventListener("keydown", (e) => {
    if (!e.target.classList.contains("tp-input")) return;
    const opts = options();
    if (e.key === "ArrowDown") { e.preventDefault(); selIdx = Math.min(opts.length - 1, selIdx + 1); renderSuggest(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); selIdx = Math.max(0, selIdx - 1); renderSuggest(); }
    else if (e.key === "Enter") {
      e.preventDefault();
      const pick = opts[selIdx];
      if (pick) { add(pick.tag); e.target.value = ""; }
      else add(e.target.value);          // no suggestions (e.g. exact dup typed) → try the raw text
    }
  });
  scrim.addEventListener("click", close);

  function position(anchor) {
    pop.classList.toggle("sheet", isPhone());
    if (isPhone()) { pop.style.left = pop.style.top = ""; return; }
    // desktop: anchor below the trigger, clamped to the viewport
    const r = (anchor && anchor.getBoundingClientRect)
      ? anchor.getBoundingClientRect() : { left: 24, bottom: 80 };
    const W = 280, pad = 8;
    let left = Math.min(r.left, window.innerWidth - W - pad);
    left = Math.max(pad, left);
    pop.style.left = left + "px";
    pop.style.top = Math.min(r.bottom + 6, window.innerHeight - 60) + "px";
  }

  function open(fullname, anchor) {
    const item = getItem(fullname);
    if (!item) return;
    close();
    curFn = fullname;
    curTags = ((item.metadata || {}).tags || []).slice();
    scrim.hidden = false;
    pop.hidden = false;
    render();
    position(anchor);
    document.addEventListener("keydown", onKeydown, true);
    window.addEventListener("resize", close);
    setTimeout(() => { const i = pop.querySelector(".tp-input"); if (i && !isPhone()) i.focus(); }, 30);
  }

  return { open, close };
}
