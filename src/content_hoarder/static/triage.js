/* Triage focus mode: one card at a time, swipe / keyboard / buttons.
   Pixel-6 / Android gesture-nav safe: 30px edge deadzone + inset card + tap buttons. */
import { esc, safeUrl, isTypingTarget, ago } from "./core/util.js";
import { getJSON as fetchJSON, postJSON } from "./core/api.js";
import { normTag, itemTags, suggestTags } from "./core/tags.js";
import { chIcon, fillIcons } from "./core/icons.js";
import {
  imageUrl,
  mediaType,
  playableVideoSrc,
  mountVideo,
  canRecoverArchiveToday,
  archiveTodayConfirmText,
} from "./core/media.js"; // shared media (parity with browse)
import { attachSwipe as attachSharedSwipe } from "./core/swipe.js";
import { pushOverlay, settleTop } from "./core/overlaynav.js"; // OS back-button closes the lightbox, not the app

(function () {
  "use strict";

  installTriageEntryBackGuard();

  var EDGE_DEADZONE = 30; // ignore pointerdown within 30px of a screen edge
  var COMMIT_PX = 80; // horizontal distance to commit a swipe
  var LONG_LEFT_PX = 170; // long-left snoozes instead of marking done
  var BATCH = parseInt(localStorage.getItem("ch_batch"), 10) || 20;

  var stack = document.getElementById("card-stack");
  var progressEl = document.getElementById("progress");
  var emptyEl = document.getElementById("triage-empty");
  var actionsEl = document.getElementById("actions");
  var srcFilter = document.getElementById("source-filter");
  var filterBtn = document.getElementById("filter-btn");
  var filterPop = document.getElementById("filter-pop");
  var filterCount = document.getElementById("filter-count");
  var categoryFilters = document.getElementById("category-filters");
  var tagFilters = document.getElementById("tag-filters");
  var modeFilter = document.getElementById("mode-filter");
  var activeFilters = document.getElementById("filter-active");
  var activeFiltersPop = document.getElementById("filter-active-pop");
  var filterClearPop = document.getElementById("filter-clear-pop");
  var toastEl = document.getElementById("toast");
  var undoBtn = document.getElementById("undo-btn");
  var skipBtn = document.getElementById("skip-btn");
  var skipRow = document.getElementById("skip-row");
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
  var todayCleared = 0; // today's manual clears, shared with browse via /pulse — wins, never debt
  var emptyStamped = false; // guard so the "page cleared" milestone fires once per emptying
  var sources = {};
  var categoryFacets = [];
  var tagFacets = [];
  var lastAction = null; // {fullname, status} for undo
  var toastTimer = null;
  var FILTER_KEY = "ch_triage_filters_v1";
  var DEFAULT_FILTERS = { source: "", category: "", tags: [], mode: "smart" };
  var filters = loadFilters();

  // ---- helpers: esc/safeUrl/isTypingTarget/ago/fetchJSON imported from core (see top of file) ----

  function uniqTags(list) {
    var out = [];
    (Array.isArray(list) ? list : []).forEach(function (raw) {
      var t = normTag(raw);
      if (t && out.indexOf(t) === -1) out.push(t);
    });
    return out;
  }

  function normalizeFilters(raw) {
    raw = raw || {};
    var mode = String(raw.mode || DEFAULT_FILTERS.mode).toLowerCase();
    if (["smart", "recent", "random"].indexOf(mode) === -1) mode = "smart";
    return {
      source: String(raw.source || "").trim(),
      category: String(raw.category || "")
        .trim()
        .toLowerCase(),
      tags: uniqTags(raw.tags),
      mode: mode,
    };
  }

  function loadFilters() {
    try {
      return normalizeFilters(
        JSON.parse(localStorage.getItem(FILTER_KEY) || "null"),
      );
    } catch (_e) {
      return normalizeFilters(DEFAULT_FILTERS);
    }
  }

  function saveFilters() {
    try {
      localStorage.setItem(FILTER_KEY, JSON.stringify(filters));
    } catch (_e) {}
  }

  function filterFingerprint() {
    return JSON.stringify({
      source: filters.source || "",
      category: filters.category || "",
      tags: filters.tags.slice().sort(),
      mode: filters.mode || "smart",
    });
  }

  function activeFilterCount() {
    return (
      (filters.source ? 1 : 0) +
      (filters.category ? 1 : 0) +
      filters.tags.length +
      (filters.mode && filters.mode !== "smart" ? 1 : 0)
    );
  }

  function filterLabel(kind, value) {
    if (kind === "source") return (sources[value] || {}).label || value;
    if (kind === "mode")
      return value === "recent"
        ? "Newest"
        : value.charAt(0).toUpperCase() + value.slice(1);
    return value;
  }

  function clearSession() {
    try {
      localStorage.removeItem(SESSION_KEY);
    } catch (_e) {}
  }

  function setFilters(next, opts) {
    opts = opts || {};
    var before = filterFingerprint();
    filters = normalizeFilters(Object.assign({}, filters, next || {}));
    var after = filterFingerprint();
    saveFilters();
    renderFilters();
    if (after !== before) {
      clearSession();
      queue = [];
      reviewed = 0;
      emptyStamped = false;
      if (!opts.deferLoad) loadBatch();
    }
  }

  function navigationType() {
    try {
      var entries =
        performance.getEntriesByType &&
        performance.getEntriesByType("navigation");
      return entries && entries[0] ? entries[0].type : "";
    } catch (e) {
      return "";
    }
  }

  function hasSameOriginReferrer() {
    if (!document.referrer) return false;
    try {
      return new URL(document.referrer).origin === location.origin;
    } catch (e) {
      return false;
    }
  }

  function shouldInstallEntryBackGuard() {
    var state = history.state || {};
    if (state.chTriageEntry) return false; // reload after we already armed the sentinel

    /* Chrome/Android can report history.length > 1 for a cold PWA/page entry because
       about:blank sits below the app. Same-origin referrer is the useful "came from inside
       content-hoarder" signal; back_forward restores should not mint fresh guard entries. */
    var noPriorHistory = history.length <= 1;
    var firstAppEntry =
      !hasSameOriginReferrer() && navigationType() !== "back_forward";
    return noPriorHistory || firstAppEntry;
  }

  function installTriageEntryBackGuard() {
    if (window.__chTriageBackGuardInstalled) return;
    window.__chTriageBackGuardInstalled = true;
    window.addEventListener("popstate", function (ev) {
      if (ev.state && ev.state.chTriageInboxGuard) {
        location.replace("/");
      }
    });

    if (!shouldInstallEntryBackGuard()) return;
    var here = location.pathname + location.search + location.hash;
    var replaced = false;
    try {
      history.replaceState({ chTriageInboxGuard: true }, "", "/");
      replaced = true;
      history.pushState({ chTriageEntry: true }, "", here);
    } catch (e) {
      if (replaced) {
        try {
          history.replaceState(null, "", here);
        } catch (_e) {}
      }
      // History can be unavailable in unusual embedded contexts; natural browser back remains.
    }
  }

  // Reddit retired its blockquote + platform.js embed (the script now 404s), so embed the
  // official redditmedia.com iframe directly. Online-only; the permalink link is the fallback.
  function redditEmbedUrl(permalink) {
    var base = (permalink || "")
      .split("#")[0]
      .split("?")[0]
      .replace(
        /^https?:\/\/([a-z0-9-]+\.)?reddit\.com/i,
        "https://www.redditmedia.com",
      );
    return base + "?ref_source=embed&ref=share&embed=true&theme=dark";
  }

  function itemByFn(fn) {
    for (var i = 0; i < queue.length; i++)
      if (queue[i].fullname === fn) return queue[i];
    return null;
  }
  // Gallery lightbox: stacked images that load the sized ~1080px variants first
  // (gallery_preview) instead of the multi-MB 5000px originals — the Epic 13 P2 perf fix,
  // now applied to triage too. .media-gallery is the scroll container, so native
  // loading=lazy tracks it correctly (no IntersectionObserver needed). Tap an image to
  // swap up to its full-res original.
  function openGallery(full, previews) {
    var imgs = (full || []).filter(safeUrl);
    if (!imgs.length) return;
    var sized = (previews || []).filter(safeUrl);
    var src = sized.length === imgs.length ? sized : imgs;
    document.getElementById("media-body").innerHTML =
      '<div class="media-gallery">' +
      src
        .map(function (u, i) {
          return (
            '<img class="media-img gallery-img" loading="lazy" decoding="async" src="' +
            esc(u) +
            '" data-full="' +
            esc(imgs[i]) +
            '" alt="">'
          );
        })
        .join("") +
      "</div>" +
      '<p class="media-fallback">' +
      imgs.length +
      " images</p>";
    document.getElementById("media-modal").hidden = false;
    pushOverlay(closeMediaVisual); // register with the back-button coordinator
  }
  // Direct / catch-all image → simple lightbox (no reddit iframe dependency).
  function openImage(url) {
    if (!safeUrl(url)) return;
    document.getElementById("media-body").innerHTML =
      '<img class="media-img" src="' +
      esc(url) +
      '" alt="">' +
      '<a class="media-fallback" href="' +
      esc(url) +
      '" target="_blank" rel="noopener">Open original ↗</a>';
    document.getElementById("media-modal").hidden = false;
    pushOverlay(closeMediaVisual); // register with the back-button coordinator
  }
  // Reddit / direct video → native <video> in the lightbox (Epic 13 P2), same as browse:
  // v.redd.it plays the audio+video HLS manifest (hls.js preferred, native HLS fallback), a
  // direct .mp4/.webm keeps a plain <video src>. videoTeardown stops HLS buffering on close.
  var videoTeardown = null;
  function openVideo(srcUrl, posterUrl) {
    if (!safeUrl(srcUrl)) return;
    var body = document.getElementById("media-body");
    body.innerHTML = "";
    document.getElementById("media-modal").hidden = false;
    pushOverlay(closeMediaVisual); // register with the back-button coordinator
    var r = mountVideo(
      body,
      srcUrl,
      posterUrl && safeUrl(posterUrl) ? posterUrl : "",
      { autoplay: true },
    );
    videoTeardown = r && r.destroy ? r.destroy : null;
  }
  // Visual teardown only — touches NO history. The overlay coordinator calls this on an OS-back.
  function closeMediaVisual() {
    if (document.getElementById("media-modal").hidden) return;
    if (videoTeardown) {
      videoTeardown();
      videoTeardown = null;
    } // stop HLS buffering
    document.getElementById("media-modal").hidden = true;
    document.getElementById("media-body").innerHTML = "";
  }
  // Manual close (backdrop / button): tear down AND unwind the history entry we pushed on open.
  function closeMedia() {
    if (document.getElementById("media-modal").hidden) return;
    closeMediaVisual();
    settleTop();
  }
  function closeShortcuts() {
    if (shortcutModal) shortcutModal.hidden = true;
  }
  function toggleShortcuts() {
    if (!shortcutModal) return;
    shortcutModal.hidden = !shortcutModal.hidden;
  }
  function hnThreadUrl(item) {
    var id =
      item && item.source === "hackernews" && item.source_id
        ? String(item.source_id).trim()
        : "";
    return id
      ? "https://news.ycombinator.com/item?id=" + encodeURIComponent(id)
      : "";
  }
  function itemUrl(item) {
    return item && item.source === "hackernews"
      ? hnThreadUrl(item) || item.url || ""
      : (item && item.url) || "";
  }
  function metaAnchor(href, label) {
    var url = safeUrl(href);
    if (!url) return esc(label);
    return (
      '<a class="meta-link" href="' +
      esc(url) +
      '" target="_blank" rel="noopener" onclick="event.stopPropagation()">' +
      esc(label) +
      "</a>"
    );
  }

  function badge(item) {
    var s = sources[item.source] || { label: item.source, badge_color: "#888" };
    return (
      '<span class="badge" style="--c:' +
      esc(s.badge_color) +
      '">' +
      esc(s.label) +
      "</span>"
    );
  }
  function metaLine(item) {
    var m = item.metadata || {};
    var bits = [];
    if (item.author) {
      if (item.source === "reddit")
        bits.push(
          "by " +
            metaAnchor(
              "https://www.reddit.com/user/" + encodeURIComponent(item.author),
              item.author,
            ),
        );
      else if (item.source === "hackernews")
        bits.push(
          "by " +
            metaAnchor(
              "https://news.ycombinator.com/user?id=" +
                encodeURIComponent(item.author),
              item.author,
            ),
        );
      else bits.push("by " + esc(item.author));
    }
    if (m.subreddit)
      bits.push(
        metaAnchor(
          "https://www.reddit.com/r/" + encodeURIComponent(m.subreddit),
          "r/" + m.subreddit,
        ),
      );
    if (m.channel) bits.push(esc(m.channel));
    if (m.playlist) bits.push(esc(m.playlist));
    if (item.kind) bits.push(esc(item.kind));
    if (typeof m.score === "number") bits.push(m.score + " pts");
    // HN: a pill straight to the linked article (the title opens the discussion).
    // Self/Ask-HN posts store the thread URL in item.url, so they get no chip.
    var au = item.source === "hackernews" ? (item.url || "").trim() : "";
    if (au && !/news\.ycombinator\.com\/item\?id=/i.test(au) && safeUrl(au)) {
      bits.push(
        '<a class="comp-link art-chip" href="' +
          esc(safeUrl(au)) +
          '" target="_blank" rel="noopener" onclick="event.stopPropagation()">Article ↗</a>',
      );
    }
    return bits.join(" · ");
  }

  function fmtDate(ts) {
    return ts ? new Date(ts * 1000).toLocaleDateString() : "";
  }
  // Three distinct timestamps, labeled so they're never confused: when it was originally
  // posted (created_utc), when it was added/saved in the source app (saved_utc — only some
  // sources expose this), and when it synced into content-hoarder (first_seen_utc).
  function datesLine(item) {
    var c = item.created_utc,
      s = item.saved_utc,
      f = item.first_seen_utc;
    // Show "added in source" only when it's a real source timestamp: distinct from the post
    // time AND clearly earlier than our sync. Sources that just stamp it at import (e.g. HN)
    // or don't expose it at all (Reddit, YouTube) would otherwise add misleading noise.
    var showSaved = s && s !== c && s < f - 86400;
    var vis = [],
      tip = [];
    if (c) {
      vis.push("posted " + ago(c));
      tip.push("Posted: " + fmtDate(c));
    }
    if (showSaved) {
      vis.push("saved " + ago(s));
      tip.push("Added in source: " + fmtDate(s));
    }
    if (f) {
      vis.push("synced " + ago(f));
      tip.push("Synced here: " + fmtDate(f));
    }
    if (!vis.length) return "";
    return (
      '<div class="tcard-dates" title="' +
      esc(tip.join("\n")) +
      '">' +
      vis.join(" · ") +
      "</div>"
    );
  }

  // Manual tag editor: existing tags as removable chips + a "＋ tag" affordance that
  // picks from the known vocabulary OR takes a brand-new tag. Mirrors the category
  // chip-row precedent (render in cardHtml, network POST in the stack click handler),
  // but POSTs to /tags. Optimistic update, reconcile against the returned tags list,
  // revert + toast on error.
  var knownTags = []; // the user's tag vocabulary, cached from /tags once at boot
  // normTag / itemTags / suggestTags imported from core/tags.js (shared with reader + browse)
  function setItemTags(item, tags) {
    if (item) {
      item.metadata = item.metadata || {};
      item.metadata.tags = tags;
    }
  }
  var TAG_VISIBLE_LIMIT = 5;
  function chipRowHtml(item) {
    var tags = itemTags(item);
    var chips = tags
      .map(function (t, idx) {
        return (
          '<button class="chip tag-edit' +
          (idx >= TAG_VISIBLE_LIMIT ? " tag-extra" : "") +
          '" type="button" data-rmtag="' +
          esc(t) +
          '">' +
          esc(t) +
          '<span class="tag-x" aria-hidden="true">✕</span></button>'
        );
      })
      .join("");
    if (tags.length > TAG_VISIBLE_LIMIT)
      chips +=
        '<button class="chip tag-more" type="button" data-tagmore="1" aria-expanded="false" data-label="… +' +
        (tags.length - TAG_VISIBLE_LIMIT) +
        '">… +' +
        (tags.length - TAG_VISIBLE_LIMIT) +
        "</button>";
    return (
      chips +
      '<button class="chip tag-add" type="button" data-tagadd="1">＋ tag</button>'
    );
  }
  function tagEditorHtml(item) {
    return (
      '<div class="tcard-tags" data-tags="1">' +
      '<span class="tcard-tags-label">tags</span>' +
      '<div class="tcard-tags-body">' +
      '<div class="tcard-tagrow">' +
      chipRowHtml(item) +
      "</div>" +
      '<div class="tag-add-ui" hidden>' +
      '<input class="tag-add-input" type="search" placeholder="new or existing tag" ' +
      'autocomplete="off" autocapitalize="none" spellcheck="false" enterkeyhint="done" ' +
      'maxlength="40" aria-label="Add a tag">' +
      '<span class="tag-suggest"></span>' +
      "</div>" +
      "</div></div>"
    );
  }
  function findCardEl(fn) {
    var cards = stack.querySelectorAll(".tcard");
    for (var i = 0; i < cards.length; i++)
      if (cards[i].getAttribute("data-fullname") === fn) return cards[i];
    return null;
  }
  function refreshTagEditor(fn) {
    var card = findCardEl(fn);
    if (!card) return;
    var row = card.querySelector(".tcard-tagrow");
    if (!row) return;
    row.innerHTML = chipRowHtml(itemByFn(fn));
  }
  function refreshSuggestions(inp) {
    if (!inp) return;
    var ui = inp.closest(".tag-add-ui");
    if (!ui) return;
    var card = inp.closest(".tcard");
    var item = card ? itemByFn(card.getAttribute("data-fullname")) : null;
    // Suggestions = known vocabulary not already on the item, filtered by the query.
    var sugg = suggestTags(knownTags, itemTags(item), inp.value);
    var box = ui.querySelector(".tag-suggest");
    box.innerHTML = sugg.length
      ? sugg
          .map(function (t) {
            return (
              '<button class="chip tag-sugg" type="button" data-addtag="' +
              esc(t) +
              '">' +
              esc(t) +
              "</button>"
            );
          })
          .join("")
      : inp.value.trim()
        ? ""
        : '<span class="tag-sugg-empty">type to create a new tag</span>';
  }
  function openTagAdd(fn) {
    var card = findCardEl(fn);
    if (!card) return;
    var ui = card.querySelector(".tag-add-ui");
    if (!ui) return;
    if (!ui.hidden) {
      ui.hidden = true;
      return;
    } // toggle: a second tap collapses
    ui.hidden = false;
    var inp = ui.querySelector(".tag-add-input");
    refreshSuggestions(inp);
    if (inp) inp.focus();
  }
  function collapseTagAdd(inp) {
    var ui = inp ? inp.closest(".tag-add-ui") : null;
    if (ui) ui.hidden = true;
    if (inp) inp.value = "";
  }
  function addTag(fn, raw) {
    var item = itemByFn(fn);
    if (!item) return;
    var tag = normTag(raw);
    if (!tag) return;
    var prev = itemTags(item).slice();
    if (prev.indexOf(tag) !== -1) return; // already present
    setItemTags(item, prev.concat([tag]));
    refreshTagEditor(fn);
    postJSON("/items/" + encodeURIComponent(fn) + "/tags", { add: [tag] })
      .then(function (res) {
        setItemTags(
          item,
          Array.isArray(res.tags) ? res.tags : prev.concat([tag]),
        );
        refreshTagEditor(fn);
        var card = findCardEl(fn);
        if (card) refreshSuggestions(card.querySelector(".tag-add-input"));
      })
      .catch(function () {
        setItemTags(item, prev); // revert
        refreshTagEditor(fn);
        var card = findCardEl(fn);
        if (card) refreshSuggestions(card.querySelector(".tag-add-input"));
        toast("Couldn't add tag — check connection", false);
      });
  }
  function removeTag(fn, tag) {
    var item = itemByFn(fn);
    if (!item) return;
    var prev = itemTags(item).slice();
    setItemTags(
      item,
      prev.filter(function (t) {
        return t !== tag;
      }),
    );
    refreshTagEditor(fn);
    postJSON("/items/" + encodeURIComponent(fn) + "/tags", { remove: [tag] })
      .then(function (res) {
        setItemTags(
          item,
          Array.isArray(res.tags)
            ? res.tags
            : prev.filter(function (t) {
                return t !== tag;
              }),
        );
        refreshTagEditor(fn);
      })
      .catch(function () {
        setItemTags(item, prev); // revert
        refreshTagEditor(fn);
        toast("Couldn't remove tag — check connection", false);
      });
  }

  // Companion discussion threads folded onto a canonical YouTube item (Epic 11).
  var COMP_LABEL = {
    reddit: "Reddit",
    hackernews: "Hacker News",
    firefox: "Firefox",
  };
  function companionHref(c) {
    var u = ((c && (c.permalink || c.url)) || "").trim();
    if (/^\/r\//i.test(u)) u = "https://www.reddit.com" + u;
    return safeUrl(u);
  }
  function companionsHtml(item) {
    var list = (item.metadata || {}).companions;
    var cs = Array.isArray(list) ? list.filter(companionHref) : [];
    if (!cs.length) return "";
    var links = cs
      .map(function (c) {
        var label =
          COMP_LABEL[c.source] ||
          (sources[c.source] || {}).label ||
          c.source ||
          "link";
        return (
          '<a class="comp-link" href="' +
          esc(companionHref(c)) +
          '" target="_blank" rel="noopener" onclick="event.stopPropagation()">' +
          esc(label) +
          " ↗</a>"
        );
      })
      .join("");
    return (
      '<div class="companions" title="Saved discussion threads for this video">' +
      '<span class="comp-lead" aria-hidden="true">💬</span>' +
      links +
      "</div>"
    );
  }

  var CATEGORIES = ["listenable", "watch", "wotagei", "unknown"];
  function catHtml(item) {
    if (item.source !== "youtube") return ""; // category is a YouTube concept for now
    var cur = (item.metadata || {}).category || "";
    var chips = CATEGORIES.map(function (c) {
      return (
        '<button class="chip cat-chip' +
        (c === cur ? " active" : "") +
        '" type="button" data-cat="' +
        c +
        '">' +
        c +
        "</button>"
      );
    }).join("");
    return (
      '<div class="tcard-cat"><span class="tcard-cat-label">category</span>' +
      '<div class="chip-row">' +
      chips +
      "</div></div>"
    );
  }
  function mediaHtml(item) {
    var m = item.metadata || {};
    var mt = m.media_type;
    // Reddit gallery with captured image URLs → inline images, tap opens the lightbox.
    // Inline thumbnails use the sized ~1080px gallery_preview variants when present (not
    // the multi-MB 5000px originals) — the Epic 13 P2 perf fix, now in triage too.
    if (
      item.source === "reddit" &&
      Array.isArray(m.gallery) &&
      m.gallery.length
    ) {
      var nsfw = m.over_18 ? " nsfw" : "";
      var imgs = m.gallery.filter(safeUrl);
      var sized = Array.isArray(m.gallery_preview)
        ? m.gallery_preview.filter(safeUrl)
        : [];
      var inlineSrc = sized.length === imgs.length ? sized : imgs;
      if (imgs.length) {
        return (
          '<div class="tcard-media tcard-gallery' +
          nsfw +
          '">' +
          inlineSrc
            .map(function (u) {
              return (
                '<img class="tcard-gallery-img" loading="lazy" decoding="async" src="' +
                esc(u) +
                '" alt="">'
              );
            })
            .join("") +
          (m.over_18 ? '<span class="nsfw-tag">NSFW · tap</span>' : "") +
          "</div>"
        );
      }
    }
    // Direct / catch-all reddit image → tappable image preview (opens the simple lightbox).
    // Recognized by media SHAPE via core mediaType (parity with browse), so the reddit_media
    // catch-all posts whose url is the permalink still surface their image instead of a
    // generic embed button. Galleries are handled above, so this only catches single images.
    if (item.source === "reddit" && mediaType(item).cls === "image") {
      var iu = imageUrl(item) || m.thumbnail || "";
      if (safeUrl(iu)) {
        var insfw = m.over_18 ? " nsfw" : "";
        return (
          '<div class="tcard-media tcard-img' +
          insfw +
          '">' +
          '<img loading="lazy" decoding="async" src="' +
          esc(iu) +
          '" alt="">' +
          (m.over_18 ? '<span class="nsfw-tag">NSFW · tap</span>' : "") +
          "</div>"
        );
      }
    }
    // Reddit video with a directly-playable source (v.redd.it HLS / direct mp4) → poster +
    // play button that opens the NATIVE <video> lightbox (Epic 13 P2), same as browse —
    // no more online-only redditmedia iframe. External "videos" (YouTube, gfycat/redgifs)
    // have no playable src, so playableVideoSrc() returns "" and they fall through to the
    // iframe embed below.
    if (item.source === "reddit" && playableVideoSrc(item)) {
      var vposter = m.thumbnail || imageUrl(item) || "";
      var vnsfw = m.over_18 ? " nsfw" : "";
      return (
        '<div class="tcard-media tcard-video' +
        vnsfw +
        '">' +
        (safeUrl(vposter)
          ? '<img loading="lazy" decoding="async" src="' +
            esc(vposter) +
            '" alt="">'
          : "") +
        '<span class="tcard-play" aria-hidden="true">▶</span>' +
        (m.over_18 ? '<span class="nsfw-tag">NSFW · tap</span>' : "") +
        "</div>"
      );
    }
    // Reddit video/media → click-to-load inline embed button (don't let a thumbnail
    // replace it, which would drop the play/open affordance).
    if (
      item.source === "reddit" &&
      (mt === "reddit_video" || mt === "reddit_media" || mt === "gallery")
    ) {
      var permalink = m.permalink || item.url || "";
      var label =
        mt === "reddit_video"
          ? "▶ Play"
          : mt === "gallery" || /\/gallery\//i.test(item.url || "")
            ? "🖼 Gallery"
            : "▶ Preview";
      var isGal = mt === "gallery" || /\/gallery\//i.test(item.url || "");
      return (
        '<div class="tcard-media tcard-embed" data-permalink="' +
        esc(permalink) +
        '"' +
        (isGal ? ' data-gallery-embed="1"' : "") +
        ">" +
        '<button class="rd-preview-lg" type="button">' +
        label +
        "</button></div>"
      );
    }
    var thumb = m.thumbnail || "";
    if (!thumb && item.source === "hackernews") thumb = m.og_image || ""; // article preview (Epic 15 P3)
    if (!thumb && item.url) {
      if (/\.(png|jpe?g|gif|webp)$/i.test(item.url)) thumb = item.url;
      var yt = (item.url.match(/(?:v=|youtu\.be\/|\/shorts\/)([\w-]{6,})/) ||
        [])[1];
      if (yt) thumb = "https://i.ytimg.com/vi/" + yt + "/hqdefault.jpg";
    }
    if (thumb) {
      var nsfw = m.over_18 ? " nsfw" : "";
      return (
        '<div class="tcard-media' +
        nsfw +
        '"><img loading="lazy" src="' +
        esc(thumb) +
        '" alt="">' +
        (m.over_18 ? '<span class="nsfw-tag">NSFW · tap</span>' : "") +
        "</div>"
      );
    }
    return "";
  }
  var _rmStart = /^\s*\[\s*(removed|deleted)/i;
  var _rmPhrase =
    /\b(removed by (reddit|a moderator|the moderators|moderator)|deleted by user)\b/i;
  function isRemoved(item) {
    if (item.source !== "reddit") return false;
    return (
      _rmStart.test(item.body || "") ||
      _rmPhrase.test(item.body || "") ||
      _rmStart.test(item.title || "") ||
      _rmPhrase.test(item.title || "")
    );
  }
  function recoverHtml(item) {
    var bits = [];
    if (isRemoved(item))
      bits.push(
        '<button class="recover-btn" data-recover type="button">↻ Recover text from archives</button>',
      );
    if (canRecoverArchiveToday(item))
      bits.push(
        '<button class="recover-btn archive-today-btn" data-recover-archive-today type="button">Recover deleted media via archive.today</button>',
      );
    return bits.length
      ? '<div class="tcard-recover">' + bits.join(" ") + "</div>"
      : "";
  }
  // "Why this surfaced" — the top signals from the learned triage score, humanized by
  // stripping the model's feature prefixes (sub:/sk:/chan:/media:/cat:/age:) and the ×lift.
  function humanizeWhy(w) {
    var m = /^([a-z]+):([^×]+?)(?:\s*×.*)?$/.exec(String(w == null ? "" : w));
    if (!m) return String(w == null ? "" : w).trim();
    var k = m[1],
      v = m[2].trim();
    if (k === "sub") return "r/" + v;
    if (k === "sk") return v.replace("/", " "); // reddit/post -> reddit post
    return v; // chan / media / cat / age value
  }
  function whyHtml(item) {
    var why = (item.metadata || {}).triage_why;
    if (!Array.isArray(why) || !why.length) return "";
    var parts = why.map(humanizeWhy).filter(Boolean);
    if (!parts.length) return "";
    return (
      '<div class="tcard-why" title="Why this surfaced — signals you tend to act on">' +
      '<span class="why-lead" aria-hidden="true">&#8593;</span> ' +
      esc(parts.join(" · ")) +
      "</div>"
    );
  }

  function cardHtml(item) {
    var href = itemUrl(item);
    var title = item.title || href || item.fullname;
    var titleHtml = safeUrl(href)
      ? '<a href="' +
        esc(href) +
        '" target="_blank" rel="noopener">' +
        esc(title) +
        "</a>"
      : esc(title);
    var snippet = (item.body || "").slice(0, 400);
    var m = item.metadata || {};
    var ai = m.llm
      ? aiHtml(m.llm)
      : '<button class="ai-btn" type="button">🤖 Ask AI</button>';
    return (
      '<article class="tcard tcard-pinboard-v2" data-fullname="' +
      esc(item.fullname) +
      '">' +
      '<span class="tcard-stamp stamp-arch">' +
      chIcon("archive") +
      " Archive</span>" +
      '<span class="tcard-stamp stamp-done">Done ' +
      chIcon("done") +
      "</span>" +
      '<span class="tcard-stamp stamp-snooze">Snooze</span>' +
      '<span class="tcard-stamp stamp-open">Open</span>' +
      '<span class="tcard-stamp stamp-skip">Skip</span>' +
      '<div class="tcard-head">' +
      badge(item) +
      "</div>" +
      mediaHtml(item) +
      '<h2 class="tcard-title">' +
      titleHtml +
      "</h2>" +
      '<div class="tcard-meta">' +
      metaLine(item) +
      "</div>" +
      whyHtml(item) +
      datesLine(item) +
      companionsHtml(item) +
      tagEditorHtml(item) +
      catHtml(item) +
      recoverHtml(item) +
      (snippet ? '<p class="tcard-snippet">' + esc(snippet) + "</p>" : "") +
      '<div class="tcard-ai">' +
      ai +
      "</div>" +
      "</article>"
    );
  }

  function aiHtml(llm) {
    var tags = (llm.tags || [])
      .map(function (t) {
        return '<span class="ai-tag">' + esc(t) + "</span>";
      })
      .join("");
    return (
      '<span class="ai-verdict ai-' +
      esc(llm.verdict) +
      '">AI: ' +
      esc(llm.verdict) +
      "</span> " +
      '<span class="ai-reason">' +
      esc(llm.reason || "") +
      "</span> " +
      tags
    );
  }

  function renderSourceOptions() {
    if (!srcFilter) return;
    srcFilter.innerHTML = '<option value="">all sources</option>';
    Object.keys(sources).forEach(function (id) {
      var s = sources[id];
      if (!s || s.count <= 0) return;
      var o = document.createElement("option");
      o.value = id;
      o.textContent = s.label + " (" + s.count + ")";
      srcFilter.appendChild(o);
    });
    srcFilter.value = filters.source || "";
  }

  function chipButton(kind, id, label, count, active) {
    return (
      '<button class="chip filter-chip' +
      (active ? " active" : "") +
      '" type="button" data-filter-kind="' +
      kind +
      '" data-filter-value="' +
      esc(id) +
      '" aria-pressed="' +
      String(!!active) +
      '">' +
      esc(label) +
      (Number.isFinite(count)
        ? ' <span class="chip-count">' + count + "</span>"
        : "") +
      "</button>"
    );
  }

  function renderFacetChips() {
    if (categoryFilters) {
      var cats = categoryFacets.filter(function (c) {
        return c.count > 0;
      });
      categoryFilters.innerHTML = cats.length
        ? cats
            .map(function (c) {
              return chipButton(
                "category",
                c.id,
                c.id,
                c.count,
                filters.category === c.id,
              );
            })
            .join("")
        : '<span class="filter-empty">none</span>';
    }
    if (tagFilters) {
      tagFilters.innerHTML = tagFacets.length
        ? tagFacets
            .map(function (t) {
              return chipButton(
                "tag",
                t.id,
                t.id,
                t.count,
                filters.tags.indexOf(t.id) !== -1,
              );
            })
            .join("")
        : '<span class="filter-empty">none</span>';
    }
  }

  function renderModeControl() {
    if (!modeFilter) return;
    Array.prototype.forEach.call(
      modeFilter.querySelectorAll("[data-mode]"),
      function (btn) {
        var on = btn.getAttribute("data-mode") === filters.mode;
        btn.classList.toggle("active", on);
        btn.setAttribute("aria-pressed", String(on));
      },
    );
  }

  function activeFilterHtml() {
    var chips = [];
    if (filters.source)
      chips.push(
        chipButton(
          "clear-source",
          filters.source,
          filterLabel("source", filters.source),
          NaN,
          true,
        ),
      );
    if (filters.category)
      chips.push(
        chipButton(
          "clear-category",
          filters.category,
          filters.category,
          NaN,
          true,
        ),
      );
    filters.tags.forEach(function (t) {
      chips.push(chipButton("clear-tag", t, t, NaN, true));
    });
    if (filters.mode && filters.mode !== "smart")
      chips.push(
        chipButton(
          "clear-mode",
          filters.mode,
          filterLabel("mode", filters.mode),
          NaN,
          true,
        ),
      );
    if (!chips.length) return "";
    return (
      chips.join("") +
      '<button class="chip filter-clear" type="button" data-filter-clear="1">Clear</button>'
    );
  }

  function renderActiveFilters() {
    var html = activeFilterHtml();
    if (activeFilters) {
      activeFilters.hidden = !html;
      activeFilters.innerHTML = html;
    }
    if (activeFiltersPop)
      activeFiltersPop.innerHTML =
        html || '<span class="filter-empty">Smart inbox</span>';
    if (filterClearPop) filterClearPop.disabled = !html;
    var count = activeFilterCount();
    if (filterCount) {
      filterCount.hidden = !count;
      filterCount.textContent = String(count);
    }
  }

  function renderFilters() {
    renderSourceOptions();
    renderFacetChips();
    renderModeControl();
    renderActiveFilters();
  }

  function toggleTagFilter(tag) {
    var tags = filters.tags.slice();
    var idx = tags.indexOf(tag);
    if (idx === -1) tags.push(tag);
    else tags.splice(idx, 1);
    setFilters({ tags: tags });
  }

  function clearOneFilter(kind, value) {
    if (kind === "clear-source") setFilters({ source: "" });
    else if (kind === "clear-category") setFilters({ category: "" });
    else if (kind === "clear-mode") setFilters({ mode: "smart" });
    else if (kind === "clear-tag")
      setFilters({
        tags: filters.tags.filter(function (t) {
          return t !== value;
        }),
      });
  }

  function clearAllFilters() {
    setFilters(DEFAULT_FILTERS);
  }

  // ---- rendering / flow ----
  function updateProgress() {
    // Wins-forward, never a "N left" debt frame: finishable batch progress + today's clears.
    var total = reviewed + queue.length;
    var batch = total ? reviewed + " of " + total + " cleared" : "";
    progressEl.textContent =
      batch + (todayCleared ? " · " + todayCleared + " today" : "");
  }
  function showEmpty(show) {
    emptyEl.hidden = !show;
    actionsEl.hidden = show;
    if (skipRow) skipRow.hidden = show; // skipping makes no sense with an empty queue
    if (show) {
      if (!emptyStamped) {
        // fire the celebration once per emptying
        emptyStamped = true;
        if (window.chHaptic) window.chHaptic("milestone");
      }
      var sub = document.getElementById("triage-empty-sub");
      if (sub)
        sub.textContent = todayCleared
          ? todayCleared + " cleared today — nice work."
          : "Nothing waiting here. No rush.";
    } else {
      emptyStamped = false;
    }
  }
  function renderCurrent() {
    if (!queue.length) {
      stack.innerHTML = "";
      showEmpty(true);
      updateProgress();
      return;
    }
    showEmpty(false);
    stack.innerHTML = cardHtml(queue[0]);
    attachTriageSwipe(stack.querySelector(".tcard"));
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
        localStorage.setItem(
          SESSION_KEY,
          JSON.stringify({
            queue: queue,
            reviewed: reviewed,
            filters: filterFingerprint(),
            savedAt: Date.now(),
          }),
        );
      } else {
        localStorage.removeItem(SESSION_KEY); // finished the queue → nothing to resume
      }
    } catch (_e) {}
  }
  function loadSession() {
    try {
      var s = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
      if (!s || !Array.isArray(s.queue) || !s.queue.length) return null;
      if (Date.now() - (s.savedAt || 0) > SESSION_TTL_MS) {
        localStorage.removeItem(SESSION_KEY);
        return null;
      }
      if (s.filters !== filterFingerprint()) {
        localStorage.removeItem(SESSION_KEY);
        return null;
      }
      return s;
    } catch (_e) {
      return null;
    }
  }
  function loadBatch() {
    // mode=smart ranks by the learned likely-to-process score (Epic 10); it falls back to
    // random server-side when no scores exist yet, so it's always safe as the default.
    var params = new URLSearchParams();
    params.set("n", String(BATCH));
    params.set("unprocessed", "1");
    params.set("mode", filters.mode || "smart");
    if (filters.source) params.set("source", filters.source);
    if (filters.category) params.set("category", filters.category);
    filters.tags.forEach(function (t) {
      params.append("tag", t);
    });
    var url = "/random?" + params.toString();
    return fetchJSON(url).then(function (data) {
      queue = data.items || [];
      reviewed = 0;
      renderCurrent();
      saveSession();
    });
  }

  function commit(status) {
    if (!queue.length) return;
    if (window.chHaptic) window.chHaptic(status); // tactile confirm on the decision
    var item = queue[0];
    var dir = status === "archived" ? 1 : -1; // archive flings right, done/keep fling left
    animateOut(stack.querySelector(".tcard"), dir);
    fetchJSON("/items/" + encodeURIComponent(item.fullname) + "/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: status }),
    })
      .then(function () {
        lastAction = { fullname: item.fullname, status: status };
        updateUndoBtn();
        toast(status.charAt(0).toUpperCase() + status.slice(1), true);
      })
      .catch(function () {
        toast("Failed — check connection", false);
      });
    queue.shift();
    reviewed++;
    todayCleared++;
    saveSession(); // persist the remaining queue so reopening resumes mid-flow
    setTimeout(function () {
      if (!queue.length) loadBatch();
      else renderCurrent();
    }, 180);
  }

  function commitSnooze() {
    if (!queue.length) return;
    if (window.chHaptic) window.chHaptic("skip");
    var item = queue[0];
    animateSkipOut(stack.querySelector(".tcard"));
    postJSON("/items/" + encodeURIComponent(item.fullname) + "/snooze", {
      window_days: 7,
    })
      .then(function (res) {
        var escalated = !!(res && res.decayed_at);
        lastAction = {
          fullname: item.fullname,
          status: "snoozed",
          snooze: res,
          item: item,
          escalated: escalated,
        };
        if (escalated) {
          todayCleared++;
          updateProgress();
        }
        updateUndoBtn();
        toast(
          escalated ? "Archived after repeat snoozes" : "Snoozed for 7 days",
          true,
        );
      })
      .catch(function () {
        toast("Failed - check connection", false);
      });
    queue.shift();
    reviewed++;
    saveSession();
    setTimeout(function () {
      if (!queue.length) loadBatch();
      else renderCurrent();
    }, 180);
  }

  function openCurrentInReader() {
    if (!queue.length) return;
    saveSession();
    try {
      sessionStorage.setItem("ch_triage_reader_enter", queue[0].fullname);
    } catch (_e) {}
    location.assign(
      "/?open=" +
        encodeURIComponent(queue[0].fullname) +
        "&from=triage&enter=up",
    );
  }

  function undo() {
    if (!lastAction) return;
    if (window.chHaptic) window.chHaptic("undo");
    var action = lastAction;
    var fn = action.fullname;
    var p;
    if (action.status === "snoozed") {
      var r = action.snooze || {};
      var undoBody = r.snoozed_wave
        ? { snoozed_wave: r.snoozed_wave }
        : { decayed_at: r.decayed_at };
      p = postJSON("/snooze/undo", undoBody).then(function () {
        return action.item;
      });
    } else {
      p = fetchJSON("/items/" + encodeURIComponent(fn) + "/undo", {
        method: "POST",
      });
    }
    p.then(function (item) {
      queue.unshift(item);
      reviewed = Math.max(0, reviewed - 1);
      if (action.status !== "snoozed" || action.escalated)
        todayCleared = Math.max(0, todayCleared - 1);
      lastAction = null;
      updateUndoBtn();
      renderCurrent();
      saveSession();
    });
  }

  // Skip: pass on this card without deciding — move it to the back of the current batch
  // and show the next. No status change, no API call, and not counted as a clear (a skip
  // is a non-decision, never a "win"). It quietly resurfaces later in the session; for a
  // *timed* "decide later" see the Defer/Snooze backlog item (Epic 5).
  function skip() {
    if (queue.length < 2) {
      toast("Nothing else in this batch", false);
      return;
    }
    if (window.chHaptic) window.chHaptic("skip"); // faintest cue — registers input, no reward
    animateSkipOut(stack.querySelector(".tcard"));
    queue.push(queue.shift()); // current → back of the queue
    saveSession(); // persist the reordered queue for resume
    setTimeout(renderCurrent, 180);
  }

  // ---- swipe (pointer events) ----
  // Skip = a non-decision "pass": a gentle down-and-away, deliberately distinct from the
  // horizontal decision fling (animateOut) so it never reads as a commit.
  function animateSkipOut(card) {
    if (!card) return;
    card.style.transition = "transform .18s ease-out, opacity .18s ease-out";
    card.style.transform = "translateY(16%) scale(.96)";
    card.style.opacity = "0";
  }
  function animateOut(card, dir) {
    if (!card) return;
    card.style.transition = "transform .18s ease-out, opacity .18s ease-out";
    card.style.transform =
      "translateX(" + dir * 130 + "%) rotate(" + dir * 12 + "deg)";
    card.style.opacity = "0";
  }
  function attachTriageSwipe(card) {
    if (!card) return;
    attachSharedSwipe(card, {
      edge: EDGE_DEADZONE,
      commit: COMMIT_PX,
      commit2: LONG_LEFT_PX,
      haptics: false, // triage keeps tactile feedback at the action functions.
      onRight: function () {
        commit("archived");
      },
      onLeft: function () {
        commit("done");
      },
      onLeftLong: function () {
        commitSnooze();
      },
      onUp: function () {
        openCurrentInReader();
      },
      onDown: function () {
        skip();
      },
    });
  }

  // NSFW reveal + Ask AI + gallery lightbox
  stack.addEventListener("click", function (e) {
    // NSFW check must run before the gallery lightbox: the first tap on a blurred
    // gallery un-blurs it; only an already-revealed gallery opens the lightbox.
    var media = e.target.closest(".tcard-media.nsfw");
    if (media) {
      media.classList.remove("nsfw");
      return;
    }
    // Inline gallery image OR single image → open the lightbox. Looked up by the card's
    // fullname so we pass the FULL-res gallery urls + sized previews (not the card's
    // already-sized src), and resolve the single image via the shared imageUrl().
    var mediaTap = e.target.closest(".tcard-gallery-img, .tcard-img");
    if (mediaTap) {
      var mcard = mediaTap.closest(".tcard");
      var mit = mcard ? itemByFn(mcard.getAttribute("data-fullname")) : null;
      if (mit) {
        var mm = mit.metadata || {};
        if (Array.isArray(mm.gallery) && mm.gallery.length)
          openGallery(mm.gallery, mm.gallery_preview);
        else openImage(imageUrl(mit));
      }
      return;
    }
    // Reddit video poster → open the native <video> lightbox (HLS for v.redd.it).
    var vtap = e.target.closest(".tcard-video");
    if (vtap) {
      var vcard = vtap.closest(".tcard");
      var vit = vcard ? itemByFn(vcard.getAttribute("data-fullname")) : null;
      if (vit) {
        var vsrc = playableVideoSrc(vit);
        if (vsrc)
          openVideo(vsrc, (vit.metadata || {}).thumbnail || imageUrl(vit));
      }
      return;
    }
    var pv = e.target.closest(".rd-preview-lg");
    if (pv) {
      var holder = e.target.closest(".tcard-embed");
      var permalink = holder ? holder.getAttribute("data-permalink") : "";
      if (/^https?:\/\//i.test(permalink)) {
        /* Gallery embeds without captured images: show placeholder + link, NOT a reddit iframe
           (user preference 2026-06-22 — the iframe looked wrong embedded in the card). */
        if (holder && holder.hasAttribute("data-gallery-embed")) {
          holder.innerHTML =
            '<p class="media-fallback">Gallery images unavailable (not archived).</p>' +
            '<a class="media-fallback" href="' +
            esc(permalink) +
            '" target="_blank" rel="noopener">Open on Reddit ↗</a>';
        } else {
          holder.innerHTML =
            '<iframe class="reddit-embed-frame" src="' +
            esc(redditEmbedUrl(permalink)) +
            '" loading="lazy"></iframe>' +
            '<a class="media-fallback" href="' +
            esc(permalink) +
            '" target="_blank" rel="noopener">Open on Reddit ↗</a>';
        }
      }
      return;
    }
    var ab = e.target.closest("[data-recover-archive-today]");
    if (ab) {
      var acard = ab.closest(".tcard");
      var afn = acard ? acard.getAttribute("data-fullname") : "";
      if (!afn || !window.confirm(archiveTodayConfirmText)) return;
      ab.disabled = true;
      ab.textContent = "checking…";
      fetchJSON("/items/" + encodeURIComponent(afn) + "/recover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          metadata: false,
          archive_today: "apply",
          confirm_external_archive_today: true,
        }),
      })
        .then(function (d) {
          var media = d && d.archive_today;
          if (media && media.bytes_archived) {
            ab.textContent = "✓ media recovered";
            toast(
              "Recovered " +
                media.bytes_archived +
                " image" +
                (media.bytes_archived === 1 ? "" : "s"),
              false,
            );
            return fetchJSON("/items/" + encodeURIComponent(afn)).then(
              function (updated) {
                var item = itemByFn(afn);
                if (item && updated) Object.assign(item, updated);
                renderCurrent();
              },
            );
          }
          ab.disabled = false;
          ab.textContent =
            media && media.result === "miss"
              ? "no archive.today hit"
              : "try archive.today later";
          toast(
            media && media.result === "miss"
              ? "No archive.today snapshot found"
              : "Archive.today did not recover media",
            false,
          );
        })
        .catch(function () {
          ab.disabled = false;
          ab.textContent = "Recover deleted media via archive.today";
          toast("Archive.today recovery failed", false);
        });
      return;
    }
    var rb = e.target.closest("[data-recover]");
    if (rb) {
      var rcard = rb.closest(".tcard");
      var rfn = rcard ? rcard.getAttribute("data-fullname") : "";
      if (!rfn) return;
      rb.disabled = true;
      rb.textContent = "…";
      fetchJSON("/items/" + encodeURIComponent(rfn) + "/recover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ metadata: true, archive_today: "off" }),
      })
        .then(function (d) {
          if (d && d.recovered) {
            var ttl = rcard.querySelector(".tcard-title");
            if (ttl && d.title) ttl.textContent = d.title;
            if (d.body) {
              var meta = rcard.querySelector(".tcard-meta");
              var snip = rcard.querySelector(".tcard-snippet");
              if (!snip && meta) {
                snip = document.createElement("p");
                snip.className = "tcard-snippet";
                meta.parentNode.insertBefore(snip, meta.nextSibling);
              }
              if (snip) snip.textContent = d.body.slice(0, 400);
            }
            rb.textContent = "✓ text recovered";
            toast("Text recovered from archives", false);
          } else {
            rb.disabled = false;
            rb.textContent = "not archived";
          }
        })
        .catch(function () {
          rb.disabled = false;
          rb.textContent = "↻ Recover text from archives";
        });
      return;
    }
    // ---- manual tag editor (mirrors the cat-chip network pattern, POSTs to /tags) ----
    // Expand/collapse overflowed tags in-place so high-tag items don't make the
    // triage card too tall by default.
    var tagMore = e.target.closest("[data-tagmore]");
    if (tagMore) {
      var tagsBox = tagMore.closest(".tcard-tags");
      if (tagsBox) {
        var expanded = !tagsBox.classList.contains("tags-expanded");
        tagsBox.classList.toggle("tags-expanded", expanded);
        tagMore.setAttribute("aria-expanded", expanded ? "true" : "false");
        tagMore.textContent = expanded
          ? "show fewer"
          : tagMore.getAttribute("data-label");
      }
      return;
    }
    // Remove an existing tag chip. The ✕ and the chip itself both carry the removal
    // (closest() walks up from either), so the whole pill is a tap target.
    var tagRm = e.target.closest("[data-rmtag]");
    if (tagRm) {
      var cardEl = tagRm.closest(".tcard");
      var tagFn = cardEl ? cardEl.getAttribute("data-fullname") : "";
      if (tagFn) removeTag(tagFn, tagRm.getAttribute("data-rmtag"));
      return;
    }
    // A suggestion chip in the open add-UI → add that tag and close the UI.
    var sugg = e.target.closest("[data-addtag]");
    if (sugg) {
      e.preventDefault();
      var sCard = sugg.closest(".tcard");
      var sFn = sCard ? sCard.getAttribute("data-fullname") : "";
      if (sFn) {
        addTag(sFn, sugg.getAttribute("data-addtag"));
        collapseTagAdd(sCard.querySelector(".tag-add-input"));
      }
      return;
    }
    // "＋ tag" button → toggle the inline add UI (known-tag suggestions + a free input).
    var addBtn = e.target.closest("[data-tagadd]");
    if (addBtn) {
      var addCard = addBtn.closest(".tcard");
      var addFn = addCard ? addCard.getAttribute("data-fullname") : "";
      if (addFn) openTagAdd(addFn);
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
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category: cat }),
      })
        .then(function () {
          if (queue[0] && queue[0].fullname === fn) {
            queue[0].metadata = queue[0].metadata || {};
            queue[0].metadata.category = cat;
          }
          var rowEl = chip.closest(".chip-row");
          if (rowEl)
            Array.prototype.forEach.call(
              rowEl.querySelectorAll(".cat-chip"),
              function (c) {
                c.classList.toggle("active", c === chip);
              },
            );
          toast("Category: " + cat, false);
        })
        .catch(function () {
          toast("Failed — check connection", false);
        });
      return;
    }
    var aiBtn = e.target.closest(".ai-btn");
    if (aiBtn && queue.length) {
      aiBtn.textContent = "…thinking";
      var fn = queue[0].fullname;
      fetchJSON("/items/" + encodeURIComponent(fn) + "/suggest", {
        method: "POST",
      })
        .then(function (s) {
          if (queue[0]) {
            queue[0].metadata = queue[0].metadata || {};
            queue[0].metadata.llm = s;
          }
          var holder = aiBtn.parentNode;
          if (holder) holder.innerHTML = aiHtml(s);
        })
        .catch(function () {
          aiBtn.textContent = "AI unavailable";
        });
    }
  });

  // ---- manual tag editor: keyboard + live suggestions ----
  stack.addEventListener("input", function (e) {
    var inp = e.target.closest(".tag-add-input");
    if (inp) refreshSuggestions(inp);
  });
  stack.addEventListener("keydown", function (e) {
    var inp = e.target.closest(".tag-add-input");
    if (!inp) return;
    var card = inp.closest(".tcard");
    var fn = card ? card.getAttribute("data-fullname") : "";
    if (e.key === "Enter") {
      e.preventDefault();
      var v = inp.value;
      if (fn && normTag(v)) {
        addTag(fn, v);
        collapseTagAdd(inp);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      collapseTagAdd(inp);
    }
  });

  // ---- toast ----
  function toast(msg, withUndo) {
    clearTimeout(toastTimer);
    toastEl.innerHTML =
      esc(msg) + (withUndo ? ' <button class="toast-undo">Undo</button>' : "");
    toastEl.hidden = false;
    if (withUndo)
      toastEl.querySelector(".toast-undo").addEventListener("click", undo);
    toastTimer = setTimeout(function () {
      toastEl.hidden = true;
    }, 5000);
  }

  // ---- input wiring ----
  actionsEl.addEventListener("click", function (e) {
    var b = e.target.closest("[data-action]");
    if (b) commit(b.getAttribute("data-action"));
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && filterPop && !filterPop.hidden) {
      filterPop.hidden = true;
      if (filterBtn) filterBtn.setAttribute("aria-expanded", "false");
      return;
    }
    if (e.key === "Escape" && menuPop && !menuPop.hidden) {
      menuPop.hidden = true;
      if (menuBtn) menuBtn.setAttribute("aria-expanded", "false");
      return;
    }
    if (e.key === "Escape" && shortcutModal && !shortcutModal.hidden) {
      closeShortcuts();
      return;
    }
    if (isTypingTarget(e.target)) return;
    var k = e.key.toLowerCase();
    if (k === "?") {
      e.preventDefault();
      toggleShortcuts();
    } else if (shortcutModal && !shortcutModal.hidden) return;
    else if (k === "e" || k === "arrowright") commit("archived");
    else if (k === "y" || k === "arrowleft") commit("done");
    else if (k === "s") commit("keep");
    else if (k === " ") {
      e.preventDefault();
      skip();
    } // Space = pass / show next (stops scroll + button activation)
    else if (k === "z" || k === "u") undo();
  });
  var nb = document.getElementById("next-batch");
  if (nb) nb.addEventListener("click", loadBatch);
  if (srcFilter)
    srcFilter.addEventListener("change", function () {
      setFilters({ source: srcFilter.value || "" });
    });
  if (filterBtn && filterPop)
    filterBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      var willOpen = filterPop.hidden;
      filterPop.hidden = !willOpen;
      filterBtn.setAttribute("aria-expanded", String(willOpen));
    });
  if (filterPop)
    filterPop.addEventListener("click", function (e) {
      e.stopPropagation();
      var chip = e.target.closest("[data-filter-kind]");
      if (chip) {
        var kind = chip.getAttribute("data-filter-kind");
        var value = chip.getAttribute("data-filter-value") || "";
        if (kind === "category")
          setFilters({ category: filters.category === value ? "" : value });
        else if (kind === "tag") toggleTagFilter(value);
        else clearOneFilter(kind, value);
        return;
      }
      if (e.target.closest("[data-filter-clear]")) clearAllFilters();
    });
  if (activeFilters)
    activeFilters.addEventListener("click", function (e) {
      var chip = e.target.closest("[data-filter-kind]");
      if (chip)
        clearOneFilter(
          chip.getAttribute("data-filter-kind"),
          chip.getAttribute("data-filter-value") || "",
        );
      else if (e.target.closest("[data-filter-clear]")) clearAllFilters();
    });
  if (filterClearPop) filterClearPop.addEventListener("click", clearAllFilters);
  if (modeFilter)
    modeFilter.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-mode]");
      if (btn) setFilters({ mode: btn.getAttribute("data-mode") || "smart" });
    });

  function updateUndoBtn() {
    if (undoBtn) undoBtn.disabled = !lastAction;
  }
  if (undoBtn) undoBtn.addEventListener("click", undo);
  if (skipBtn) skipBtn.addEventListener("click", skip);

  function setActiveChip() {
    if (!batchChips) return;
    Array.prototype.forEach.call(batchChips.children, function (c) {
      c.classList.toggle(
        "active",
        parseInt(c.getAttribute("data-batch"), 10) === BATCH,
      );
    });
  }
  if (menuBtn)
    menuBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      var willOpen = menuPop.hidden;
      menuPop.hidden = !willOpen;
      menuBtn.setAttribute("aria-expanded", String(willOpen));
      if (willOpen) {
        setActiveChip();
        ruRefreshPop();
      }
    });
  // Reddit unsave: the button first previews the queued drain scope, then requires an
  // explicit second confirmation before contacting Reddit. Queueing is local/reversible;
  // this live drain is the external mutation.
  function ruRefreshPop() {
    if (!ruPop) return;
    fetchJSON("/reddit/unsave/status")
      .then(function (s) {
        if (!s.configured) {
          ruPop.hidden = true;
          return;
        }
        ruPop.hidden = false;
        ruPopStatus.textContent = s.pending
          ? s.pending + " queued to unsave"
          : "nothing queued";
        ruSyncBtn.textContent = s.pending
          ? "Unsave queued (" + s.pending + ")"
          : "Unsave queued";
        ruSyncBtn.disabled = !s.pending;
      })
      .catch(function () {});
  }
  if (ruSyncBtn)
    ruSyncBtn.addEventListener("click", function () {
      var maxDrain = 50;
      ruSyncBtn.disabled = true;
      ruPopStatus.textContent = "Reviewing queued unsaves…";
      fetchJSON("/reddit/unsave/drain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dry_run: true, max: maxDrain }),
      })
        .then(function (plan) {
          if (!plan.selected) {
            toast("Nothing queued to unsave", false);
            ruRefreshPop();
            return;
          }
          var sample = (plan.sample || [])
            .slice(0, 3)
            .map(function (it) {
              return (
                "• " +
                (it.subreddit ? "r/" + it.subreddit + " · " : "") +
                (it.title || it.fullname || "queued item")
              );
            })
            .join("\n");
          var more = plan.remaining
            ? "\n\n" +
              plan.remaining +
              " more will remain queued after this batch."
            : "";
          var msg =
            "Unsave " +
            plan.selected +
            " queued Reddit item" +
            (plan.selected === 1 ? "" : "s") +
            " from your REAL Reddit Saved list?\n\n" +
            (sample || "No sample available.") +
            more +
            "\n\nThis is a live Reddit write. Cancel leaves the local queue unchanged.";
          if (!window.confirm(msg)) {
            toast("Unsave cancelled — queue unchanged", false);
            ruRefreshPop();
            return;
          }
          ruPopStatus.textContent = "Unsaving confirmed batch…";
          return fetchJSON("/reddit/unsave/drain", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ live: true, confirm: true, max: maxDrain }),
          }).then(function (res) {
            if (res.auth_error)
              toast(
                "Reddit session expired — re-paste your cookie on Browse",
                false,
              );
            else
              toast(
                "Unsaved " +
                  res.unsaved +
                  (res.failed ? " · " + res.failed + " failed" : ""),
                false,
              );
            ruRefreshPop();
          });
        })
        .catch(function () {
          toast("Sync failed", false);
          ruRefreshPop();
        });
    });
  if (batchChips)
    batchChips.addEventListener("click", function (e) {
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
    if (filterPop && !filterPop.hidden && !e.target.closest(".filter-menu")) {
      filterPop.hidden = true;
      if (filterBtn) filterBtn.setAttribute("aria-expanded", "false");
    }
    if (menuPop && !menuPop.hidden && !e.target.closest(".menu")) {
      menuPop.hidden = true;
      menuBtn.setAttribute("aria-expanded", "false");
    }
  });
  if (shortcutClose) shortcutClose.addEventListener("click", closeShortcuts);
  if (shortcutModal)
    shortcutModal.addEventListener("click", function (e) {
      if (e.target === shortcutModal) closeShortcuts();
    });
  // Media modal close wiring (gallery lightbox)
  var mediaCloseBtn = document.getElementById("media-close");
  if (mediaCloseBtn) mediaCloseBtn.addEventListener("click", closeMedia);
  var mediaModal = document.getElementById("media-modal");
  if (mediaModal)
    mediaModal.addEventListener("click", function (e) {
      if (e.target === mediaModal) closeMedia();
    });
  // In the gallery lightbox, tap a sized preview to swap up to its full-res original.
  var mediaBodyEl = document.getElementById("media-body");
  if (mediaBodyEl)
    mediaBodyEl.addEventListener("click", function (e) {
      var gi = e.target.closest(".gallery-img");
      if (gi && gi.dataset.full && gi.src !== gi.dataset.full)
        gi.src = gi.dataset.full;
    });
  updateUndoBtn();
  fillIcons(document); // hydrate the static [data-ico] action-button glyphs (icons.js auto-fill retired)

  // ---- boot ----
  if ("serviceWorker" in navigator)
    navigator.serviceWorker.register("/static/sw.js").catch(function (err) {
      // Service workers (and therefore PWA install) only work in a secure context:
      // HTTPS, or localhost/127.0.0.1. Plain HTTP over a LAN or Tailscale IP fails
      // here silently — surface it so the cause is visible. See docs/MOBILE_TAILSCALE.md.
      console.warn(
        "Service worker registration failed (needs HTTPS or localhost):",
        err,
      );
    });
  // Today's clears (shared with browse) so the header shows accumulating wins across batches.
  fetchJSON("/pulse")
    .then(function (p) {
      todayCleared = (p && p.cleared_today) || 0;
      updateProgress();
    })
    .catch(function () {});
  // Cache the user's tag vocabulary once so the "＋ tag" add-UI can suggest known tags
  // (and the user can still type a brand-new one). /tags is cross-filtered by the
  // active source/status on browse, but we want the FULL vocabulary here (triage is
  // unfiltered), so call it with no source/status.
  fetchJSON("/tags")
    .then(function (d) {
      if (d && d.tags && typeof d.tags === "object")
        knownTags = Object.keys(d.tags).sort();
    })
    .catch(function () {});
  Promise.all([
    fetchJSON("/sources?status=inbox"),
    fetchJSON("/categories?status=inbox"),
    fetchJSON("/tags?status=inbox"),
  ])
    .then(function (parts) {
      var sourceData = parts[0] || {};
      var categoryData = parts[1] || {};
      var tagData = parts[2] || {};
      (sourceData.sources || []).forEach(function (s) {
        sources[s.id] = s;
      });
      categoryFacets = (categoryData.categories || []).map(function (c) {
        return { id: c.id, label: c.label || c.id, count: c.count || 0 };
      });
      var tagCounts = tagData.tags || {};
      tagFacets = Object.keys(tagCounts)
        .map(function (id) {
          return { id: id, count: tagCounts[id] || 0 };
        })
        .sort(function (a, b) {
          return b.count - a.count || a.id.localeCompare(b.id);
        });
      var qsSource = new URLSearchParams(location.search).get("source");
      if (qsSource) setFilters({ source: qsSource }, { deferLoad: true });
      else renderFilters();
    })
    .then(function () {
      // Resume where you left off — unless an explicit ?source means "deal a fresh filtered batch".
      var explicit = new URLSearchParams(location.search).get("source");
      var s = explicit ? null : loadSession();
      if (s) {
        queue = s.queue;
        reviewed = s.reviewed || 0;
        renderCurrent();
        toast("Picked up where you left off", false);
      } else {
        loadBatch();
      }
    })
    .catch(loadBatch);
})();
