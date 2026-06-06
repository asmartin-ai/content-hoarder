/* Triage focus mode: one card at a time, swipe / keyboard / buttons.
   Pixel-6 / Android gesture-nav safe: 30px edge deadzone + inset card + tap buttons. */
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

  var queue = [];
  var reviewed = 0;
  var sources = {};
  var lastAction = null;       // {fullname, status} for undo
  var toastTimer = null;

  // ---- helpers ----
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function safeUrl(u) { return /^(https?:\/\/|\/)/i.test(u || "") ? u : ""; }
  function ago(ts) {
    if (!ts) return "";
    var d = Math.floor(Date.now() / 1000) - ts;
    if (d < 0) return "";
    var u = [["y", 31536000], ["mo", 2592000], ["d", 86400], ["h", 3600], ["m", 60]];
    for (var i = 0; i < u.length; i++) if (d >= u[i][1]) return Math.floor(d / u[i][1]) + u[i][0];
    return "now";
  }
  function fetchJSON(url, opts) {
    return fetch(url, opts).then(function (r) { return r.ok ? r.json() : Promise.reject(r); });
  }

  // Reddit retired its blockquote + platform.js embed (the script now 404s), so embed the
  // official redditmedia.com iframe directly. Online-only; the permalink link is the fallback.
  function redditEmbedUrl(permalink) {
    var base = (permalink || "").split("#")[0].split("?")[0]
      .replace(/^https?:\/\/([a-z0-9-]+\.)?reddit\.com/i, "https://www.redditmedia.com");
    return base + "?ref_source=embed&ref=share&embed=true&theme=dark";
  }

  function badge(item) {
    var s = sources[item.source] || { label: item.source, badge_color: "#888" };
    return '<span class="badge" style="--c:' + esc(s.badge_color) + '">' + esc(s.label) + "</span>";
  }
  function metaLine(item) {
    var m = item.metadata || {};
    var bits = [];
    if (item.author) bits.push("by " + esc(item.author));
    if (m.subreddit) bits.push("r/" + esc(m.subreddit));
    if (m.channel) bits.push(esc(m.channel));
    if (m.playlist) bits.push(esc(m.playlist));
    if (item.kind) bits.push(esc(item.kind));
    if (typeof m.score === "number") bits.push(m.score + " pts");
    return bits.join(" · ");
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
    // Reddit video/gallery → keep the click-to-load inline embed button (don't let a
    // thumbnail replace it, which would drop the play/open affordance).
    if (item.source === "reddit" && (mt === "reddit_video" || mt === "reddit_media" || mt === "gallery")) {
      var permalink = m.permalink || item.url || "";
      var label = mt === "reddit_video" ? "▶ Play"
        : (mt === "gallery" || /\/gallery\//i.test(item.url || "") ? "🖼 Gallery" : "▶ Preview");
      return '<div class="tcard-media tcard-embed" data-permalink="' + esc(permalink) + '">' +
        '<button class="rd-preview-lg" type="button">' + label + "</button></div>";
    }
    var thumb = m.thumbnail || "";
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
  function cardHtml(item) {
    var title = item.title || (item.url || item.fullname);
    var titleHtml = safeUrl(item.url)
      ? '<a href="' + esc(item.url) + '" target="_blank" rel="noopener">' + esc(title) + "</a>"
      : esc(title);
    var snippet = (item.body || "").slice(0, 400);
    var m = item.metadata || {};
    var ai = m.llm ? aiHtml(m.llm) : '<button class="ai-btn" type="button">🤖 Ask AI</button>';
    return '<article class="tcard" data-fullname="' + esc(item.fullname) + '">' +
      '<span class="tcard-stamp stamp-keep">✓ Keep</span>' +
      '<span class="tcard-stamp stamp-arch">🗑 Archive</span>' +
      '<div class="tcard-head">' + badge(item) +
      '<span class="tcard-age">' + esc(ago(item.created_utc || item.first_seen_utc)) + "</span></div>" +
      mediaHtml(item) +
      '<h2 class="tcard-title">' + titleHtml + "</h2>" +
      '<div class="tcard-meta">' + metaLine(item) + "</div>" +
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
    progressEl.textContent = "Reviewed " + reviewed + " · " + queue.length + " left";
  }
  function showEmpty(show) {
    emptyEl.hidden = !show;
    actionsEl.hidden = show;
  }
  function renderCurrent() {
    if (!queue.length) { stack.innerHTML = ""; showEmpty(true); updateProgress(); return; }
    showEmpty(false);
    stack.innerHTML = cardHtml(queue[0]);
    attachSwipe(stack.querySelector(".tcard"));
    updateProgress();
  }
  function loadBatch() {
    var src = srcFilter ? srcFilter.value : "";
    var url = "/random?n=" + BATCH + "&unprocessed=1" + (src ? "&source=" + encodeURIComponent(src) : "");
    return fetchJSON(url).then(function (data) {
      queue = data.items || [];
      reviewed = 0;
      renderCurrent();
    });
  }

  function commit(status) {
    if (!queue.length) return;
    var item = queue[0];
    var dir = status === "keep" ? 1 : (status === "archived" ? -1 : 0);
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
    setTimeout(function () { if (!queue.length) loadBatch(); else renderCurrent(); }, 180);
  }

  function undo() {
    if (!lastAction) return;
    var fn = lastAction.fullname;
    fetchJSON("/items/" + encodeURIComponent(fn) + "/undo", { method: "POST" })
      .then(function (item) {
        queue.unshift(item);
        reviewed = Math.max(0, reviewed - 1);
        lastAction = null;
        updateUndoBtn();
        renderCurrent();
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
      if (e.target.closest("a,button")) return;      // let links/buttons work
      dragging = true; startX = e.clientX;
      card.setPointerCapture(e.pointerId);
      card.style.transition = "none";
    });
    card.addEventListener("pointermove", function (e) {
      if (!dragging) return;
      var dx = e.clientX - startX;
      card.style.transform = "translateX(" + dx + "px) rotate(" + (dx * 0.04) + "deg)";
      card.style.opacity = String(Math.max(0.5, 1 - Math.abs(dx) / 320));
      card.classList.toggle("swipe-keep", dx > 40);
      card.classList.toggle("swipe-arch", dx < -40);
    });
    function end(e) {
      if (!dragging) return;
      dragging = false;
      var dx = e.clientX - startX;
      card.style.transition = "transform .2s ease-out, opacity .2s ease-out";
      if (Math.abs(dx) >= COMMIT_PX) {
        commit(dx > 0 ? "keep" : "archived");
      } else {
        card.style.transform = "translateX(0) rotate(0)";
        card.style.opacity = "1";
        card.classList.remove("swipe-keep", "swipe-arch");
      }
    }
    card.addEventListener("pointerup", end);
    card.addEventListener("pointercancel", function () { dragging = false; renderCurrent(); });
  }

  // NSFW reveal + Ask AI
  stack.addEventListener("click", function (e) {
    var media = e.target.closest(".tcard-media.nsfw");
    if (media) { media.classList.remove("nsfw"); return; }
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
    if (/input|select|textarea/i.test((e.target.tagName || ""))) return;
    var k = e.key.toLowerCase();
    if (k === "a" || k === "arrowleft") commit("archived");
    else if (k === "k" || k === "arrowright") commit("keep");
    else if (k === "d") commit("done");
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

  // Reddit unsave: show a "Sync now (N)" control only when a cookie is configured.
  function ruRefreshPop() {
    if (!ruPop) return;
    fetchJSON("/reddit/unsave/status").then(function (s) {
      if (!s.configured) { ruPop.hidden = true; return; }
      ruPop.hidden = false;
      ruPopStatus.textContent = s.pending ? (s.pending + " queued to unsave") : "all synced";
      ruSyncBtn.textContent = s.pending ? ("Sync now (" + s.pending + ")") : "Sync now";
      ruSyncBtn.disabled = !s.pending;
    }).catch(function () {});
  }
  if (ruSyncBtn) ruSyncBtn.addEventListener("click", function () {
    ruSyncBtn.disabled = true;
    ruPopStatus.textContent = "Syncing…";
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
  updateUndoBtn();

  // ---- boot ----
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/static/sw.js").catch(function () {});
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
  }).then(loadBatch).catch(loadBatch);
})();
