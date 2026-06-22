/* haptics.js — window.chHaptic(kind): subtle Web-Vibration feedback for triage/browse commits. No-op where unsupported. */
(function () {
  // Keyed on the real status enum (models.VALID_STATUSES) so call sites pass `status` directly.
  // navigator.vibrate is DURATION-ONLY (no amplitude knob), and a Pixel-class LRA needs ~12-15ms to
  // spin up to full force — so sub-10ms pulses feel "soft." Tuned 2026-06-22 for a FIRM-but-crisp tap:
  // durations land in the firm zone (felt, not a long buzz). History: ~18ms = "too strong", 8ms = "too
  // soft"; these sit in the middle. Relative hierarchy kept (backlog-reducers stronger than preserve/skip).
  var patterns = {
    archived: 15,                      // backlog-reducing — the firmest confirm (strongest cue)
    done: 12,                          // backlog-reducing — firm confirm
    keep: 10,                          // the preserve action — present but deliberately less-rewarding
    inbox: 8,                          // un-process (back to inbox) — lighter, undo-like
    skip: 6,                           // a non-decision "pass" — the faintest, never a reward
    milestone: [12, 26, 12],           // batch cleared / goal reached — a firm double-tap celebration
    undo: 8,                           // light
  };
  window.chHaptic = function (kind) {
    if (typeof navigator !== "object" || typeof navigator.vibrate !== "function") return;
    try {
      navigator.vibrate(patterns[kind] || 6);
    } catch (_e) {}
  };
})();
