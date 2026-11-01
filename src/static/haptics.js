(function () {
  var patterns = {
    archived: 15,
    done: 12,
    keep: 10,
    inbox: 8,
    skip: 6,
    milestone: [12, 26, 12],
    undo: 8,
  };

  window.chHaptic = function (kind) {
    if (!window.navigator?.vibrate) return;

    try {
      window.navigator.vibrate(patterns[kind] || 6);
    } catch {}
  };
})();
