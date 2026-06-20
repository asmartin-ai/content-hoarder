/* Triage focus mode: one card at a time, swipe / keyboard / buttons.
   Pixel-6 / Android gesture-nav safe: 30px edge deadzone + inset card + tap buttons. */
import { esc, safeUrl, isTypingTarget, ago } from "./core/util.js";
import { getJSON as fetchJSON } from "./core/api.js";
import { chIcon, fillIcons } from "./core/icons.js";

(function () {
  "use strict";

  var EDGE_DEADZONE = 30;     // ignore pointerdown within 30px of a screen edge
  var COMMIT_PX = 80;         // horizontal distance to commit a swipe
  var BATCH = parseInt(localStorage.getItem("ch_batch"), 10) || 20;

  var stack = document.getElementById("card-stack");
  var progressEl = document.getElementById("progress");
  var emptyEl = document.getElementById("triage-empty");
  var actionsEl = document.getElementById("actions");
  var srcFilter = document.getElementById("source-filter");
  var toastEl = document.getElementById("toast");
  var undoBtn = document.getElementById("undo-btn");
  var menuBtn = document.getElementById("menu-btn");
  var menuPop = document.getElementById("menu-pop");
  var batchChips = document.getElementById("batch-chips");
  var ruPop = document.getElementById("ru-pop");
  var ruPopStatus = document.getElementById("ru-pop-status");
  var ruSyncBtn = document.getElementById("ru-sync-triage");
  var shortcutModal = document.getElementById("shortcut-modal");
  var shortcutClose = document.getElementById("shortcut-close");

  var queue = [];
  var reviewed = 0;
  var todayCleared = 0;      // today's manual clears, shared with browse via /pulse — wins, never debt
  var emptyStamped = false;  // guard so the "page cleared" milestone fires once per emptying
  var sources = {};
  var lastAction = null;       // {fullname, status} for undo
  var toastTimer = null;

  // ---- helpers: esc/safeUrl/isTypingTarget/ago/fetchJSON imported from core (see top of file) ----

  // Reddit retired its blockquote + platform.js embed (the script now 404s), so embed the
  // official redditmedia.com iframe directly. Online-only; the permalink link is the fallback.
  function redditEmbedUrl(permalink) {
    var base = (permalink || "").split("#")[0].split("?")[0]
      .replace(/^https?:\/\/([a-z0-9-]+\.)?reddit\.com/i, "https://www.redditmedia.com");
    return base + "?ref_source=embed&ref=share&embed=true&theme=dark";
  }

  // Gallery lightbox (reuse the same .media-gallery + .gallery-img pattern as browse).
  function openGallery(urls) {
    var imgs = (urls || []).filter(safeUrl);
    if (!imgs.length) return;
    document.getElementById("media-body").innerHTML =
      '<div class="media-gallery">' +
      imgs.map(function (u) { return '<img class="media-img gallery-img" loading="lazy" src="' + esc(u) + '" alt="">'; }).join("") +
      "</div>" + '<p class="media-fallback">' + imgs.length + " images</p>";
    document.getElementById("media-modal").hidden = false;
  }
  function closeMedia() {
    document.getElementById("media-modal").hidden = true;
    document.getElementById("media-body").innerHTML = "";
  }
  function closeShortcuts() { if (shortcutModal) shortcutModal.hidden = true; }
  function toggleShortcuts() {
    if (!shortcutModal) return;
    shortcutModal.hidden = !shortcutModal.hidden;
  }
  function hnThreadUrl(item) {
    var id = item && item.source === "hackernews" && item.source_id ? String(item.source_id).trim() : "";
    return id ? "https://news.ycombinator.com/item?id=" + encodeURIComponent(id) : "";
  }
  function itemUrl(item) {
    return item && item.source === "hackernews" ? (hnThreadUrl(item) || item.url || "") : ((item && item.url) || "");
  }
  function metaAnchor(href, label) {
    var url = safeUrl(href);
    if (!url) return esc(label);
    return '<a class="meta-link" href="' + esc(url) +
      '" target="_blank" rel="noopener" onclick="event.stopPropagation()">' + esc(label) + "</a>";
  }

  function badge(item) {
    var s = sources[item.source] || { label: item.source, badge_color: "#888" };
    return '<span class="badge" style="--c:' + esc(s.badge_color) + '">' + esc(s.label) + "</span>";
  }
  function metaLine(item) {
    var m = item.metadata || {};
    var bits = [];
    if (item.author) {
      if (item.source === "reddit") bits.push("by " + metaAnchor("https://www.reddit.com/user/" + encodeURIComponent(item.author), item.author));
      else if (item.source === "hackernews") bits.push("by " + metaAnchor("https://news.ycombinator.com/user?id=" + encodeURIComponent(item.author), item.author));
      else bits.push("by " + esc(item.author));
    }
    if (m.subreddit) bits.push(metaAnchor("https://www.reddit.com/r/" + encodeURIComponent(m.subreddit), "r/" + m.subreddit));
    if (m.channel) bits.push(esc(m.channel));
    if (m.playlist) bits.push(esc(m.playlist));
    if (item.kind) bits.push(esc(item.kind));
    if (typeof m.score === "number") bits.push(m.score + " pts");
    // HN: a pill straight to the linked article (the title opens the discussion).
    // Self/Ask-HN posts store the thread URL in item.url, so they get no chip.
    var au = item.source === "hackernews" ? (item.url || "").trim() : "";
    if (au && !/news\.ycombinator\.com\/item\?id=/i.test(au) && safeUrl(au)) {
      bits.push('<a class="comp-link art-chip" href="' + esc(safeUrl(au)) +
        '" target="_blank" rel="noopener" onclick="event.stopPropagation()">Article ↗</a>');
    }
    return bits.join(" · ");
  }

  function fmtDate(ts) { return ts ? new Date(ts * 1000).toLocaleDateString() : ""; }
  // Three distinct timestamps, labeled so they're never confused: when it was originally
  // posted (created_utc), when it was added/saved in the source app (saved_utc — only some
  // sources expose this), and when it synced into content-hoarder (first_seen_utc).
  function datesLine(item) {
    var c = item.created_utc, s = item.saved_utc, f = item.first_seen_utc;
    // Show "added in source" only when it's a real source timestamp: distinct from the post
    // time AND clearly earlier than our sync. Sources that just stamp it at import (e.g. HN)
    // or don't expose it at all (Reddit, YouTube) would otherwise add misleading noise.
    var showSaved = s && s !== c && s < f - 86400;
    var vis = [], tip = [];
    if (c) { vis.push("posted " + ago(c)); tip.push("Posted: " + fmtDate(c)); }
    if (showSaved) { vis.push("saved " + ago(s)); tip.push("Added in source: " + fmtDate(s)); }
    if (f) { vis.push("synced " + ago(f)); tip.push("Synced here: " + fmtDate(f)); }
    if (!vis.length) return "";
    return '<div class="tcard-dates" title="' + esc(tip.join("\n")) + '">' + vis.join(" · ") + "</div>";
  }

  function tagChips(item) {
    var tags = (item.metadata || {}).tags || [];
    if (!tags.length) return "";
    return '<div class="tag-chips">' + tags.map(function (t) {
      return '<span class="tag-chip">' + esc(t) + "</span>";
    }).join("") + "</div>";
  }

  // Companion discussion threads folded onto a canonical YouTube item (Epic 11).
  var COMP_LABEL = { reddit: "Reddit", hackernews: "Hacker News", firefox: "Firefox" };
  function companionHref(c) {
    var u = ((c && (c.permalink || c.url)) || "").trim();
    if (/^\/r\//i.test(u)) u = "https://www.reddit.com" + u;
    return safeUrl(u);
  }
  function companionsHtml(item) {
    var list = (item.metadata || {}).companions;
    var cs = Array.isArray(list) ? list.filter(companionHref) : [];
    if (!cs.length) return "";
    var links = cs.map(function (c) {
      var label = COMP_LABEL[c.source] || (sources[c.source] || {}).label || c.source || "link";
      return '<a class="comp-link" href="' + esc(companionHref(c)) +
        '" target="_blank" rel="noopener" onclick="event.stopPropagation()">' + esc(label) + " ↗</a>";
    }).join("");
    return '<div class="companions" title="Saved discussion threads for this video">' +
      '<span class="comp-lead" aria-hidden="true">💬</span>' + links + "</div>";
  }

  var CATEGORIES = ["listenable", "watch", "wotagei", "unknown"];
  function catHtml(item) {
    if (item.source !== "youtube") return "";  // category is a YouTube concept for now
    var cur = (item.metadata || {}).category || "";
    var chips = CATEGORIES.map(function (c) {
      return '<button class="chip cat-chip' + (c === cur ? " active" : "") +
        '" type="button" data-cat="' + c + '">' + c + "</button>";
    }).join("");
    return '<div class="tcard-cat"><span class="tcard-cat-label">category</span>' +
      '<div class="chip-row">' + chips + "</div></div>";
  }
  function mediaHtml(item) {
    var m = item.metadata || {};
    var mt = m.media_type;
    // Reddit gallery with captured image URLs → show inline gallery images (tap opens lightbox).
    if (item.source === "reddit" && Array.isArray(m.gallery) && m.gallery.length) {
      var nsfw = m.over_18 ? " nsfw" : "";
      var imgs = m.gallery.filter(safeUrl);
      if (imgs.length) {
        return '<div class="tcard-media tcard-gallery' + nsfw + '">' +
          imgs.map(function (u) {
            return '<img class="tcard-gallery-img" loading="lazy" src="' + esc(u) + '" alt="">';
          }).join("") +
          (m.over_18 ? '<span class="nsfw-tag">NSFW · tap</span>' : "") +
          "</div>";
      }
    }
    // Reddit video/media → keep the click-to-load inline embed button (don't let a
    // thumbnail replace it, which would drop the play/open affordance).
    if (item.source === "reddit" && (mt === "reddit_video" || mt === "reddit_media" || mt === "gallery")) {
      var permalink = m.permalink || item.url || "";
      var label = mt === "reddit_video" ? "▶ Play"
        : (mt === "gallery" || /\/gallery\//i.test(item.url || "") ? "🖼 Gallery" : "▶ Preview");
      return '<div class="tcard-media tcard-embed" data-permalink="' + esc(permalink) + '">' +
        '<button class="rd-preview-lg" type="button">' + label + "</button></div>";
    }
    var thumb = m.thumbnail || "";
    if (!thumb && item.source === "hackernews") thumb = m.og_image || "";  // article preview (Epic 15 P3)
    if (!thumb && item.url) {
      if (/\.(png|jpe?g|gif|webp)$/i.test(item.url)) thumb = item.url;
      var yt = (item.url.match(/(?:v=|youtu\.be\/|\/shorts\/)([\w-]{6,})/) || [])[1];
      if (yt) thumb = "https://i.ytimg.com/vi/" + yt + "/hqdefault.jpg";
    }
    if (thumb) {
      var nsfw = m.over_18 ? " nsfw" : "";
      return '<div class="tcard-media' + nsfw + '"><img loading="lazy" src="' + esc(thumb) +
        '" alt="">' + (m.over_18 ? '<span class="nsfw-tag">NSFW · tap</span>' : "") + "</div>";
    }
    return "";
  }
  var _rmStart = /^\s*\[\s*(removed|deleted)/i;
  var _rmPhrase = /\b(removed by (reddit|a moderator|the moderators|moderator)|deleted by user)\b/i;
  function isRemoved(item) {
    if (item.source !== "reddit") return false;
    return _rmStart.test(item.body || "") || _rmPhrase.test(item.body || "") ||
      _rmStart.test(item.title || "") || _rmPhrase.test(item.title || "");
  }
  function recoverHtml(item) {
    return isRemoved(item)
      ? '<div class="tcard-recover"><button class="recover-btn" data-recover type="button">↻ Recover from archives</button></div>'
      : "";
  }
  // "Why this surfaced" — the top signals from the learned triage score, humanized by
  // stripping the model's feature prefixes (sub:/sk:/chan:/media:/cat:/age:) and the ×lift.
  function humanizeWhy(w) {
    var m = /^([a-z]+):([^×]+?)(?:\s*×.*)?$/.exec(String(w == null ? "" : w));
    if (!m) return String(w == null ? "" : w).trim();
    var k = m[1], v = m[2].trim();
    if (k === "sub") return "r/" + v;
    if (k === "sk") return v.replace("/", " ");   // reddit/post -> reddit post
    return v;                                      // chan / media / cat / age value
  }
  function whyHtml(item) {
    var why = (item.metadata || {}).triage_why;
    if (!Array.isArray(why) || !why.length) return "";
    var parts = why.map(humanizeWhy).filter(Boolean);
    if (!parts.length) return "";
    return '<div class="tcard-why" title="Why this surfaced — signals you tend to act on">' +
      '<span class="why-lead" aria-hidden="true">&#8593;</span> ' + esc(parts.join(" · ")) + "</div>";
  }

  function cardHtml(item) {
    var href = itemUrl(item);
    var title = item.title || (href || item.fullname);
    var titleHtml = safeUrl(href)
      ? '<a href="' + esc(href) + '" target="_blank" rel="noopener">' + esc(title) + "</a>"
      : esc(title);
    var snippet = (item.body || "").slice(0, 400);
    var m = item.metadata || {};
    var ai = m.llm ? aiHtml(m.llm) : '<button class="ai-btn" type="button">🤖 Ask AI</button>';
    return '<article class="tcard" data-fullname="' + esc(item.fullname) + '">' +
      '<span class="tcard-stamp stamp-arch">' + chIcon("archive") + ' Archive</span>' +
      '<span class="tcard-stamp stamp-done">Done ' + chIcon("done") + '</span>' +
      '<div class="tcard-head">' + badge(item) + "</div>" +
      mediaHtml(item) +
      '<h2 class="tcard-title">' + titleHtml + "</h2>" +
      '<div class="tcard-meta">' + metaLine(item) + "</div>" +
      whyHtml(item) +
      datesLine(item) +
      companionsHtml(item) +
      tagChips(item) +
      catHtml(item) +
      recoverHtml(item) +
      (snippet ? '<p class="tcard-snippet">' + esc(snippet) + "</p>" : "") +
      '<div class="tcard-ai">' + ai + "</div>" +
      "</article>";
  }

  function aiHtml(llm) {
    var tags = (llm.tags || []).map(function (t) {
      return '<span class="ai-tag">' + esc(t) + "</span>";
    }).join("");
    return '<span class="ai-verdict ai-' + esc(llm.verdict) + '">AI: ' + esc(llm.verdict) + "</span> " +
      '<span class="ai-reason">' + esc(llm.reason || "") + "</span> " + tags;
  }

  // ---- rendering / flow ----
  function updateProgress() {
    // Wins-forward, never a "N left" debt frame: finishable batch progress + today's clears.
    var total = reviewed + queue.length;
    var batch = total ? reviewed + " of " + total + " cleared" : "";
    progressEl.textContent = batch + (todayCleared ? " · " + todayCleared + " today" : "");
  }
  function showEmpty(show) {
    emptyEl.hidden = !show;
    actionsEl.hidden = show;
    if (show) {
      if (!emptyStamped) {                                 // fire the celebration once per emptying
        emptyStamped = true;
        if (window.chHaptic) window.chHaptic("milestone");
      }
      var sub = document.getElementById("triage-empty-sub");
      if (sub) sub.textContent = todayCleared
        ? todayCleared + " cleared today — nice work."
        : "Nothing waiting here. No rush.";
    } else {
      emptyStamped = false;
    }
  }
  function renderCurrent() {
    if (!queue.length) { stack.innerHTML = ""; showEmpty(true); updateProgress(); return; }
    showEmpty(false);
    stack.innerHTML = cardHtml(queue[0]);
    attachSwipe(stack.querySelector(".tcard"));
    updateProgress();
  }
  // Resume / re-entry (design-language §7): persist the live queue + position so reopening
  // /triage picks up mid-flow instead of dealing a cold fresh batch. Lapse-tolerant — a week
  // away still resumes; older sessions quietly start fresh, no guilt, no backfill debt.
  var SESSION_KEY = "ch_triage_session";
  var SESSION_TTL_MS = 7 * 86400 * 1000;
  function saveSession() {
    try {
      if (queue.length) {
        localStorage.setItem(SESSION_KEY, JSON.stringify({
          queue: queue, reviewed: reviewed,
          src: srcFilter ? srcFilter.value : "", savedAt: Date.now(),
        }));
      } else {
        localStorage.removeItem(SESSION_KEY);   // finished the queue → nothing to resume
      }
    } catch (_e) {}
  }
  function loadSession() {
    try {
      var s = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
      if (!s || !Array.isArray(s.queue) || !s.queue.length) return null;
      if (Date.now() - (s.savedAt || 0) > SESSION_TTL_MS) { localStorage.removeItem(SESSION_KEY); return null; }
      return s;
    } catch (_e) { return null; }
  }
  function loadBatch() {
    var src = srcFilter ? srcFilter.value : "";
    // mode=smart ranks by the learned likely-to-process score (Epic 10); it falls back to
    // random server-side when no scores exist yet, so it's always safe as the default.
    var url = "/random?n=" + BATCH + "&unprocessed=1&mode=smart" + (src ? "&source=" + encodeURIComponent(src) : "");
    return fetchJSON(url).then(function (data) {
      queue = data.items || [];
      reviewed = 0;
      renderCurrent();
      saveSession();
    });
  }

  function commit(status) {
    if (!queue.length) return;
    if (window.chHaptic) window.chHaptic(status);   // tactile confirm on the decision
    var item = queue[0];
    var dir = status === "archived" ? 1 : -1;  // archive flings right, done/keep fling left
    animateOut(stack.querySelector(".tcard"), dir);
    fetchJSON("/items/" + encodeURIComponent(item.fullname) + "/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: status })
    }).then(function () {
      lastAction = { fullname: item.fullname, status: status };
      updateUndoBtn();
      toast(status.charAt(0).toUpperCase() + status.slice(1), true);
    }).catch(function () { toast("Failed — check connection", false); });
    queue.shift();
    reviewed++;
    todayCleared++;
    saveSession();   // persist the remaining queue so reopening resumes mid-flow
    setTimeout(function () { if (!queue.length) loadBatch(); else renderCurrent(); }, 180);
  }

  function undo() {
    if (!lastAction) return;
    if (window.chHaptic) window.chHaptic("undo");
    var fn = lastAction.fullname;
    fetchJSON("/items/" + encodeURIComponent(fn) + "/undo", { method: "POST" })
      .then(function (item) {
        queue.unshift(item);
        reviewed = Math.max(0, reviewed - 1);
        todayCleared = Math.max(0, todayCleared - 1);
        lastAction = null;
        updateUndoBtn();
        renderCurrent();
        saveSession();
      });
  }

  // ---- swipe (pointer events) ----
  function animateOut(card, dir) {
    if (!card) return;
    card.style.transition = "transform .18s ease-out, opacity .18s ease-out";
    card.style.transform = "translateX(" + (dir * 130) + "%) rotate(" + (dir * 12) + "deg)";
    card.style.opacity = "0";
  }
  function attachSwipe(card) {
    if (!card) return;
    var startX = 0, dragging = false;
    card.addEventListener("pointerdown", function (e) {
      // Android back-gesture safety: ignore drags starting near a screen edge.
      if (e.clientX < EDGE_DEADZONE || e.clientX > window.innerWidth - EDGE_DEADZONE) return;
      if (e.target.closest("a,button,.tcard-gallery-img")) return;      // let links/buttons/gallery work
      dragging = true; startX = e.clientX;
      card.setPointerCapture(e.pointerId);
      card.style.transition = "none";
    });
    card.addEventListener("pointermove", function (e) {
      if (!dragging) return;
      var dx = e.clientX - startX;
      card.style.transform = "translateX(" + dx + "px) rotate(" + (dx * 0.04) + "deg)";
      card.style.opacity = String(Math.max(0.5, 1 - Math.abs(dx) / 320));
      card.classList.toggle("swipe-arch", dx > 40);
      card.classList.toggle("swipe-done", dx < -40);
    });
    function end(e) {
      if (!dragging) return;
      dragging = false;
      var dx = e.clientX - startX;
      card.style.transition = "transform .2s ease-out, opacity .2s ease-out";
      if (Math.abs(dx) >= COMMIT_PX) {
        commit(dx > 0 ? "archived" : "done");
      } else {
        card.style.transform = "translateX(0) rotate(0)";
        card.style.opacity = "1";
        card.classList.remove("swipe-arch", "swipe-done");
      }
    }
    card.addEventListener("pointerup", end);
    card.addEventListener("pointercancel", function () { dragging = false; renderCurrent(); });
  }

  // NSFW reveal + Ask AI + gallery lightbox
  stack.addEventListener("click", function (e) {
    // NSFW check must run before the gallery lightbox: the first tap on a blurred
    // gallery un-blurs it; only an already-revealed gallery opens the lightbox.
    var media = e.target.closest(".tcard-media.nsfw");
    if (media) { media.classList.remove("nsfw"); return; }
    // Inline gallery image → open lightbox with all gallery images
    var galImg = e.target.closest(".tcard-gallery-img");
    if (galImg) {
      var galHolder = galImg.closest(".tcard-gallery");
      if (galHolder) {
        var urls = Array.prototype.map.call(
          galHolder.querySelectorAll(".tcard-gallery-img"),
          function (img) { return img.getAttribute("src"); }
        );
        openGallery(urls);
      }
      return;
    }
    var pv = e.target.closest(".rd-preview-lg");
    if (pv) {
      var holder = e.target.closest(".tcard-embed");
      var permalink = holder ? holder.getAttribute("data-permalink") : "";
      if (/^https?:\/\//i.test(permalink)) {
        holder.innerHTML = '<iframe class="reddit-embed-frame" src="' + esc(redditEmbedUrl(permalink)) +
          '" loading="lazy"></iframe>' +
          '<a class="media-fallback" href="' + esc(permalink) + '" target="_blank" rel="noopener">Open on Reddit ↗</a>';
      }
      return;
    }
    var rb = e.target.closest("[data-recover]");
    if (rb) {
      var rcard = rb.closest(".tcard");
      var rfn = rcard ? rcard.getAttribute("data-fullname") : "";
      if (!rfn) return;
      rb.disabled = true; rb.textContent = "…";
      fetchJSON("/items/" + encodeURIComponent(rfn) + "/recover", { method: "POST" })
        .then(function (d) {
          if (d && d.recovered) {
            var ttl = rcard.querySelector(".tcard-title");
            if (ttl && d.title) ttl.textContent = d.title;
            if (d.body) {
              var meta = rcard.querySelector(".tcard-meta");
              var snip = rcard.querySelector(".tcard-snippet");
              if (!snip && meta) {
                snip = document.createElement("p"); snip.className = "tcard-snippet";
                meta.parentNode.insertBefore(snip, meta.nextSibling);
              }
              if (snip) snip.textContent = d.body.slice(0, 400);
            }
            rb.textContent = "✓ recovered";
            toast("Recovered from archives", false);
          } else { rb.disabled = false; rb.textContent = "not archived"; }
        })
        .catch(function () { rb.disabled = false; rb.textContent = "↻ Recover from archives"; });
      return;
    }
    var chip = e.target.closest(".cat-chip");
    if (chip) {
      var cat = chip.getAttribute("data-cat");
      // bind to the chip's own card, NOT queue[0] — during a swipe's animate-out the
      // outgoing card's chips are still in the DOM while queue[0] is already the next item.
      var cardEl = chip.closest(".tcard");
      var fn = cardEl ? cardEl.getAttribute("data-fullname") : "";
      if (!fn) return;
      fetchJSON("/items/" + encodeURIComponent(fn) + "/category", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category: cat })
      }).then(function () {
        if (queue[0] && queue[0].fullname === fn) {
          queue[0].metadata = queue[0].metadata || {};
          queue[0].metadata.category = cat;
        }
        var rowEl = chip.closest(".chip-row");
        if (rowEl) Array.prototype.forEach.call(rowEl.querySelectorAll(".cat-chip"), function (c) {
          c.classList.toggle("active", c === chip);
        });
        toast("Category: " + cat, false);
      }).catch(function () { toast("Failed — check connection", false); });
      return;
    }
    var aiBtn = e.target.closest(".ai-btn");
    if (aiBtn && queue.length) {
      aiBtn.textContent = "…thinking";
      var fn = queue[0].fullname;
      fetchJSON("/items/" + encodeURIComponent(fn) + "/suggest", { method: "POST" })
        .then(function (s) {
          if (queue[0]) {
            queue[0].metadata = queue[0].metadata || {};
            queue[0].metadata.llm = s;
          }
          var holder = aiBtn.parentNode;
          if (holder) holder.innerHTML = aiHtml(s);
        })
        .catch(function () { aiBtn.textContent = "AI unavailable"; });
    }
  });

  // ---- toast ----
  function toast(msg, withUndo) {
    clearTimeout(toastTimer);
    toastEl.innerHTML = esc(msg) + (withUndo ? ' <button class="toast-undo">Undo</button>' : "");
    toastEl.hidden = false;
    if (withUndo) toastEl.querySelector(".toast-undo").addEventListener("click", undo);
    toastTimer = setTimeout(function () { toastEl.hidden = true; }, 5000);
  }

  // ---- input wiring ----
  actionsEl.addEventListener("click", function (e) {
    var b = e.target.closest("[data-action]");
    if (b) commit(b.getAttribute("data-action"));
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && shortcutModal && !shortcutModal.hidden) { closeShortcuts(); return; }
    if (isTypingTarget(e.target)) return;
    var k = e.key.toLowerCase();
    if (k === "?") { e.preventDefault(); toggleShortcuts(); }
    else if (shortcutModal && !shortcutModal.hidden) return;
    else if (k === "e" || k === "arrowright") commit("archived");
    else if (k === "y" || k === "arrowleft") commit("done");
    else if (k === "s") commit("keep");
    else if (k === "z" || k === "u") undo();
  });
  var nb = document.getElementById("next-batch");
  if (nb) nb.addEventListener("click", loadBatch);
  if (srcFilter) srcFilter.addEventListener("change", loadBatch);

  function updateUndoBtn() { if (undoBtn) undoBtn.disabled = !lastAction; }
  if (undoBtn) undoBtn.addEventListener("click", undo);

  function setActiveChip() {
    if (!batchChips) return;
    Array.prototype.forEach.call(batchChips.children, function (c) {
      c.classList.toggle("active", parseInt(c.getAttribute("data-batch"), 10) === BATCH);
    });
  }
  if (menuBtn) menuBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    var willOpen = menuPop.hidden;
    menuPop.hidden = !willOpen;
    menuBtn.setAttribute("aria-expanded", String(willOpen));
    if (willOpen) { setActiveChip(); ruRefreshPop(); }
  });

  // Reddit unsave: the button DRAINS the unsave queue (unsaves the queued items on
  // Reddit) — labelled "Unsave queued (N)" so it doesn't read as a content sync. Only
  // shown when a cookie is configured.
  function ruRefreshPop() {
    if (!ruPop) return;
    fetchJSON("/reddit/unsave/status").then(function (s) {
      if (!s.configured) { ruPop.hidden = true; return; }
      ruPop.hidden = false;
      ruPopStatus.textContent = s.pending ? (s.pending + " queued to unsave") : "nothing queued";
      ruSyncBtn.textContent = s.pending ? ("Unsave queued (" + s.pending + ")") : "Unsave queued";
      ruSyncBtn.disabled = !s.pending;
    }).catch(function () {});
  }
  if (ruSyncBtn) ruSyncBtn.addEventListener("click", function () {
    ruSyncBtn.disabled = true;
    ruPopStatus.textContent = "Unsaving…";
    fetchJSON("/reddit/unsave/drain", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}"
    }).then(function (res) {
      if (res.auth_error) toast("Reddit session expired — re-paste your cookie on Browse", false);
      else toast("Unsaved " + res.unsaved + (res.failed ? " · " + res.failed + " failed" : ""), false);
      ruRefreshPop();
    }).catch(function () { toast("Sync failed", false); ruRefreshPop(); });
  });
  if (batchChips) batchChips.addEventListener("click", function (e) {
    var c = e.target.closest(".chip");
    if (!c) return;
    BATCH = parseInt(c.getAttribute("data-batch"), 10) || 20;
    localStorage.setItem("ch_batch", String(BATCH));
    setActiveChip();
    menuPop.hidden = true;
    menuBtn.setAttribute("aria-expanded", "false");
    loadBatch();
  });
  document.addEventListener("click", function (e) {
    if (menuPop && !menuPop.hidden && !e.target.closest(".menu")) {
      menuPop.hidden = true;
      menuBtn.setAttribute("aria-expanded", "false");
    }
  });
  if (shortcutClose) shortcutClose.addEventListener("click", closeShortcuts);
  if (shortcutModal) shortcutModal.addEventListener("click", function (e) {
    if (e.target === shortcutModal) closeShortcuts();
  });
  // Media modal close wiring (gallery lightbox)
  var mediaCloseBtn = document.getElementById("media-close");
  if (mediaCloseBtn) mediaCloseBtn.addEventListener("click", closeMedia);
  var mediaModal = document.getElementById("media-modal");
  if (mediaModal) mediaModal.addEventListener("click", function (e) {
    if (e.target === mediaModal) closeMedia();
  });
  updateUndoBtn();
  fillIcons(document);   // hydrate the static [data-ico] action-button glyphs (icons.js auto-fill retired)

  // ---- boot ----
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/static/sw.js").catch(function (err) {
    // Service workers (and therefore PWA install) only work in a secure context:
    // HTTPS, or localhost/127.0.0.1. Plain HTTP over a LAN or Tailscale IP fails
    // here silently — surface it so the cause is visible. See docs/MOBILE_TAILSCALE.md.
    console.warn("Service worker registration failed (needs HTTPS or localhost):", err);
  });
  // Today's clears (shared with browse) so the header shows accumulating wins across batches.
  fetchJSON("/pulse").then(function (p) { todayCleared = (p && p.cleared_today) || 0; updateProgress(); }).catch(function () {});
  fetchJSON("/sources").then(function (data) {
    (data.sources || []).forEach(function (s) {
      sources[s.id] = s;
      if (srcFilter && s.count > 0) {
        var o = document.createElement("option");
        o.value = s.id; o.textContent = s.label + " (" + s.count + ")";
        srcFilter.appendChild(o);
      }
    });
    // Honor ?source=<id> so the "Reddit"/"Triage" links land pre-filtered.
    var qsSource = new URLSearchParams(location.search).get("source");
    if (qsSource && srcFilter) srcFilter.value = qsSource;
  }).then(function () {
    // Resume where you left off — unless an explicit ?source means "deal a fresh filtered batch".
    var explicit = new URLSearchParams(location.search).get("source");
    var s = explicit ? null : loadSession();
    if (s) {
      queue = s.queue;
      reviewed = s.reviewed || 0;
      if (srcFilter && s.src) srcFilter.value = s.src;
      renderCurrent();
      toast("Picked up where you left off", false);
    } else {
      loadBatch();
    }
  }).catch(loadBatch);
})();
