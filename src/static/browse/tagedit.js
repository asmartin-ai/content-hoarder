import { esc } from "../core/util.js";
import { normTag, suggestTags } from "../core/tags.js";
import * as api from "../core/api.js";
import { toast } from "../core/toast.js";

const isPhone = () => window.matchMedia("(max-width:700px)").matches;

const _RECENT_KEY = "ch_recent_tags";

const _recentTags = () => {
  try {
    return JSON.parse(localStorage.getItem(_RECENT_KEY)) || [];
  } catch {
    return [];
  }
};

const _pushRecent = (tag) => {
  const n = normTag(tag);

  if (!n) return;
  const list = _recentTags().filter((t) => t !== n);
  list.unshift(n);
  localStorage.setItem(_RECENT_KEY, JSON.stringify(list.slice(0, 20)));
};

const _CAT_RECENT_KEY = "ch_recent_categories";

const _recentCategories = () => {
  try {
    return JSON.parse(localStorage.getItem(_CAT_RECENT_KEY)) || [];
  } catch {
    return [];
  }
};

const _pushRecentCategory = (cat) => {
  const n = normTag(cat);

  if (!n) return;
  const list = _recentCategories().filter((c) => c !== n);
  list.unshift(n);
  localStorage.setItem(_CAT_RECENT_KEY, JSON.stringify(list.slice(0, 20)));
};

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

  let curFn = null;
  let curTags = [];
  let manualSet = new Set();
  let selIdx = 0;
  let busy = false;

  const isOpen = () => !pop.hidden;

  const onResize = () => {
    if (!isPhone()) close();
  };

  function close() {
    if (!isOpen()) return;
    pop.hidden = true;
    scrim.hidden = true;
    pop.innerHTML = "";
    curFn = null;
    curTags = [];
    manualSet = new Set();
    selIdx = 0;
    document.removeEventListener("keydown", onKeydown, true);
    window.removeEventListener("resize", onResize);
  }

  function onKeydown(e) {
    if (!isOpen()) return;

    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  }

  function options() {
    const input = pop.querySelector(".tp-input");
    const q = normTag(input ? input.value : "");

    if (!q) {
      const applied = new Set(curTags.map(normTag));

      const cats = _recentCategories()
        .filter((c) => !applied.has(c))
        .slice(0, 2)
        .map((t) => ({ tag: t, create: false, kind: "category" }));

      const tagsNeeded = Math.max(0, 3 - cats.length);

      const tags = _recentTags()
        .filter((t) => !applied.has(t))
        .filter((t) => !cats.some((c) => c.tag === t))
        .slice(0, tagsNeeded)
        .map((t) => ({ tag: t, create: false, kind: "tag" }));

      return [...cats, ...tags];
    }

    const known = getKnownTags();

    const opts = suggestTags(known, curTags, q).map((t) => ({
      tag: t,
      create: false,
    }));

    const applied = new Set(curTags.map(normTag));
    const exists = applied.has(q) || known.some((t) => normTag(t) === q);

    if (!exists) opts.push({ tag: q, create: true });

    return opts;
  }

  function renderSuggest() {
    const box = pop.querySelector(".tp-sugg");

    if (!box) return;
    const opts = options();

    if (selIdx >= opts.length) selIdx = Math.max(0, opts.length - 1);

    if (!opts.length) {
      box.hidden = true;
      box.innerHTML = "";

      return;
    }

    box.hidden = false;
    box.innerHTML = opts
      .map(
        (o, i) =>
          '<button type="button" class="tp-opt' +
          (i === selIdx ? " sel" : "") +
          '" data-opt="' +
          esc(o.tag) +
          '" data-create="' +
          (o.create ? "1" : "") +
          '" data-kind="' +
          (o.kind || "") +
          '">' +
          (o.create ? '<span class="tp-new">create</span> ' : "") +
          (o.kind === "category" ? '<span class="tp-kind">cat</span> ' : "") +
          esc(o.tag) +
          "</button>",
      )
      .join("");
  }

  function editableTags() {
    const known = new Set(getKnownTags().map(normTag));

    return curTags.filter((t) => known.has(normTag(t)) || manualSet.has(normTag(t)));
  }

  function render() {
    const shown = editableTags();

    const chips = shown.length
      ? shown
          .map(
            (t) =>
              '<span class="tp-chip">' +
              esc(t) +
              '<button type="button" class="tp-rm" data-rm="' +
              esc(t) +
              '" aria-label="Remove ' +
              esc(t) +
              '">&#10005;</button></span>',
          )
          .join("")
      : '<span class="tp-empty">No tags yet.</span>';

    pop.innerHTML =
      '<div class="tp-head"><span class="tp-title">Tags</span>' +
      '<button type="button" class="tp-x" data-tp="close" aria-label="Close">&#10005;</button></div>' +
      '<div class="tp-chips">' +
      chips +
      "</div>" +
      '<input type="search" class="tp-input" placeholder="add or create a tag&hellip;" ' +
      'autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="done" aria-label="Add a tag">' +
      '<div class="tp-sugg" hidden></div>';
    selIdx = 0;
    renderSuggest();
  }

  async function commit(body, { focus = true } = {}) {
    if (busy || !curFn) return;
    busy = true;
    pop.classList.add("busy");

    try {
      const r = await api.postJSON("/items/" + encodeURIComponent(curFn) + "/tags", body);

      curTags = r.tags || [];
      (body.add || []).forEach((t) => {
        manualSet.add(normTag(t));
        _pushRecent(t);
      });
      (body.remove || []).forEach((t) => manualSet.delete(normTag(t)));
      onChange(curFn, curTags);

      if (isPhone()) {
        close();

        return;
      }

      const fn = curFn;
      render();

      if (focus) {
        const input = pop.querySelector(".tp-input");

        if (input && fn === curFn) input.focus();
      }
    } catch {
      toast("Tag didn't save — try again.");
    }
  }

  const add = (tag, opts) => {
    const t = (tag || "").trim();

    if (t) commit({ add: [t] }, opts);
  };

  const remove = (tag) => commit({ remove: [tag] });

  pop.addEventListener("click", (e) => {
    if (e.target.closest('[data-tp="close"]')) {
      close();

      return;
    }

    const rm = e.target.closest(".tp-rm");

    if (rm) {
      remove(rm.dataset.rm);

      return;
    }

    const opt = e.target.closest(".tp-opt");

    if (opt) {
      add(opt.dataset.opt, { focus: false });
      const input = pop.querySelector(".tp-input");

      if (input) input.value = "";

      return;
    }
  });
  pop.addEventListener("input", (e) => {
    if (!e.target.classList.contains("tp-input")) return;
    selIdx = 0;
    renderSuggest();
  });
  pop.addEventListener("keydown", (e) => {
    if (!e.target.classList.contains("tp-input")) return;
    const opts = options();

    if (e.key === "ArrowDown") {
      e.preventDefault();
      selIdx = Math.min(opts.length - 1, selIdx + 1);
      renderSuggest();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      selIdx = Math.max(0, selIdx - 1);
      renderSuggest();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const pick = opts[selIdx];

      if (pick) {
        add(pick.tag);
        e.target.value = "";
      } else add(e.target.value);
    }
  });
  scrim.addEventListener("click", close);

  function position(anchor) {
    pop.classList.toggle("sheet", isPhone());

    if (isPhone()) {
      pop.style.left = pop.style.top = "";

      return;
    }

    const r =
      anchor && anchor.getBoundingClientRect
        ? anchor.getBoundingClientRect()
        : { left: 24, bottom: 80 };

    const W = 280,
      pad = 8;

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
    manualSet = new Set(((item.metadata || {}).tags_manual || []).map(normTag));
    const cat = (item.metadata || {}).category;

    if (cat) _pushRecentCategory(cat);
    scrim.hidden = false;
    pop.hidden = false;
    render();
    position(anchor);
    document.addEventListener("keydown", onKeydown, true);
    window.addEventListener("resize", onResize);
    setTimeout(() => {
      const i = pop.querySelector(".tp-input");

      if (i && !isPhone()) i.focus();
    }, 30);
  }

  return { open, close };
}
