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
  const isTypingTarget = (el) => /input|select|textarea/i.test((el && el.tagName) || "");

  const thumb = (item) => {
    const m = item.metadata || {};
    let t = m.thumbnail || "";
    if (!t) {
      const url = item.url || "";
      if (/\.(png|jpe?g|gif|webp)$/i.test(url)) return url;
      const yt = url.match(/(?:v=|youtu\.be\/|\/shorts\/)([\w-]{6,})/);
      t = yt ? "https://i.ytimg.com/vi/" + yt[1] + "/hqdefault.jpg" : "";
    }
    // YouTube hq/sd/default thumbs bake in 4:3 black bars; upgrade i.ytimg URLs to the 16:9
    // maxres (the <img> onerror falls back to mqdefault when a video has no maxres).
    if (/i\.ytimg\.com/.test(t)) t = t.replace(/\/[a-z0-9]+default\.jpg(\?.*)?$/i, "/maxresdefault.jpg");
    return t;
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
  // Reddit permalinks are stored relative ("/r/sub/comments/…"); make them absolute so
  // the embed + the "Open on Reddit" link don't resolve against our own origin.
  const redditUrl = (permalink) => {
    const p = (permalink || "").trim();
    if (!p) return "";
    if (/^https?:\/\//i.test(p)) return p;
    return "https://www.reddit.com" + (p.charAt(0) === "/" ? p : "/" + p);
  };
  const redditEmbedUrl = (permalink) => {
    const base = redditUrl(permalink).split("#")[0].split("?")[0]
      .replace(/^https?:\/\/([a-z0-9-]+\.)?reddit\.com/i, "https://www.redditmedia.com");
    return base + "?ref_source=embed&ref=share&embed=true&theme=dark";
  };
  const openMedia = (permalink) => {
    const url = redditUrl(permalink);
    if (!safeUrl(url)) return;
    document.getElementById("media-body").innerHTML =
      '<iframe class="reddit-embed-frame" src="' + esc(redditEmbedUrl(permalink)) + '" loading="lazy"></iframe>' +
      '<a class="media-fallback" href="' + esc(url) + '" target="_blank" rel="noopener">Open on Reddit ↗</a>';
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
  const shortcutModal = document.getElementById("shortcut-modal");
  const closeShortcuts = () => {
    if (shortcutModal) shortcutModal.hidden = true;
  };
  const toggleShortcuts = () => {
    if (!shortcutModal) return;
    shortcutModal.hidden = !shortcutModal.hidden;
  };

  const headerStack = document.querySelector(".header-stack");
  const syncHeaderHeight = () => {
    if (!headerStack) return;
    document.documentElement.style.setProperty("--header-stack-h", headerStack.offsetHeight + "px");
  };
  if (headerStack && "ResizeObserver" in window) new ResizeObserver(syncHeaderHeight).observe(headerStack);
  window.addEventListener("resize", syncHeaderHeight);
  syncHeaderHeight();

  let offset = 0, activeSource = "", activeStatus = "inbox", loading = false;
  const sources = {};
  const selected = new Set();
  const selectedTags = new Set();   // active tag filter (OR across selected tags)
  const revealedNsfw = new Set();
  const loadedItems = [];           // cache of loaded items, for re-render on density change
  let currentDensity = "comfortable"; // set by applyDensity; itemHtml branches on it (card vs list)

  // ADHD dopamine loop: batch size + triaged-today counter & streak.
  const BATCH = 25;
  const PROGRESS_GOAL = 20;
  const PROGRESS_STORE = "ch-progress";
  const todayKey = () => {
    const now = new Date();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    return now.getFullYear() + "-" + mm + "-" + dd;
  };
  const readTodayTriaged = () => {
    try {
      const raw = localStorage.getItem(PROGRESS_STORE);
      if (!raw) return 0;
      const data = JSON.parse(raw);
      return data && data.day === todayKey() && Number.isFinite(data.count) ? data.count : 0;
    } catch (e) {
      return 0;
    }
  };
  const writeTodayTriaged = (count) => {
    try {
      localStorage.setItem(PROGRESS_STORE, JSON.stringify({ day: todayKey(), count: Math.max(0, count) }));
    } catch (e) {}
  };
  let todayTriaged = readTodayTriaged();
  let streak = 0;
  let inboxCount = 0;
  let lastProgressDelta = null;
  const updateProgress = () => {
    const strip = document.getElementById("progress-strip");
    if (!strip) return;
    strip.hidden = inboxCount === 0 && todayTriaged === 0;
    const left = document.getElementById("ps-left");
    const dn = document.getElementById("ps-done");
    const streakPill = document.getElementById("ps-streak");
    const sn = document.getElementById("ps-streak-n");
    const fill = document.getElementById("ps-fill");
    const progress = todayTriaged % PROGRESS_GOAL;
    const pct = progress === 0 && todayTriaged > 0 ? 100 : (progress / PROGRESS_GOAL * 100);
    if (left) left.textContent = String(Math.max(0, inboxCount));
    if (dn) dn.textContent = String(todayTriaged);
    if (streakPill) streakPill.hidden = streak < 2;
    if (sn) sn.textContent = String(streak);
    if (fill) fill.style.width = pct + "%";
  };
  const adjustInboxCount = (fromStatus, toStatus, count) => {
    if (fromStatus === "inbox" && toStatus !== "inbox") inboxCount = Math.max(0, inboxCount - count);
    if (fromStatus !== "inbox" && toStatus === "inbox") inboxCount += count;
  };
  const bumpStreakPill = () => {
    const pill = document.getElementById("ps-streak");
    if (!pill || pill.hidden) return;
    pill.classList.remove("bump");
    void pill.offsetWidth;
    pill.classList.add("bump");
  };
  const bumpProgress = (n) => {
    const before = todayTriaged;
    todayTriaged += n;
    streak += n;
    writeTodayTriaged(todayTriaged);
    updateProgress();
    if (streak >= 2) bumpStreakPill();
    if (Math.floor(todayTriaged / PROGRESS_GOAL) > Math.floor(before / PROGRESS_GOAL))
      toast("🎉 " + todayTriaged + " triaged today — keep going");
  };

  // Per-source glyph + accent token (from the design system): the avatar shows
  // r/ ▶ ◇ etc., and the row stripe/avatar use the themed --source-* color
  // (so Firefox is blue), independent of the connector's API badge color.
  const isNsfw = (item) => !!((item.metadata || {}).over_18);

  const CH_SOURCES = {
    reddit:     { glyph: "r/", token: "--source-reddit" },
    youtube:    { glyph: "▶",  token: "--source-youtube" },
    hackernews: { glyph: "Y",  token: "--source-hackernews" },
    obsidian:   { glyph: "◇",  token: "--source-obsidian" },
    keep:       { glyph: "✎",  token: "--source-keep" },
    firefox:    { glyph: "⊕",  token: "--source-firefox" },
  };
  CH_SOURCES.firefox = { icon: "firefox", token: "--source-firefox" };
  const srcAccent = (source) => {
    const m = CH_SOURCES[source];
    return m ? "var(" + m.token + ")" : "var(--accent)";
  };
  // Leading source avatar (solid source-color tile with the source glyph) that
  // doubles as the row's select control — checkbox revealed on hover / select.
  const sourceAvatar = (item) => {
    const s = sources[item.source] || { label: item.source };
    const m = CH_SOURCES[item.source];
    const glyph = m && m.icon
      ? window.chIcon(m.icon, { size: "0.82rem", className: "av-svg" })
      : esc(m ? m.glyph : (s.label || item.source || "?").trim().charAt(0).toUpperCase());
    return '<span class="item-av" title="' + esc(s.label || item.source) + '">' +
      '<span class="av-face">' + glyph + "</span>" +
      '<input type="checkbox" class="sel" aria-label="Select item">' +
      "</span>";
  };

  const hnThreadUrl = (item) => {
    const id = (item && item.source === "hackernews" && item.source_id) ? String(item.source_id).trim() : "";
    return id ? "https://news.ycombinator.com/item?id=" + encodeURIComponent(id) : "";
  };
  const itemUrl = (item) => item.source === "hackernews" ? (hnThreadUrl(item) || item.url || "") : (item.url || "");
  const metaAnchor = (href, label, cls) => {
    const url = safeUrl(href);
    if (!url) return esc(label);
    return '<a class="' + cls + '" href="' + esc(url) +
      '" target="_blank" rel="noopener" onclick="event.stopPropagation()">' + esc(label) + "</a>";
  };
  // YouTube channel link when enrich captured the channel id (else "" → metaAnchor renders plain text).
  const channelHref = (item) => {
    const m = item.metadata || {};
    return (item.source === "youtube" && m.channel_id)
      ? "https://www.youtube.com/channel/" + encodeURIComponent(m.channel_id) : "";
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

  // Short origin label (subreddit / channel / playlist / source) for the card header.
  const subLabel = (item) => {
    const m = item.metadata || {};
    if (m.subreddit) return "r/" + m.subreddit;
    if (m.channel) return m.channel;
    if (m.playlist) return m.playlist;
    const s = sources[item.source];
    return s ? s.label : item.source;
  };
  // Card-header origin label as HTML — links the YouTube channel when we have its id.
  const subLabelHtml = (item) => {
    const m = item.metadata || {};
    if (m.subreddit) return esc("r/" + m.subreddit);
    if (m.channel) return metaAnchor(channelHref(item), m.channel, "meta-link");
    if (m.playlist) return esc(m.playlist);
    const s = sources[item.source];
    return esc(s ? s.label : item.source);
  };
  // hideSub omits the origin (subreddit/channel/playlist) — the card shows it in its header.
  const metaLine = (item, hideSub) => {
    const m = item.metadata || {};
    const parts = [];
    if (item.author) {
      if (item.source === "reddit") parts.push("by " + metaAnchor("https://www.reddit.com/user/" + encodeURIComponent(item.author), item.author, "meta-link"));
      else parts.push("by " + esc(item.author));
    }
    if (!hideSub) {
      if (m.subreddit) parts.push(metaAnchor("https://www.reddit.com/r/" + encodeURIComponent(m.subreddit), "r/" + m.subreddit, "meta-link"));
      if (m.channel) parts.push(metaAnchor(channelHref(item), m.channel, "meta-link"));
      if (m.playlist) parts.push(esc(m.playlist));
    }
    if (item.source === "youtube") { const ud = uploadDate(item); if (ud) parts.push("📅 " + ud); }
    if (item.kind) parts.push(esc(item.kind));
    if (m.category && m.category !== "unknown") parts.push("🏷 " + esc(m.category));
    if (Number.isFinite(m.score)) parts.push(Math.round(m.score) + " pts");
    return parts.join(" · ");
  };

  // Distinguish posted (created_utc) / added-in-source (saved_utc) / synced (first_seen_utc).
  // The list shows the posted age inline; the full labeled breakdown is the hover/long-press tooltip.
  const fmtDate = (ts) => (ts ? new Date(ts * 1000).toLocaleDateString() : "");
  const dateTitle = (item) => {
    const c = item.created_utc, s = item.saved_utc, f = item.first_seen_utc;
    const lines = [];
    if (c) lines.push("Posted: " + fmtDate(c));
    // Only a genuine source timestamp (distinct from post time, clearly before our sync).
    if (s && s !== c && s < f - 86400) lines.push("Added in source: " + fmtDate(s));
    if (f) lines.push("Synced here: " + fmtDate(f));
    return lines.join("\n");
  };
  const tagChips = (item) => {
    const tags = (item.metadata || {}).tags || [];
    if (!tags.length) return "";
    return '<div class="tag-chips">' +
      tags.map((t) => '<span class="tag-chip">' + esc(t) + "</span>").join("") + "</div>";
  };

  // Companion discussion threads folded onto a canonical YouTube item (Epic 11):
  // a saved Reddit post / HN story that pointed at this video survives only as a
  // link here. The 💬 lead doubles as the at-a-glance "discussion exists" badge.
  const COMP_LABEL = { reddit: "Reddit", hackernews: "Hacker News", firefox: "Firefox" };
  const companionHref = (c) => {
    let u = ((c && (c.permalink || c.url)) || "").trim();
    if (/^\/r\//i.test(u)) u = "https://www.reddit.com" + u;  // legacy relative reddit permalink
    return safeUrl(u);
  };
  const companionList = (item) => {
    const list = (item.metadata || {}).companions;
    return Array.isArray(list) ? list.filter((c) => companionHref(c)) : [];
  };
  const companionsHtml = (item) => {
    const cs = companionList(item);
    if (!cs.length) return "";
    const links = cs.map((c) => {
      const label = COMP_LABEL[c.source] || (sources[c.source] || {}).label || c.source || "link";
      return '<a class="comp-link" href="' + esc(companionHref(c)) +
        '" target="_blank" rel="noopener" onclick="event.stopPropagation()">' + esc(label) + " ↗</a>";
    }).join("");
    return '<div class="companions" title="Saved discussion threads for this video">' +
      '<span class="comp-lead" aria-hidden="true">💬</span>' + links + "</div>";
  };
  // Data-driven tag checkboxes (volume-sorted, with counts); selection persists across rebuilds.
  const renderTagFilter = (byTag) => {
    const list = document.getElementById("tag-filter-list");
    if (!list) return;
    const tags = Object.keys(byTag);
    selectedTags.forEach((t) => { if (!tags.includes(t)) tags.push(t); });
    const count = (t) => byTag[t] || 0;
    list.innerHTML = tags.sort((a, b) => (count(b) - count(a)) || a.localeCompare(b)).map((t) =>
      '<li data-tag="' + esc(t) + '" role="button" tabindex="0" class="' + (selectedTags.has(t) ? "active" : "") + '">' +
      '<span class="nav-ico nav-ico-tag" aria-hidden="true">#</span><span>' + esc(t) + "</span>" +
      ' <span class="cnt">' + count(t) + "</span></li>").join("");
    list.hidden = tagsCollapsed;
    const section = document.getElementById("tag-section");
    if (section) section.hidden = tags.length === 0;
    updateTagSummary();
  };
  const updateTagSummary = () => {
    const s = document.getElementById("tag-summary");
    if (s) s.textContent = selectedTags.size ? "Tags (" + selectedTags.size + ")" : "Tags";
  };
  const tagToggle = document.getElementById("tag-toggle");
  const tagList = document.getElementById("tag-filter-list");
  let tagsCollapsed = false;
  const setTagsCollapsed = (collapsed) => {
    tagsCollapsed = collapsed;
    if (tagList) tagList.hidden = collapsed;
    if (tagToggle) tagToggle.setAttribute("aria-expanded", String(!collapsed));
    try { localStorage.setItem("ch-tags-collapsed", collapsed ? "1" : "0"); } catch (e) {}
  };
  if (tagToggle) {
    let savedTagsCollapsed = null;
    try { savedTagsCollapsed = localStorage.getItem("ch-tags-collapsed"); } catch (e) {}
    setTagsCollapsed(savedTagsCollapsed === "1");
    tagToggle.addEventListener("click", () => setTagsCollapsed(!tagsCollapsed));
  }

  const PREVIEW_TYPES = { reddit_video: "▶ Play", reddit_media: "▶ Preview", gallery: "🖼 Gallery" };
  // When the archive captured the gallery images, carry them so the click opens an inline
  // lightbox instead of the Reddit embed. (No-op string for non-gallery items.)
  const galleryAttr = (m) => (Array.isArray(m.gallery) && m.gallery.length)
    ? ' data-gallery="' + esc(JSON.stringify(m.gallery)) + '"' : "";
  const wrapMediaHtml = (item, inner) => {
    if (!inner) return "";
    if (!isNsfw(item) || revealedNsfw.has(item.fullname)) return inner;
    return '<div class="item-media nsfw" data-nsfw-media="1">' + inner +
      '<span class="nsfw-tag">NSFW</span></div>';
  };
  // YouTube maxres thumbs 404 on some videos → onerror-fall-back to the always-present mqdefault.
  const ytFallback = (t) => /i\.ytimg\.com\/vi\/[^/]+\/maxresdefault\.jpg/.test(t)
    ? " onerror=\"this.onerror=null;this.src=this.src.replace('maxresdefault','mqdefault')\""
    : "";
  // Right-hand media slot: a thumbnail when we have one, else a click-to-load
  // Reddit preview button for media posts whose media URL wasn't captured.
  const mediaSlotHtml = (item) => {
    const m = item.metadata || {};
    const t = thumb(item);
    if (t) {
      const full = imageUrl(item);
      const yterr = ytFallback(t);
      if (full) {                                         // direct image → open in lightbox
        return wrapMediaHtml(item, '<img class="item-thumb img-open" src="' + esc(t) + '"' + yterr +
          ' data-img="' + esc(full) + '" alt="">');
      }
      if (item.source === "reddit" && PREVIEW_TYPES[m.media_type]) {  // video/gallery → permalink embed
        const permalink = m.permalink || item.url || "";
        return wrapMediaHtml(item, '<img class="item-thumb rd-preview" src="' + esc(t) + '"' + yterr +
          ' data-permalink="' + esc(permalink) + '"' + galleryAttr(m) + ' alt="">');
      }
      return wrapMediaHtml(item, '<img class="item-thumb" src="' + esc(t) + '"' + yterr + ' alt="">');
    }
    const mt = m.media_type;
    if (item.source === "reddit" && PREVIEW_TYPES[mt]) {
      const permalink = m.permalink || item.url || "";
      const label = /\/gallery\//i.test(item.url || "") ? "🖼 Gallery" : PREVIEW_TYPES[mt];
      return wrapMediaHtml(item, '<button class="item-thumb rd-preview" type="button" data-permalink="' +
        esc(permalink) + '"' + galleryAttr(m) + ">" + label + "</button>");
    }
    return "";
  };
  const revealNsfw = (fullname, row) => {
    revealedNsfw.add(fullname);
    if (!row) return;
    row.dataset.revealed = "1";
    row.querySelectorAll(".item-media.nsfw").forEach((el) => el.classList.remove("nsfw"));
    const flag = row.querySelector(".media-flag .mf-play");
    if (flag) flag.textContent = "â–¶";
  };

  // Posted/synced age, shown in the meta line so it stays visible at every density.
  const ageMeta = (item) =>
    '<span class="m-age" title="' + esc(dateTitle(item)) + '">' +
    esc((item.created_utc ? "posted " : "synced ") + ago(item.created_utc || item.first_seen_utc)) + "</span>";

  // Time-to-consume estimate, gated on available data: YouTube duration → "N min
  // watch/listen"; a text body → "N min read". Returns "" when there's no signal.
  const READ_WPM = 200;
  const consumeMeta = (item) => {
    const m = item.metadata || {};
    let mins = 0, verb = "";
    if (item.source === "youtube" && Number.isFinite(m.duration) && m.duration > 0) {
      mins = Math.max(1, Math.round(m.duration / 60));
      verb = m.category === "listenable" ? "listen" : "watch";
    } else if (item.body && item.body.trim()) {
      const words = item.body.trim().split(/\s+/).length;
      if (words >= 40) { mins = Math.max(1, Math.round(words / READ_WPM)); verb = "read"; }
    }
    if (!mins) return "";
    const amt = mins >= 60
      ? Math.floor(mins / 60) + "h" + (mins % 60 ? " " + (mins % 60) + "m" : "")
      : mins + " min";
    return '<span class="consume ' + verb + '">' + amt + " " + verb + "</span>";
  };

  // Static fragments (chIcon is available at module-eval time; build once, reuse per row).
  const ACTIONS_HTML =
    '<div class="item-actions">' +
      '<button class="keep" data-act="keep" type="button" title="Keep" aria-label="Keep">' + window.chIcon("keep") + "</button>" +
      '<button class="arch" data-act="archived" type="button" title="Archive" aria-label="Archive">' + window.chIcon("archive") + "</button>" +
      '<button class="done" data-act="done" type="button" title="Mark done" aria-label="Mark done">' + window.chIcon("done") + "</button>" +
    "</div>";
  const REVEAL_HTML =
    '<div class="item-bg" aria-hidden="true">' +
      '<span class="ic ic-arch">' + window.chIcon("archive") + " Archive</span>" +
      '<span class="ic ic-done">Done ' + window.chIcon("done") + "</span>" +
    "</div>";

  // Renders one row. Branches on currentDensity: card has a distinct layout
  // (card-head + hero thumb + body + card-tagrow); compact/comfortable share the
  // flat layout (avatar · body · thumb · media-pill · actions), CSS-differentiated.
  const itemHtml = (item) => {
    const href = itemUrl(item);
    const titleHtml = safeUrl(href)
      ? '<a class="item-title" href="' + esc(href) + '" target="_blank" rel="noopener">' + esc(item.title || href) + "</a>"
      : '<span class="item-title">' + esc(item.title || item.fullname) + "</span>";
    const recoverBtn = isRemoved(item)
      ? '<div class="item-recover"><button class="recover-btn" data-recover type="button">↻ Recover</button></div>' : "";
    const media = mediaSlotHtml(item);
    const snippet = item.body ? '<div class="item-snippet">' + esc(item.body.slice(0, 240)) + "</div>" : "";
    const metaHtml = (hideSub, withAge) => {
      const bits = [];
      const ml = metaLine(item, hideSub);
      if (ml) bits.push('<span class="m-info">' + ml + "</span>");
      if (withAge) bits.push(ageMeta(item));
      const consume = consumeMeta(item);
      if (consume) bits.push(consume);
      return '<div class="item-meta">' + bits.join('<span class="sep">·</span>') + "</div>";
    };
    const revealed = revealedNsfw.has(item.fullname);
    const urlAttr = safeUrl(href) ? ' data-url="' + esc(href) + '"' : "";
    const head = '<div class="item" data-fullname="' + esc(item.fullname) + '" data-source="' + esc(item.source) +
      '" data-status="' + esc(item.status || "inbox") + '"' +
      (isNsfw(item) ? ' data-over18="1"' : "") +
      (revealed ? ' data-revealed="1"' : "") + urlAttr +
      ' style="--src:' + srcAccent(item.source) + '">' + REVEAL_HTML;

    if (currentDensity === "card") {
      return head +
        '<div class="item-fg">' +
          '<div class="card-head">' + sourceAvatar(item) +
            '<span class="ch-sub">' + subLabelHtml(item) + "</span>" +
            '<span class="item-time" title="' + esc(dateTitle(item)) + '">' + esc(ago(item.created_utc || item.first_seen_utc)) + "</span>" +
          "</div>" +
          media +
          '<div class="item-main">' +
            titleHtml +
            metaHtml(true, false) +
            companionsHtml(item) +
            snippet +
            '<div class="card-tagrow">' + (tagChips(item) || '<div class="tag-chips"></div>') + ACTIONS_HTML + "</div>" +
            recoverBtn +
          "</div>" +
        "</div></div>";
    }

    // compact / comfortable
    const pill = media
      ? '<button class="media-flag" type="button" title="Open media" aria-label="Open media"><span class="mf-play">▶</span></button>'
      : "";
    const needsReveal = isNsfw(item) && !revealed;
    const pillHtml = needsReveal && media
      ? '<button class="media-flag" type="button" title="Reveal media" aria-label="Reveal media"><span class="mf-play">NSFW</span></button>'
      : pill;
    return head +
      '<div class="item-fg">' +
        sourceAvatar(item) +
        '<div class="item-main">' +
          titleHtml +
          metaHtml(false, true) +
          companionsHtml(item) +
          snippet +
          tagChips(item) +
          recoverBtn +
        "</div>" +
        media +
        pillHtml +
        ACTIONS_HTML +
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
    selectedTags.forEach((t) => p.append("tag", t));
    if (activeSource) p.set("source", activeSource);
    p.set("limit", String(BATCH));
    p.set("offset", String(offset));
    return p.toString();
  };

  // Placeholder rows so a fresh load never flashes an empty list (inert: aria-hidden + no pointer).
  const SKELETON_ROW = '<div class="item skel" aria-hidden="true">' +
    '<div class="skel-thumb"></div>' +
    '<div class="skel-lines"><span></span><span></span></div></div>';

  const setEmptyMessage = (el) => {
    const q = document.getElementById("q").value.trim();
    if (q) { el.dataset.kind = "search"; el.textContent = "No matches for “" + q + "”."; }
    else if (activeStatus) { el.dataset.kind = "status"; el.textContent = "Nothing in " + activeStatus + " yet."; }
    else { el.dataset.kind = "import"; el.textContent = "Nothing here yet — import a source to begin."; }
  };

  const attachRowSwipe = (row) => {
    if (row.dataset.sw) return;
    row.setAttribute("data-sw", "1");
    if (window.attachSwipe) window.attachSwipe(row, {
      onRight: () => actOnItem(row.dataset.fullname, "archived", row),
      onLeft: () => actOnItem(row.dataset.fullname, "done", row),
    });
  };
  // Re-apply selection state to a (re-)rendered row.
  const restoreRowState = (row) => {
    if (selected.has(row.dataset.fullname)) {
      row.classList.add("selected");
      const cb = row.querySelector(".sel"); if (cb) cb.checked = true;
    }
  };
  // Re-render all cached rows — used when density changes (card vs list markup differ).
  const renderAll = () => {
    const box = document.getElementById("items");
    box.innerHTML = loadedItems.map(itemHtml).join("");
    box.querySelectorAll(".item").forEach((row) => { attachRowSwipe(row); restoreRowState(row); });
  };

  const load = (reset) => {
    if (loading) return;
    loading = true;
    const box = document.getElementById("items");
    const emptyEl = document.getElementById("empty");
    if (reset) {
      offset = 0;
      loadedItems.length = 0;
      box.innerHTML = SKELETON_ROW.repeat(6);
      emptyEl.hidden = true;
      document.getElementById("loadmore").hidden = true;
    }
    getJSON("/items?" + buildQuery()).then((data) => {
      box.querySelectorAll(".item.skel").forEach((s) => s.remove());
      (data.items || []).forEach((it) => {
        loadedItems.push(it);
        box.insertAdjacentHTML("beforeend", itemHtml(it));
      });
      box.querySelectorAll(".item:not([data-sw])").forEach((row) => { attachRowSwipe(row); restoreRowState(row); });
      const hasItems = box.querySelector(".item") !== null;
      emptyEl.hidden = hasItems;
      if (!hasItems) setEmptyMessage(emptyEl);
      document.getElementById("loadmore").hidden = !data.has_more;
      offset += (data.items || []).length;
    }).catch(() => { box.querySelectorAll(".item.skel").forEach((s) => s.remove()); })
      .finally(() => { loading = false; });
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
      syncHeaderHeight();
    }).catch(() => {});
  };

  // Sidebar status counts come from /stats, cross-filtered by the active source. light=1 keeps
  // this off the Stats-modal's full-table scans so it's cheap to call after every action.
  const loadCounts = () => {
    const p = new URLSearchParams();
    p.set("light", "1");
    if (activeSource) p.set("source", activeSource);
    if (activeStatus) p.set("status", activeStatus);
    const qs = p.toString();
    return getJSON("/stats?" + qs).then((d) => {
      const bs = d.by_status || {};
      const set = (k, v) => {
        const el = document.querySelector('[data-cnt="' + k + '"]');
        if (el) el.textContent = v || 0;
      };
      inboxCount = bs.inbox || 0;
      set("inbox", bs.inbox);
      set("keep", bs.keep);
      set("archived", bs.archived);
      set("done", bs.done);
      set("all", Object.values(bs).reduce((n, v) => n + (v || 0), 0));
      updateProgress();
    }).catch(() => {});
  };
  // Curated tag-rail counts come from a dedicated /tags endpoint, NOT /stats — the tag scan is
  // expensive (json_each over every item), so we fetch it only on navigation (init / source /
  // status change), not after each triage action. Cross-filtered by the active source+status.
  const loadTags = () => {
    const p = new URLSearchParams();
    if (activeSource) p.set("source", activeSource);
    if (activeStatus) p.set("status", activeStatus);
    const qs = p.toString();
    return getJSON("/tags" + (qs ? "?" + qs : "")).then((d) => {
      renderTagFilter(d.tags || {});
    }).catch(() => {});
  };
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
      .then(() => {
        streak = 0;
        if (lastProgressDelta && lastProgressDelta.fullname === fullname) {
          todayTriaged = Math.max(0, todayTriaged - lastProgressDelta.count);
          writeTodayTriaged(todayTriaged);
          adjustInboxCount(lastProgressDelta.toStatus, lastProgressDelta.fromStatus, lastProgressDelta.count);
          lastProgressDelta = null;
        }
        updateProgress();
        load(true); loadSources(); loadCounts();
      })
      .catch(() => {});
  };

  const actOnItem = (fullname, status, row) => {
    const fromStatus = row ? (row.dataset.status || activeStatus || "inbox") : (activeStatus || "inbox");
    getJSON("/items/" + encodeURIComponent(fullname) + "/status", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: status }),
    }).then(() => {
      selected.delete(fullname);
      if (row) row.dataset.status = status;
      if (row && activeStatus && activeStatus !== status) row.remove();
      adjustInboxCount(fromStatus, status, 1);
      lastProgressDelta = { fullname: fullname, count: 1, fromStatus: fromStatus, toStatus: status };
      snackbar(cap(status), () => undoItem(fullname));
      bumpProgress(1);
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
    const chip = e.target.closest(".tag-chip");   // add tag to filter (before card-select fallthrough)
    if (chip) {
      const t = chip.textContent.trim();
      if (!selectedTags.has(t)) {
        selectedTags.add(t);
        const tagRow = document.querySelector('#tag-filter-list [data-tag="' + CSS.escape(t) + '"]');
        if (tagRow) tagRow.classList.add("active");
        updateTagSummary();
        load(true);
      }
      return;
    }
    const actBtn = e.target.closest("[data-act]");
    if (actBtn) { actOnItem(fullname, actBtn.dataset.act, row); return; }
    const recBtn = e.target.closest("[data-recover]");
    if (recBtn) { recoverItem(fullname, row, recBtn); return; }
    const nsfwMedia = e.target.closest(".item-media.nsfw");
    if (nsfwMedia) { revealNsfw(fullname, row); return; }
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
    const flag = e.target.closest(".media-flag");       // compact ▶ pill → open the (hidden) thumb's media
    if (flag) {
      if (row.dataset.over18 === "1" && row.dataset.revealed !== "1") { revealNsfw(fullname, row); return; }
      const t = row.querySelector(".item-thumb");
      if (t) t.click(); else if (row.dataset.url) window.open(row.dataset.url, "_blank", "noopener");
      return;
    }
    const plainThumb = e.target.closest(".item-thumb"); // a plain thumbnail (no preview handler) → open the item url
    if (plainThumb && row.dataset.url) { window.open(row.dataset.url, "_blank", "noopener"); return; }
    if (e.target.classList.contains("sel")) { toggleSel(fullname, e.target.checked, row); return; }
    if (e.target.closest("a, button, input, .item-av")) return;  // links / buttons / avatar handle themselves
    if (row.dataset.url) window.open(row.dataset.url, "_blank", "noopener");  // a row-body click opens the item
  });

  document.querySelectorAll("[data-bulk]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!selected.size) return;
      const n = selected.size;
      const targetStatus = btn.dataset.bulk;
      const movedFromInbox = Array.from(selected).reduce((sum, fullname) => {
        const row = document.querySelector('.item[data-fullname="' + CSS.escape(fullname) + '"]');
        return sum + (row && row.dataset.status === "inbox" && targetStatus !== "inbox" ? 1 : 0);
      }, 0);
      getJSON("/bulk/status", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fullnames: Array.from(selected), status: targetStatus }),
      }).then(() => {
        toast("Bulk marked " + targetStatus);
        selected.clear();
        document.getElementById("bulkbar").hidden = true;
        if (movedFromInbox) adjustInboxCount("inbox", targetStatus, movedFromInbox);
        lastProgressDelta = null;
        bumpProgress(n);
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
    loadTags();     // tag-rail counts cross-filter by the active source
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

  const visualMenuBtn = document.getElementById("visual-menu-btn");
  const visualMenuPop = document.getElementById("visual-menu-pop");
  const closeVisualMenu = () => {
    if (!visualMenuBtn || !visualMenuPop) return;
    visualMenuPop.hidden = true;
    visualMenuBtn.setAttribute("aria-expanded", "false");
  };
  if (visualMenuBtn && visualMenuPop) {
    visualMenuBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const willOpen = visualMenuPop.hidden;
      visualMenuPop.hidden = !willOpen;
      visualMenuBtn.setAttribute("aria-expanded", String(willOpen));
    });
    visualMenuPop.addEventListener("click", (e) => e.stopPropagation());
    document.addEventListener("click", (e) => {
      if (!visualMenuPop.hidden && !e.target.closest(".visual-menu")) closeVisualMenu();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !visualMenuPop.hidden) closeVisualMenu();
    });
  }
  const themeMenuToggle = document.getElementById("theme-menu-toggle");
  if (themeMenuToggle) {
    themeMenuToggle.addEventListener("click", () => {
      if (typeof window.toggleTheme === "function") window.toggleTheme();
      closeVisualMenu();
    });
  }

  document.getElementById("status-nav").addEventListener("click", (e) => {
    const li = e.target.closest("li");
    if (!li) return;
    activeStatus = li.dataset.status || "";
    document.querySelectorAll("#status-nav li").forEach((x) => x.classList.remove("active"));
    li.classList.add("active");
    closeDrawer();
    load(true);
    loadSources();  // tab counts reflect the newly active status
    loadCounts();
    loadTags();     // tag-rail counts cross-filter by the active status
  });

  document.getElementById("btn-stats").addEventListener("click", () => {
    getJSON("/stats").then(renderStats).catch(() => {});
    document.getElementById("stats-modal").hidden = false;
  });
  document.getElementById("btn-stats").addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    e.currentTarget.click();
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
  document.getElementById("shortcut-close").addEventListener("click", closeShortcuts);
  document.getElementById("shortcut-modal").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeShortcuts();
  });

  // -- reddit unsave: cookie auth + on-demand queue drain --
  const ruModal = document.getElementById("reddit-modal");
  const ruStatus = document.getElementById("ru-status");
  const ruBanner = document.getElementById("ru-banner");
  const ruEnable = document.getElementById("ru-enable");
  const ruSync = document.getElementById("ru-sync");

  const ruRender = (s) => {
    ruEnable.checked = !!s.enabled;
    ruSync.textContent = s.pending ? "Sync now (" + s.pending + ")" : "Sync now";
    ruSync.disabled = !s.configured || !s.pending;
    ruStatus.textContent = s.configured
      ? "Connected as u/" + (s.username || "?") + " · " + s.pending + " queued to unsave"
      : "Not connected — paste your reddit_session cookie below.";
  };
  const ruRefresh = () => getJSON("/reddit/unsave/status").then(ruRender).catch(() => {});
  const ruWarn = (msg) => { ruBanner.textContent = msg; ruBanner.hidden = false; };

  document.getElementById("btn-reddit").addEventListener("click", () => {
    ruBanner.hidden = true;
    ruModal.hidden = false;
    closeDrawer();
    ruRefresh();
  });
  document.getElementById("btn-reddit").addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    e.currentTarget.click();
  });
  document.getElementById("reddit-close").addEventListener("click", () => { ruModal.hidden = true; });
  ruModal.addEventListener("click", (e) => { if (e.target === ruModal) ruModal.hidden = true; });

  ruEnable.addEventListener("change", () => {
    getJSON("/reddit/unsave/enable", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: ruEnable.checked }),
    }).then(() => toast(ruEnable.checked ? "Unsave-on-Done enabled" : "Unsave-on-Done disabled"))
      .catch(() => toast("Couldn’t change that setting"));
  });

  document.getElementById("ru-save-cookie").addEventListener("click", () => {
    const field = document.getElementById("ru-cookie");
    const cookie = field.value.trim();
    if (!cookie) { ruWarn("Paste your reddit_session cookie first."); return; }
    fetch("/reddit/unsave/auth", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cookie: cookie }),
    }).then((r) => r.json()).then((d) => {
      if (d.ok) {
        field.value = "";
        ruBanner.hidden = true;
        toast("Connected as u/" + d.username);
        ruRefresh();
      } else {
        ruWarn(d.error || "Cookie rejected.");
      }
    }).catch(() => ruWarn("Cookie validation failed — check your connection."));
  });

  ruSync.addEventListener("click", () => {
    ruSync.disabled = true;
    ruStatus.textContent = "Syncing…";
    getJSON("/reddit/unsave/drain", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }).then((res) => {
      if (res.auth_error) ruWarn("Reddit session expired — re-paste your cookie.");
      else toast("Unsaved " + res.unsaved + (res.failed ? " · " + res.failed + " failed" : ""));
      ruRefresh();
    }).catch(() => { toast("Sync failed"); ruRefresh(); });
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
  document.getElementById("btn-import").addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    e.currentTarget.click();
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

  const qInput = document.getElementById("q");
  const qClear = document.getElementById("q-clear");
  const syncSearchClear = () => {
    if (qClear) qClear.hidden = !qInput.value.trim();
  };
  const onQueryInput = debounce(() => load(true), 250);
  qInput.addEventListener("input", () => {
    syncSearchClear();
    onQueryInput();
  });
  if (qClear) {
    qClear.addEventListener("click", () => {
      qInput.value = "";
      syncSearchClear();
      qInput.focus();
      load(true);
    });
  }
  document.getElementById("fuzzy").addEventListener("change", () => load(true));
  document.getElementById("sort").addEventListener("change", () => load(true));
  const toggleTagFilter = (row) => {
    if (!row) return;
    const tag = row.dataset.tag || "";
    if (!tag) return;
    if (selectedTags.has(tag)) selectedTags.delete(tag); else selectedTags.add(tag);
    row.classList.toggle("active", selectedTags.has(tag));
    updateTagSummary();
    load(true);
  };
  document.getElementById("tag-filter-list").addEventListener("click", (e) => {
    toggleTagFilter(e.target.closest("[data-tag]"));
  });
  document.getElementById("tag-filter-list").addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    toggleTagFilter(e.target.closest("[data-tag]"));
  });
  // Density toggle (compact / comfortable / card), persisted in localStorage.
  (function () {
    var box = document.getElementById("items");
    var DENS = ["compact", "comfortable", "card"];
    function applyDensity(d) {
      if (DENS.indexOf(d) === -1) d = "comfortable";
      var changed = d !== currentDensity;
      currentDensity = d;
      DENS.forEach(function (x) { box.classList.toggle("density-" + x, x === d); });
      document.querySelectorAll("[data-density]").forEach(function (b) {
        var on = b.dataset.density === d;
        b.classList.toggle("active", on);
        b.classList.toggle("on", on);
        b.setAttribute("aria-pressed", String(on));
      });
      try { localStorage.setItem("ch-density", d); } catch (e) {}
      if (changed && loadedItems.length) renderAll();   // card vs list markup differ → re-render
    }
    document.querySelectorAll("[data-density]").forEach(function (b) {
      b.addEventListener("click", function () {
        applyDensity(b.dataset.density);
        closeVisualMenu();
      });
    });
    var saved; try { saved = localStorage.getItem("ch-density"); } catch (e) {}
    applyDensity(saved || "comfortable");
  })();

  // Keyboard: J/K move focus · S keep · E archive · Y done · X select (browse).
  (function () {
    var box = document.getElementById("items");
    var fi = -1;
    function rows() { return Array.prototype.slice.call(box.querySelectorAll(".item:not(.skel)")); }
    function focus(i) {
      var r = rows();
      if (!r.length) { fi = -1; return; }
      fi = Math.max(0, Math.min(i, r.length - 1));
      r.forEach(function (el, idx) { el.classList.toggle("kfocus", idx === fi); });
      if (r[fi]) r[fi].scrollIntoView({ block: "nearest" });
    }
    function cur() { var r = rows(); return fi >= 0 ? r[fi] : null; }
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && shortcutModal && !shortcutModal.hidden) { closeShortcuts(); return; }
      if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      var k = e.key.toLowerCase();
      if (k === "?") { e.preventDefault(); toggleShortcuts(); return; }
      if (shortcutModal && !shortcutModal.hidden) return;
      if (k === "j" || k === "arrowdown") { e.preventDefault(); focus(fi < 0 ? 0 : fi + 1); }
      else if (k === "k" || k === "arrowup") { e.preventDefault(); focus(fi < 0 ? 0 : fi - 1); }
      else if (k === "s" || k === "e" || k === "y") {
        var row = cur(); if (!row) return;
        actOnItem(row.dataset.fullname, k === "s" ? "keep" : k === "e" ? "archived" : "done", row);
        // Row removal (if any) is async; leave focus for the next J/K to re-clamp
        // rather than racing the network round-trip.
      } else if (k === "x") {
        var r2 = cur(); if (!r2) return;
        var cb = r2.querySelector(".sel");
        if (cb) { cb.checked = !cb.checked; toggleSel(r2.dataset.fullname, cb.checked, r2); }
      }
    });
  })();

  // Focus mode — dim the chrome to spotlight the list; persisted. Also label the
  // batch button with the page size ("Show N more").
  (function () {
    var fbtn = document.getElementById("focus-toggle");
    if (fbtn) {
      var setFocus = function (on) {
        document.body.classList.toggle("focus-mode", on);
        fbtn.setAttribute("aria-pressed", String(on));
        fbtn.classList.toggle("active", on);
        fbtn.classList.toggle("on", on);
        try { localStorage.setItem("ch-focus", on ? "1" : "0"); } catch (e) {}
        syncHeaderHeight();
      };
      fbtn.addEventListener("click", function () {
        setFocus(!document.body.classList.contains("focus-mode"));
        closeVisualMenu();
      });
      var sf; try { sf = localStorage.getItem("ch-focus"); } catch (e) {}
      if (sf === "1") setFocus(true);
    }
    var lm = document.getElementById("loadmore");
    if (lm) lm.textContent = "Show " + BATCH + " more";
    syncSearchClear();
    updateProgress();
  })();

  document.getElementById("loadmore").addEventListener("click", () => load(false));

  if ("serviceWorker" in navigator)
    navigator.serviceWorker.register("/static/sw.js").catch(() => {});
  if (/Android|Mobi/i.test(navigator.userAgent) &&
      !window.matchMedia("(display-mode: standalone)").matches) {
    document.getElementById("install-hint").hidden = false;
  }

  loadSources();
  loadCounts();
  loadTags();
  load(true);
})();
