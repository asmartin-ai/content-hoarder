/* haptics.js — window.chHaptic(kind): subtle Web-Vibration feedback for triage/browse commits. No-op where unsupported. */
(function () {
  // Keyed on the real status enum (models.VALID_STATUSES) so call sites pass `status` directly.
  // Durations softened ~45% (user feedback 2026-06-22: swipe haptics too strong) — the relative
  // hierarchy is kept (backlog-reducers crisper than preserve/non-decisions), just lighter overall.
  var patterns = {
    archived: 10,                      // backlog-reducing — the crispest confirm (still the strongest cue)
    done: 6,                           // backlog-reducing — lighter confirm
    keep: 5,                           // the preserve action — a single faint, deliberately less-rewarding cue
    inbox: 4,                          // un-process (back to inbox) — light, undo-like
    skip: 3,                           // a non-decision "pass" — the faintest cue, never a reward
    milestone: [8, 30, 8],             // batch cleared / goal reached — a softened, still-richer celebration
    undo: 4,                           // very light
  };
  window.chHaptic = function (kind) {
    if (typeof navigator !== "object" || typeof navigator.vibrate !== "function") return;
    try {
      navigator.vibrate(patterns[kind] || 6);
    } catch (_e) {}
  };
})();
