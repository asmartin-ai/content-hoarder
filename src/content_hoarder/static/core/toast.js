/* core/toast.js — toast + undo snackbar, leak-free.
   Replaces app.js:61-80 and triage.js:409-415, fixing the listener leak those
   carried (every snackbar() rebuilt #toast's innerHTML and attached a FRESH click
   listener to the new Undo button; stale closures piled up and a raced timer could
   fire an outdated undo). Here the module owns #toast: ONE delegated listener is
   attached at first use, and a single `currentUndo` slot is swapped per call —
   an old undo can never fire after a newer snackbar replaces it. */

import { esc } from "./util.js";

let el = null;
let timer = null;
let currentUndo = null;

function root() {
  if (el) return el;
  el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.hidden = true;
    document.body.appendChild(el);
  }
  el.addEventListener("click", (e) => {
    if (!e.target.closest(".toast-undo")) return;
    const fn = currentUndo;
    currentUndo = null;
    hide();
    if (fn) fn();
  });
  return el;
}

function hide() {
  clearTimeout(timer);
  if (el) el.hidden = true;
}

function show(html, ms) {
  const t = root();
  clearTimeout(timer);
  t.innerHTML = html;
  t.hidden = false;
  timer = setTimeout(() => { t.hidden = true; currentUndo = null; }, ms);
}

export function toast(msg) {
  currentUndo = null;
  show(esc(msg), 4000);
}

/* Gmail-style snackbar with an Undo affordance. */
export function snackbar(msg, undoFn) {
  currentUndo = undoFn || null;
  show(esc(msg) + (undoFn ? ' <button class="toast-undo" type="button">Undo</button>' : ""), 5000);
}
