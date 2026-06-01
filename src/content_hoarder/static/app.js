/* Browse / list page: search, filters, source sidebar, per-item + bulk triage,
   stats modal, import, PWA registration. */
(function () {
  "use strict";

  const esc = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

  const ago = (ts) => {
    if (!ts) return "";
    const s = Math.floor(Date.now() / 1000 - ts);
    if (s < 0) return "";
    if (s < 60) return s + "s";
    if (s < 3600) return Math.floor(s / 60) + "m";
    if (s < 86400) return Math.floor(s / 3600) + "h";
    if (s < 2592000) return Math.floor(s / 86400) + "d";
    if (s < 31536000) return Math.floor(s / 2592000) + "mo";
    return Math.floor(s / 31536000) + "y";
  };

  const getJSON = (url, opts) =>
    fetch(url, opts).then((r) => (r.ok ? r.json() : Promise.reject(r)));

  const debounce = (fn, ms) => {
    let t;
    return function () { clearTimeout(t); t = setTimeout(fn, ms); };
  };

  const thumb = (item) => {
    const m = item.metadata || {};
    if (m.thumbnail) return m.thumbnail;
    const url = item.url || "";
    if (/\.(png|jpe?g|gif|webp)$/i.test(url)) return url;
    const yt = url.match(/(?:v=|youtu\.be\/|\/shorts\/)([\w-]{6,})/);
    return yt ? "https://i.ytimg.com/vi/" + yt[1] + "/hqdefault.jpg" : "";
  };

  let toastTimer = null;
  const toast = (msg) => {
    const t = document.getElementById("toast");
    clearTimeout(toastTimer);
    t.textContent = msg;
    t.hidden = false;
    toastTimer = setTimeout(() => { t.hidden = true; }, 4000);
  };

  let offset = 0, activeSource = "", loading = false;
  const sources = {};
  const selected = new Set();

  const badgeHtml = (item) => {
    const s = sources[item.source] || { label: item.source, badge_color: "#888" };
    return '<span class="badge" style="--c:' + esc(s.badge_color) + '">' + esc(s.label) + "</span>";
  };

  const metaLine = (item) => {
    const m = item.metadata || {};
    const parts = [];
    if (item.author) parts.push("by " + esc(item.author));
    if (m.subreddit) parts.push("r/" + esc(m.subreddit));
    if (m.channel) parts.push(esc(m.channel));
    if (m.playlist) parts.push(esc(m.playlist));
    if (item.kind) parts.push(esc(item.kind));
    if (Number.isFinite(m.score)) parts.push(Math.round(m.score) + " pts");
    return parts.join(" · ");
  };

  const itemHtml = (item) => {
    const t = thumb(item);
    const titleHtml = item.url
      ? '<a class="item-title" href="' + esc(item.url) + '" target="_blank" rel="noopener">' + esc(item.title || item.url) + "</a>"
      : '<span class="item-title">' + esc(item.title || item.fullname) + "</span>";
    return '<div class="item" data-fullname="' + esc(item.fullname) + '">' +
      '<input type="checkbox" class="sel">' +
      '<div class="item-main">' +
        '<div class="item-head">' + badgeHtml(item) +
          '<span class="item-age">' + esc(ago(item.created_utc || item.first_seen_utc)) + "</span></div>" +
        titleHtml +
        '<div class="item-meta">' + metaLine(item) + "</div>" +
        (item.body ? '<div class="item-snippet">' + esc(item.body.slice(0, 240)) + "</div>" : "") +
      "</div>" +
      (t ? '<img class="item-thumb" loading="lazy" src="' + esc(t) + '" alt="">' : "") +
      '<div class="item-actions">' +
        '<button data-act="keep">Keep</button>' +
        '<button data-act="archived">Archive</button>' +
        '<button data-act="done">Done</button>' +
      "</div></div>";
  };

  const buildQuery = () => {
    const p = new URLSearchParams();
    const q = document.getElementById("q").value.trim();
    if (q) p.set("q", q);
    if (document.getElementById("fuzzy").checked) p.set("fuzzy", "1");
    const status = document.getElementById("status-filter").value;
    if (status) p.set("status", status);
    p.set("sort", document.getElementById("sort").value);
    if (activeSource) p.set("source", activeSource);
    p.set("limit", "50");
    p.set("offset", String(offset));
    return p.toString();
  };

  const load = (reset) => {
    if (loading) return;
    loading = true;
    const box = document.getElementById("items");
    if (reset) { offset = 0; box.innerHTML = ""; }
    getJSON("/items?" + buildQuery()).then((data) => {
      (data.items || []).forEach((it) => box.insertAdjacentHTML("beforeend", itemHtml(it)));
      document.getElementById("empty").hidden = box.querySelector(".item") !== null;
      document.getElementById("loadmore").hidden = !data.has_more;
      offset += (data.items || []).length;
    }).catch(() => {}).finally(() => { loading = false; });
  };

  const loadSources = () => {
    getJSON("/sources").then((data) => {
      const ul = document.getElementById("source-list");
      ul.innerHTML = "";
      Object.keys(sources).forEach((k) => delete sources[k]);
      const all = document.createElement("li");
      all.dataset.source = "";
      all.innerHTML = "<span>All</span>";
      all.classList.toggle("active", activeSource === "");
      ul.appendChild(all);
      (data.sources || []).filter((s) => s.count > 0).forEach((s) => {
        sources[s.id] = { label: s.label, badge_color: s.badge_color };
        const li = document.createElement("li");
        li.dataset.source = s.id;
        li.innerHTML = '<span><span class="dot" style="background:' + esc(s.badge_color) +
          '"></span> ' + esc(s.label) + '</span><span class="cnt">' + s.count + "</span>";
        li.classList.toggle("active", activeSource === s.id);
        ul.appendChild(li);
      });
    }).catch(() => {});
  };

  const renderStats = (data) => {
    const body = document.getElementById("stats-body");
    const rows = [
      ["Total", data.total], ["Inbox", data.inbox],
      ["Processed this week", data.processed_this_week],
      ["With link", data.with_url],
    ];
    body.innerHTML = rows.map((r) =>
      '<div class="bar-row"><span>' + esc(r[0]) + "</span><span>" + (r[1] || 0) + "</span></div>"
    ).join("");
    const section = (title, obj) => {
      const entries = Object.entries(obj || {});
      if (!entries.length) return;
      const max = Math.max.apply(null, entries.map((e) => e[1]).concat(1));
      body.insertAdjacentHTML("beforeend", "<h3>" + esc(title) + "</h3>");
      entries.forEach(([k, v]) => {
        body.insertAdjacentHTML("beforeend",
          '<div class="bar-row"><span>' + esc(k) + "</span>" +
          '<div class="bar" style="width:' + Math.round((v / max) * 180) + 'px"></div>' +
          "<span>" + v + "</span></div>");
      });
    };
    section("By source", data.by_source);
    section("By status", data.by_status);
  };

  // -- event wiring (script is at end of <body>, DOM is ready) --
  document.getElementById("items").addEventListener("click", (e) => {
    const row = e.target.closest(".item");
    if (!row) return;
    const fullname = row.dataset.fullname;
    const actBtn = e.target.closest("[data-act]");
    if (actBtn) {
      const status = actBtn.dataset.act;
      getJSON("/items/" + encodeURIComponent(fullname) + "/status", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: status }),
      }).then(() => {
        const sf = document.getElementById("status-filter").value;
        if (sf && sf !== status) row.remove();
        toast("Marked " + status);
      }).catch(() => toast("Failed"));
      return;
    }
    if (e.target.classList.contains("sel")) {
      if (e.target.checked) selected.add(fullname);
      else selected.delete(fullname);
      document.getElementById("bulkbar").hidden = selected.size === 0;
      document.getElementById("sel-count").textContent = selected.size + " selected";
    }
  });

  document.querySelectorAll("[data-bulk]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!selected.size) return;
      getJSON("/bulk/status", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fullnames: Array.from(selected), status: btn.dataset.bulk }),
      }).then(() => {
        toast("Bulk marked " + btn.dataset.bulk);
        selected.clear();
        document.getElementById("bulkbar").hidden = true;
        load(true);
      }).catch(() => {});
    });
  });

  document.getElementById("sel-clear").addEventListener("click", () => {
    selected.clear();
    document.querySelectorAll(".item .sel").forEach((cb) => { cb.checked = false; });
    document.getElementById("bulkbar").hidden = true;
  });

  document.getElementById("source-list").addEventListener("click", (e) => {
    const li = e.target.closest("li");
    if (!li) return;
    activeSource = li.dataset.source || "";
    document.querySelectorAll("#source-list li").forEach((x) => x.classList.remove("active"));
    li.classList.add("active");
    load(true);
  });

  document.getElementById("btn-stats").addEventListener("click", () => {
    getJSON("/stats").then(renderStats).catch(() => {});
    document.getElementById("stats-modal").hidden = false;
  });
  document.getElementById("stats-close").addEventListener("click", () => {
    document.getElementById("stats-modal").hidden = true;
  });
  document.getElementById("stats-modal").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) e.currentTarget.hidden = true;
  });

  // -- duplicates review --
  let dupGroups = [];
  const renderDupes = () => {
    const body = document.getElementById("dup-body");
    if (!dupGroups.length) { body.innerHTML = '<p class="empty">No duplicate groups 🎉</p>'; return; }
    body.innerHTML = dupGroups.map((g, gi) =>
      '<div class="dup-group">' +
        g.items.map((it) =>
          '<label class="dup-item"><input type="radio" name="dg' + gi + '" value="' + esc(it.fullname) + '"' +
          (it.fullname === g.suggested_keep ? " checked" : "") + "> " + badgeHtml(it) +
          ' <span class="dup-title">' + esc(it.title || it.url || it.fullname) + "</span></label>"
        ).join("") +
        '<button class="btn primary dup-resolve" data-gi="' + gi + '">Keep selected · archive ' +
        (g.count - 1) + " other(s)</button></div>"
    ).join("");
  };
  const loadDupes = () => {
    getJSON("/duplicates?by=" + document.getElementById("dup-by").value)
      .then((data) => { dupGroups = data.groups || []; renderDupes(); })
      .catch(() => {});
  };
  document.getElementById("btn-dupes").addEventListener("click", () => {
    document.getElementById("dup-modal").hidden = false;
    loadDupes();
  });
  document.getElementById("dup-close").addEventListener("click", () => {
    document.getElementById("dup-modal").hidden = true;
  });
  document.getElementById("dup-modal").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) e.currentTarget.hidden = true;
  });
  document.getElementById("dup-by").addEventListener("change", loadDupes);
  document.getElementById("dup-body").addEventListener("click", (e) => {
    const btn = e.target.closest(".dup-resolve");
    if (!btn) return;
    const gi = +btn.dataset.gi;
    const g = dupGroups[gi];
    if (!g) return;
    const sel = document.querySelector('input[name="dg' + gi + '"]:checked');
    const keep = sel ? sel.value : g.suggested_keep;
    const archive = g.items.map((it) => it.fullname).filter((fn) => fn !== keep);
    getJSON("/duplicates/resolve", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keep: keep, archive: archive }),
    }).then(() => {
      toast("Archived " + archive.length + " duplicate(s)");
      dupGroups.splice(gi, 1);
      renderDupes();
      load(true);
      loadSources();
    }).catch(() => toast("Failed"));
  });

  document.getElementById("btn-import").addEventListener("click", () =>
    document.getElementById("import-file").click());
  document.getElementById("import-file").addEventListener("change", (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const fd = new FormData();
    fd.append("file", f);
    fetch("/import", { method: "POST", body: fd }).then((r) => r.json()).then((d) => {
      toast(d.error ? "Import error: " + d.error : "Imported " + d.imported + " (skipped " + d.skipped + ")");
      loadSources();
      load(true);
    }).catch(() => {}).finally(() => { e.target.value = ""; });
  });

  document.getElementById("q").addEventListener("input", debounce(() => load(true), 250));
  document.getElementById("fuzzy").addEventListener("change", () => load(true));
  document.getElementById("status-filter").addEventListener("change", () => load(true));
  document.getElementById("sort").addEventListener("change", () => load(true));
  document.getElementById("loadmore").addEventListener("click", () => load(false));

  if ("serviceWorker" in navigator)
    navigator.serviceWorker.register("/static/sw.js").catch(() => {});
  if (/Android|Mobi/i.test(navigator.userAgent) &&
      !window.matchMedia("(display-mode: standalone)").matches) {
    document.getElementById("install-hint").hidden = false;
  }

  loadSources();
  load(true);
})();
