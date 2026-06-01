/* Triage focus mode: one card at a time, swipe / keyboard / buttons.
   Pixel-6 / Android gesture-nav safe: 30px edge deadzone + inset card + tap buttons. */
(function () {
  "use strict";

  var EDGE_DEADZONE = 30;     // ignore pointerdown within 30px of a screen edge
  var COMMIT_PX = 80;         // horizontal distance to commit a swipe
  var BATCH = 20;

  var stack = document.getElementById("card-stack");
  var progressEl = document.getElementById("progress");
  var emptyEl = document.getElementById("triage-empty");
  var actionsEl = document.getElementById("actions");
  var srcFilter = document.getElementById("source-filter");
  var toastEl = document.getElementById("toast");

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
  function mediaHtml(item) {
    var m = item.metadata || {};
    var thumb = m.thumbnail || "";
    if (!thumb && item.url) {
      if (/\.(png|jpe?g|gif|webp)$/i.test(item.url)) thumb = item.url;
      var yt = (item.url.match(/(?:v=|youtu\.be\/|\/shorts\/)([\w-]{6,})/) || [])[1];
      if (yt) thumb = "https://i.ytimg.com/vi/" + yt + "/hqdefault.jpg";
    }
    if (!thumb) return "";
    var nsfw = m.over_18 ? " nsfw" : "";
    return '<div class="tcard-media' + nsfw + '"><img loading="lazy" src="' + esc(thumb) +
      '" alt="">' + (m.over_18 ? '<span class="nsfw-tag">NSFW · tap</span>' : "") + "</div>";
  }
  function cardHtml(item) {
    var title = item.title || (item.url || item.fullname);
    var titleHtml = item.url
      ? '<a href="' + esc(item.url) + '" target="_blank" rel="noopener">' + esc(title) + "</a>"
      : esc(title);
    var snippet = (item.body || "").slice(0, 400);
    return '<article class="tcard" data-fullname="' + esc(item.fullname) + '">' +
      '<div class="tcard-head">' + badge(item) +
      '<span class="tcard-age">' + esc(ago(item.created_utc || item.first_seen_utc)) + "</span></div>" +
      mediaHtml(item) +
      '<h2 class="tcard-title">' + titleHtml + "</h2>" +
      '<div class="tcard-meta">' + metaLine(item) + "</div>" +
      (snippet ? '<p class="tcard-snippet">' + esc(snippet) + "</p>" : "") +
      "</article>";
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
      if (e.target.closest("a")) return;             // let links work
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

  // NSFW reveal
  stack.addEventListener("click", function (e) {
    var media = e.target.closest(".tcard-media.nsfw");
    if (media) media.classList.remove("nsfw");
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
  }).then(loadBatch).catch(loadBatch);
})();
