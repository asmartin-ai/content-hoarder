/* Theme: light/dark via data-theme on <html>, persisted in localStorage.
   The first block runs before <body> paints to avoid a flash of the wrong theme,
   so this file must be a plain (non-deferred) <script> in <head>. */
(function () {
  "use strict";

  // Apply the saved theme as early as possible (before first paint).
  try {
    var saved = localStorage.getItem("ch-theme");
    if (saved === "light" || saved === "dark") {
      document.documentElement.setAttribute("data-theme", saved);
    }
  } catch (e) {}

  function current() {
    return document.documentElement.getAttribute("data-theme") || "dark";
  }
  function metaColor(theme) {
    // Read the live --bg token so the browser chrome tracks whichever tokens file
    // the page loaded (legacy tokens.css or v3 core/tokens.css). data-theme must be
    // set before reading; apply() does that. Fallbacks match the legacy palette.
    var bg = "";
    try { bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim(); } catch (e) {}
    return bg || (theme === "light" ? "#f5f6f8" : "#0f1115");
  }

  function syncButtons(theme) {
    var light = theme === "light";
    document.querySelectorAll("[data-theme-toggle]").forEach(function (btn) {
      var label = light ? "Switch to dark theme" : "Switch to light theme";
      btn.setAttribute("aria-pressed", String(light));
      btn.setAttribute("aria-label", label);
      btn.title = label;
      // Unicode glyphs (text style via VS-15) to match the monoline icon language.
      btn.textContent = light ? "☀︎" : "☾︎"; // ☀ when light, ☾ when dark
    });
  }

  function apply(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    var m = document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute("content", metaColor(theme));
    try { localStorage.setItem("ch-theme", theme); } catch (e) {}
    syncButtons(theme);
  }

  window.toggleTheme = function () {
    apply(current() === "light" ? "dark" : "light");
  };

  document.addEventListener("DOMContentLoaded", function () {
    var m = document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute("content", metaColor(current()));
    document.querySelectorAll("[data-theme-toggle]").forEach(function (btn) {
      btn.addEventListener("click", window.toggleTheme);
    });
    syncButtons(current());
  });
})();
