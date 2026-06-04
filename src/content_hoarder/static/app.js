/* Browse / list page: search, filters, source sidebar, per-item + bulk triage,
   stats modal, import, PWA registration. */
(function () {
  "use strict";

  const esc = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

  // Only allow http(s) or root-relative URLs in href (blocks javascript:/data: sinks).
  const safeUrl = (u) => (/^(https?:\/\/|\/)/i.test(u || "") ? u : "");

  // Removed/deleted Reddit posts — incl. admin/mod removals ("[ Removed by reddit … ]")
  // and "Deleted by user", not just the bare "[removed]"/"[deleted]" placeholders.
  const _rmStart = /^\s*\[\s*(removed|deleted)/i;
  const _rmPhrase = /\b(removed by (reddit|a moderator|the moderators|moderator)|deleted by user)\b/i;
  const isRemovedText = (s) => _rmStart.test(s || "") || _rmPhrase.test(s || "");
  const isRemoved = (item) => item.source === "reddit" &&
    (isRemovedText(item.body) || isRemovedText(item.title));

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
  // Gmail-style snackbar with an Undo affordance.
  const snackbar = (msg, undoFn) => {
    const t = document.getElementById("toast");
    clearTimeout(toastTimer);
    t.innerHTML = esc(msg) + (undoFn ? ' <button class="toast-undo" type="button">Undo</button>' : "");
    t.hidden = false;
    if (undoFn) t.querySelector(".toast-undo").addEventListener("click", () => {
      t.hidden = true;
      undoFn();
    });
    toastTimer = setTimeout(() => { t.hidden = true; }, 5000);
  };

  // Reddit's blockquote + platform.js embed was retired (the script now 404s), so embed the
  // official redditmedia.com iframe directly. Online-only; the permalink link is the fallback.
  const redditEmbedUrl = (permalink) => {
    const base = (permalink || "").split("#")[0].split("?")[0]
      .replace(/^https?:\/\/([a-z0-9-]+\.)?reddit\.com/i, "https://www.redditmedia.com");
    return base + "?ref_source=embed&ref=share&embed=true&theme=dark";
  };
  const openMedia = (permalink) => {
    if (!safeUrl(permalink)) return;
    document.getElementById("media-body").innerHTML =
      '<iframe class="reddit-embed-frame" src="' + esc(redditEmbedUrl(permalink)) + '" loading="lazy"></iframe>' +
      '<a class="media-fallback" href="' + esc(permalink) + '" target="_blank" rel="noopener">Open on Reddit ↗</a>';
    document.getElementById("media-modal").hidden = false;
  };
  // Image posts open a simple lightbox (reliable; no Reddit dependency).
  const openImage = (url) => {
    if (!safeUrl(url)) return;
    document.getElementById("media-body").innerHTML =
      '<img class="media-img" src="' + esc(url) + '" alt="">' +
      '<a class="media-fallback" href="' + esc(url) + '" target="_blank" rel="noopener">Open original ↗</a>';
    document.getElementById("media-modal").hidden = false;
  };
  // Gallery posts (metadata.gallery from the archive's media_metadata) → stacked lightbox.
  const openGallery = (urls) => {
    const imgs = (urls || []).filter(safeUrl);
    if (!imgs.length) return;
    document.getElementById("media-body").innerHTML =
      '<div class="media-gallery">' +
      imgs.map((u) => '<img class="media-img gallery-img" loading="lazy" src="' + esc(u) + '" alt="">').join("") +
      "</div>" + '<p class="media-fallback">' + imgs.length + " images</p>";
    document.getElementById("media-modal").hidden = false;
  };
  const closeMedia = () => {
    document.getElementById("media-modal").hidden = true;
    document.getElementById("media-body").innerHTML = "";  // stop playback
  };

  let offset = 0, activeSource = "", activeStatus = "inbox", loading = false;
  const sources = {};
  const selected = new Set();

  const badgeHtml = (item) => {
    const s = sources[item.source] || { label: item.source, badge_color: "#888" };
    return '<span class="badge" style="--c:' + esc(s.badge_color) + '">' + esc(s.label) + "</span>";
  };

  // Full image URL to open in a lightbox (direct images / i.redd.it), else "".
  const IMG_EXT = /\.(png|jpe?g|gif|webp|bmp)(\?|#|$)/i;
  const imageUrl = (item) => {
    const m = item.metadata || {};
    const u = item.url || "";
    if (IMG_EXT.test(u) || /i\.redd\.it\//i.test(u)) return u;
    return m.media_type === "image" ? (m.media_url || "") : "";
  };
  // YouTube upload date as YYYY-MM-DD (from enrich's upload_date, else created_utc).
  const uploadDate = (item) => {
    const m = item.metadata || {};
    if (typeof m.upload_date === "string" && /^\d{8}$/.test(m.upload_date))
      return m.upload_date.slice(0, 4) + "-" + m.upload_date.slice(4, 6) + "-" + m.upload_date.slice(6, 8);
    if (item.created_utc) return new Date(item.created_utc * 1000).toISOString().slice(0, 10);
    return "";
  };

  const metaLine = (item) => {
    const m = item.metadata || {};
    const parts = [];
    if (item.author) parts.push("by " + esc(item.author));
    if (m.subreddit) parts.push("r/" + esc(m.subreddit));
    if (m.channel) parts.push(esc(m.channel));
    if (m.playlist) parts.push(esc(m.playlist));
    if (item.source === "youtube") { const ud = uploadDate(item); if (ud) parts.push("📅 " + ud); }
    if (item.kind) parts.push(esc(item.kind));
    if (m.category && m.category !== "unknown") parts.push("🏷 " + esc(m.category));
    if (Number.isFinite(m.score)) parts.push(Math.round(m.score) + " pts");
    return parts.join(" · ");
  };

  const PREVIEW_TYPES = { reddit_video: "▶ Play", reddit_media: "▶ Preview", gallery: "🖼 Gallery" };
  // When the archive captured the gallery images, carry them so the click opens an inline
  // lightbox instead of the Reddit embed. (No-op string for non-gallery items.)
  const galleryAttr = (m) => (Array.isArray(m.gallery) && m.gallery.length)
    ? ' data-gallery="' + esc(JSON.stringify(m.gallery)) + '"' : "";
  // Right-hand media slot: a thumbnail when we have one, else a click-to-load
  // Reddit preview button for media posts whose media URL wasn't captured.
  const mediaSlotHtml = (item) => {
    const m = item.metadata || {};
    const t = thumb(item);
    if (t) {
      const full = imageUrl(item);
      if (full) {                                         // direct image → open in lightbox
        return '<img class="item-thumb img-open" loading="lazy" src="' + esc(t) +
          '" data-img="' + esc(full) + '" alt="">';
      }
      if (item.source === "reddit" && PREVIEW_TYPES[m.media_type]) {  // video/gallery → permalink embed
        const permalink = m.permalink || item.url || "";
        return '<img class="item-thumb rd-preview" loading="lazy" src="' + esc(t) +
          '" data-permalink="' + esc(permalink) + '"' + galleryAttr(m) + ' alt="">';
      }
      return '<img class="item-thumb" loading="lazy" src="' + esc(t) + '" alt="">';
    }
    const mt = m.media_type;
    if (item.source === "reddit" && PREVIEW_TYPES[mt]) {
      const permalink = m.permalink || item.url || "";
      const label = /\/gallery\//i.test(item.url || "") ? "🖼 Gallery" : PREVIEW_TYPES[mt];
      return '<button class="item-thumb rd-preview" type="button" data-permalink="' +
        esc(permalink) + '"' + galleryAttr(m) + ">" + label + "</button>";
    }
    return "";
  };

  const itemHtml = (item) => {
    const titleHtml = safeUrl(item.url)
      ? '<a class="item-title" href="' + esc(item.url) + '" target="_blank" rel="noopener">' + esc(item.title || item.url) + "</a>"
      : '<span class="item-title">' + esc(item.title || item.fullname) + "</span>";
    const recoverBtn = isRemoved(item)
      ? '<button class="recover-btn" data-recover type="button">↻ Recover</button>' : "";
    return '<div class="item" data-fullname="' + esc(item.fullname) + '">' +
      '<div class="item-bg" aria-hidden="true">' +
        '<span class="ic ic-keep">✓ Keep</span>' +
        '<span class="ic ic-arch">Archive 🗑</span>' +
      "</div>" +
      '<div class="item-fg">' +
        '<input type="checkbox" class="sel">' +
        '<div class="item-main">' +
          '<div class="item-head">' + badgeHtml(item) +
            '<span class="item-age">' + esc(ago(item.created_utc || item.first_seen_utc)) + "</span></div>" +
          titleHtml +
          '<div class="item-meta">' + metaLine(item) + "</div>" +
          (item.body ? '<div class="item-snippet">' + esc(item.body.slice(0, 240)) + "</div>" : "") +
        "</div>" +
        mediaSlotHtml(item) +
        '<div class="item-actions">' +
          recoverBtn +
          '<button data-act="keep">Keep</button>' +
          '<button data-act="archived">Archive</button>' +
          '<button data-act="done">Done</button>' +
        "</div>" +
      "</div></div>";
  };

  const buildQuery = () => {
    const p = new URLSearchParams();
    const q = document.getElementById("q").value.trim();
    if (q) p.set("q", q);
    if (document.getElementById("fuzzy").checked) p.set("fuzzy", "1");
    if (activeStatus) p.set("status", activeStatus);
    const sv = document.getElementById("sort").value.split(":");
    p.set("sort", sv[0]);
    p.set("order", sv[1] || "desc");
    const cat = document.getElementById("category").value;
    if (cat) p.set("category", cat);
    // "Firefox tabs" batch is all youtube-source; let it override the active source tab so the
    // batch still shows when you toggle it from e.g. the Reddit tab (instead of an empty list).
    const ffOnly = document.getElementById("ff-tabs").classList.contains("active");
    if (ffOnly) p.set("open_in_firefox", "1");
    if (activeSource && !ffOnly) p.set("source", activeSource);
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
      box.querySelectorAll(".item:not([data-sw])").forEach((row) => {
        row.setAttribute("data-sw", "1");
        if (window.attachSwipe) window.attachSwipe(row, {
          onRight: () => actOnItem(row.dataset.fullname, "keep", row),
          onLeft: () => actOnItem(row.dataset.fullname, "archived", row),
        });
      });
      document.getElementById("empty").hidden = box.querySelector(".item") !== null;
      document.getElementById("loadmore").hidden = !data.has_more;
      offset += (data.items || []).length;
    }).catch(() => {}).finally(() => { loading = false; });
  };

  // Source tabs. Counts are cross-filtered by the active status; the tab list stays
  // stable (every source present in the DB shows, even at 0 for the active status).
  const loadSources = () => {
    const qs = activeStatus ? "?status=" + encodeURIComponent(activeStatus) : "";
    getJSON("/sources" + qs).then((data) => {
      const nav = document.getElementById("source-tabs");
      nav.innerHTML = "";
      Object.keys(sources).forEach((k) => delete sources[k]);
      const list = data.sources || [];
      const total = list.reduce((n, s) => n + (s.count || 0), 0);
      const mkTab = (id, label, color, count) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "tab";
        b.dataset.source = id;
        b.innerHTML = (color ? '<span class="dot" style="background:' + esc(color) + '"></span>' : "") +
          '<span class="tab-label">' + esc(label) + "</span>" +
          (count != null ? '<span class="cnt">' + count + "</span>" : "");
        b.classList.toggle("active", activeSource === id);
        nav.appendChild(b);
      };
      mkTab("", "All", "", total);
      list.forEach((s) => {
        sources[s.id] = { label: s.label, badge_color: s.badge_color };
        mkTab(s.id, s.label, s.badge_color, s.count);
      });
    }).catch(() => {});
  };

  // Sidebar status counts come from /stats, cross-filtered by the active source.
  const loadCounts = () => getJSON("/stats" + (activeSource ? "?source=" + encodeURIComponent(activeSource) : "")).then((d) => {
    const bs = d.by_status || {};
    const set = (k, v) => {
      const el = document.querySelector('[data-cnt="' + k + '"]');
      if (el) el.textContent = v || 0;
    };
    set("inbox", bs.inbox);
    set("keep", bs.keep);
    set("archived", bs.archived);
    set("done", bs.done);
    set("all", d.total);
    // category dropdown = "processing areas" with volume, e.g. "listenable (626)"
    const bc = d.by_category || {};
    document.querySelectorAll("#category option").forEach((o) => {
      if (!o.value) return;
      if (o.dataset.label == null) o.dataset.label = o.textContent;
      o.textContent = bc[o.value] != null ? o.dataset.label + " (" + bc[o.value] + ")" : o.dataset.label;
    });
  }).catch(() => {});
  // An item changing status moves both axes (status counts by source, tab counts by
  // status), so refresh them together.
  const refreshNav = () => { loadCounts(); loadSources(); };
  const refreshNavDebounced = debounce(refreshNav, 600);

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

  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  const toggleSel = (fullname, checked, row) => {
    if (checked) selected.add(fullname); else selected.delete(fullname);
    if (row) row.classList.toggle("selected", checked);
    document.getElementById("bulkbar").hidden = selected.size === 0;
    document.getElementById("sel-count").textContent = selected.size + " selected";
  };

  const undoItem = (fullname) => {
    getJSON("/items/" + encodeURIComponent(fullname) + "/undo", { method: "POST" })
      .then(() => { load(true); loadSources(); loadCounts(); })
      .catch(() => {});
  };

  const actOnItem = (fullname, status, row) => {
    getJSON("/items/" + encodeURIComponent(fullname) + "/status", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: status }),
    }).then(() => {
      selected.delete(fullname);
      if (row && activeStatus && activeStatus !== status) row.remove();
      snackbar(cap(status), () => undoItem(fullname));
      refreshNavDebounced();
    }).catch(() => snackbar("Failed", null));
  };

  // On-demand recovery of a [removed]/[deleted] reddit item from web archives.
  const recoverItem = (fullname, row, btn) => {
    btn.disabled = true;
    btn.textContent = "…";
    getJSON("/items/" + encodeURIComponent(fullname) + "/recover", { method: "POST" })
      .then((d) => {
        if (d && d.recovered) {
          const ttl = row.querySelector(".item-title");
          if (ttl && d.title) ttl.textContent = d.title;
          const main = row.querySelector(".item-main");
          if (d.body && !isRemovedText(d.body) && main) {
            let snip = row.querySelector(".item-snippet");
            if (!snip) {
              snip = document.createElement("div");
              snip.className = "item-snippet";
              main.appendChild(snip);
            }
            snip.textContent = d.body.slice(0, 240);
          }
          btn.textContent = "✓ recovered";
          toast("Recovered from archives");
        } else {
          btn.disabled = false;   // not in archives — let the user try again later
          btn.textContent = "not archived";
        }
      })
      .catch(() => { btn.disabled = false; btn.textContent = "↻ Recover"; });
  };

  // -- event wiring (script is at end of <body>, DOM is ready) --
  document.getElementById("items").addEventListener("click", (e) => {
    const row = e.target.closest(".item");
    if (!row) return;
    const fullname = row.dataset.fullname;
    const actBtn = e.target.closest("[data-act]");
    if (actBtn) { actOnItem(fullname, actBtn.dataset.act, row); return; }
    const recBtn = e.target.closest("[data-recover]");
    if (recBtn) { recoverItem(fullname, row, recBtn); return; }
    const gal = e.target.closest("[data-gallery]");
    if (gal) {
      try { openGallery(JSON.parse(gal.dataset.gallery)); }
      catch (_) { openMedia(gal.dataset.permalink); }
      return;
    }
    const pv = e.target.closest(".rd-preview");
    if (pv) { openMedia(pv.dataset.permalink); return; }
    const imgEl = e.target.closest(".item-thumb.img-open");
    if (imgEl) { openImage(imgEl.dataset.img); return; }
    if (e.target.classList.contains("sel")) { toggleSel(fullname, e.target.checked, row); return; }
    if (e.target.closest("a")) return;                  // let title links open
    const cb = row.querySelector(".sel");               // whole-card click toggles selection
    if (cb) { cb.checked = !cb.checked; toggleSel(fullname, cb.checked, row); }
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
        refreshNav();
      }).catch(() => {});
    });
  });

  document.getElementById("sel-clear").addEventListener("click", () => {
    selected.clear();
    document.querySelectorAll(".item .sel").forEach((cb) => { cb.checked = false; });
    document.getElementById("bulkbar").hidden = true;
  });

  document.getElementById("source-tabs").addEventListener("click", (e) => {
    const tab = e.target.closest("[data-source]");
    if (!tab) return;
    activeSource = tab.dataset.source || "";
    document.querySelectorAll("#source-tabs .tab").forEach((x) => x.classList.remove("active"));
    tab.classList.add("active");
    load(true);
    loadCounts();   // status counts reflect the newly active source
  });

  // status sidebar nav + mobile drawer
  const navToggle = document.getElementById("nav-toggle");
  const sidebar = document.getElementById("sidebar");
  const backdrop = document.getElementById("nav-backdrop");
  const closeDrawer = () => {
    sidebar.classList.remove("open");
    backdrop.hidden = true;
    navToggle.setAttribute("aria-expanded", "false");
  };
  const openDrawer = () => {
    sidebar.classList.add("open");
    backdrop.hidden = false;
    navToggle.setAttribute("aria-expanded", "true");
  };
  navToggle.addEventListener("click", () =>
    (sidebar.classList.contains("open") ? closeDrawer() : openDrawer()));
  backdrop.addEventListener("click", closeDrawer);

  document.getElementById("status-nav").addEventListener("click", (e) => {
    const li = e.target.closest("li");
    if (!li) return;
    activeStatus = li.dataset.status || "";
    document.querySelectorAll("#status-nav li").forEach((x) => x.classList.remove("active"));
    li.classList.add("active");
    closeDrawer();
    load(true);
    loadSources();  // tab counts reflect the newly active status
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
  document.getElementById("media-close").addEventListener("click", closeMedia);
  document.getElementById("media-modal").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeMedia();
  });

  // -- import modal: file OR YouTube URL, with a pre-import count + Confirm --
  const importModal = document.getElementById("import-modal");
  const impUrl = document.getElementById("import-url");
  const impFile = document.getElementById("import-file");
  const impPreview = document.getElementById("import-preview");
  const impStatus = document.getElementById("import-status");
  const impPrepareBtn = document.getElementById("import-prepare");
  const impConfirmBtn = document.getElementById("import-confirm");
  let impToken = null;

  const resetImport = () => {
    impToken = null;
    impPreview.hidden = true;
    impPreview.innerHTML = "";
    impConfirmBtn.hidden = true;
    impConfirmBtn.disabled = false;
    impPrepareBtn.hidden = false;
    impPrepareBtn.disabled = false;
    impStatus.textContent = "";
  };
  const closeImport = () => { importModal.hidden = true; };

  document.getElementById("btn-import").addEventListener("click", () => {
    resetImport();
    impUrl.value = "";
    impFile.value = "";
    importModal.hidden = false;
    closeDrawer();
  });
  document.getElementById("import-close").addEventListener("click", closeImport);
  document.getElementById("import-cancel").addEventListener("click", closeImport);
  importModal.addEventListener("click", (e) => { if (e.target === importModal) closeImport(); });
  // changing an input after a preview invalidates the prepared token
  impUrl.addEventListener("input", resetImport);
  impFile.addEventListener("change", resetImport);

  impPrepareBtn.addEventListener("click", () => {
    const url = impUrl.value.trim();
    const file = impFile.files[0];
    if (!url && !file) { impStatus.textContent = "Choose a file or paste a URL first."; return; }
    impStatus.textContent = url ? "Fetching playlist… (this can take a minute)" : "Reading file…";
    impPrepareBtn.disabled = true;
    let req;
    if (file) {
      const fd = new FormData();
      fd.append("file", file);
      req = fetch("/import/prepare", { method: "POST", body: fd });
    } else {
      req = fetch("/import/prepare", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url }),
      });
    }
    req.then((r) => r.json()).then((d) => {
      if (d.error) { impStatus.textContent = d.error; impPrepareBtn.disabled = false; return; }
      impToken = d.token;
      impStatus.textContent = "";
      const dup = d.count - d.new;
      const sample = (d.sample || [])
        .map((s) => "<li>" + esc(s.title || "(untitled)") + "</li>").join("");
      impPreview.innerHTML = "<p>About to import <b>" + d.count + "</b> item" +
        (d.count === 1 ? "" : "s") + " from <b>" + esc(d.label || d.source) + "</b> — <b>" +
        d.new + "</b> new" + (dup > 0 ? ", " + dup + " already saved" : "") + ".</p>" +
        (sample ? "<ul class='import-sample'>" + sample + "</ul>" : "");
      impPreview.hidden = false;
      impPrepareBtn.hidden = true;
      impConfirmBtn.hidden = false;
    }).catch(() => { impStatus.textContent = "Preview failed."; impPrepareBtn.disabled = false; });
  });

  impConfirmBtn.addEventListener("click", () => {
    if (!impToken) return;
    impConfirmBtn.disabled = true;
    impStatus.textContent = "Importing…";
    fetch("/import/commit", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: impToken }),
    }).then((r) => r.json()).then((d) => {
      if (d.error) { impStatus.textContent = d.error; impConfirmBtn.disabled = false; return; }
      closeImport();
      toast("Imported " + d.imported + (d.skipped ? " (skipped " + d.skipped + ")" : ""));
      loadSources();
      loadCounts();
      load(true);
    }).catch(() => { impStatus.textContent = "Import failed."; impConfirmBtn.disabled = false; });
  });

  document.getElementById("q").addEventListener("input", debounce(() => load(true), 250));
  document.getElementById("fuzzy").addEventListener("change", () => load(true));
  document.getElementById("sort").addEventListener("change", () => load(true));
  document.getElementById("category").addEventListener("change", () => load(true));
  document.getElementById("ff-tabs").addEventListener("click", (e) => {
    const on = e.currentTarget.classList.toggle("active");
    e.currentTarget.setAttribute("aria-pressed", on ? "true" : "false");
    load(true);
  });
  document.getElementById("loadmore").addEventListener("click", () => load(false));

  if ("serviceWorker" in navigator)
    navigator.serviceWorker.register("/static/sw.js").catch(() => {});
  if (/Android|Mobi/i.test(navigator.userAgent) &&
      !window.matchMedia("(display-mode: standalone)").matches) {
    document.getElementById("install-hint").hidden = false;
  }

  loadSources();
  loadCounts();
  load(true);
})();
