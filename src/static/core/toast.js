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
  timer = setTimeout(() => {
    t.hidden = true;
    currentUndo = null;
  }, ms);
}

export function toast(msg) {
  currentUndo = null;
  show(esc(msg), 4000);
}

export function snackbar(msg, undoFn) {
  currentUndo = undoFn || null;
  show(esc(msg) + (undoFn ? ' <button class="toast-undo" type="button">Undo</button>' : ""), 5000);
}
