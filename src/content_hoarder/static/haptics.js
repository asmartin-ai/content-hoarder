/* haptics.js — window.chHaptic(kind): subtle Web-Vibration feedback for triage/browse commits. No-op where unsupported. */
(function () {
  // Keyed on the real status enum (models.VALID_STATUSES) so call sites pass `status` directly.
  var patterns = {
    archived: 18,                      // backlog-reducing — a crisp, satisfying confirm
    done: 10,                          // backlog-reducing — lighter confirm (user feedback 2026-06-20)
    keep: [10, 30, 10],                // the preserve action — a gentler, deliberately less-rewarding cue
    inbox: 8,                          // un-process (back to inbox) — light, undo-like
    skip: 6,                           // a non-decision "pass" — the faintest cue, never a reward
    milestone: [12, 40, 12, 40, 20],   // batch cleared / goal reached — the one richer celebration
    undo: 8,                           // very light
  };
  window.chHaptic = function (kind) {
    if (typeof navigator !== "object" || typeof navigator.vibrate !== "function") return;
    try {
      navigator.vibrate(patterns[kind] || 12);
    } catch (_e) {}
  };
})();
