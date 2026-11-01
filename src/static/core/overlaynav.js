const stack = [];

let unwinding = false;

export function pushOverlay(onClose) {
  stack.push(onClose);

  try {
    history.pushState({ chOverlay: stack.length }, "");
  } catch {}
}

export function settleTop() {
  if (!stack.length) return;
  stack.pop();
  unwinding = true;

  try {
    history.back();
  } catch {
    unwinding = false;
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("popstate", () => {
    if (unwinding) {
      unwinding = false;

      return;
    }

    const onClose = stack.pop();

    if (onClose) {
      try {
        onClose();
      } catch {}
    }
  });
}
