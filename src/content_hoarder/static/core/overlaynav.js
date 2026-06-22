/* core/overlaynav.js — one back-button coordinator for stacked overlays (reader, lightbox, sheets).
 *
 * The problem each overlay used to solve alone: on mobile the OS back button / back-gesture should
 * DISMISS the open overlay, not navigate the page away (which, when the overlay is the first thing
 * you opened, exits the whole PWA). Each overlay doing its own history.pushState + popstate listener
 * breaks down the moment overlays NEST (a lightbox opened over the reader): a single back fires every
 * listener, so both close at once and the history stack desyncs (2 entries pushed, 1 popped).
 *
 * This module owns ONE popstate listener over a STACK of close-callbacks. Opening an overlay pushes
 * one history entry + its closer; an OS-back pops and runs only the TOP closer (lightbox first, reader
 * still open); a manual close (button/Esc/backdrop/swipe) unwinds its own entry. Overlays never exit
 * the app while anything is open, and the stack stays in sync.
 *
 * Usage:
 *   import { pushOverlay, settleTop } from "../core/overlaynav.js";
 *   open():  pushOverlay(closeVisual)      // closeVisual = tear down the UI, touch NO history
 *   manual close():  closeVisual(); settleTop()   // unwind the history entry we pushed
 *   (OS back is handled here automatically — it calls the top closer for you)
 */

const stack = [];        // close-callbacks, innermost overlay last
let unwinding = false;   // true while WE called history.back() for a manual close (skip that popstate)

/* Register an opening overlay: remember how to close it + push a history entry to "catch" one back. */
export function pushOverlay(onClose) {
  stack.push(onClose);
  try { history.pushState({ chOverlay: stack.length }, ""); } catch (e) { /* no-op */ }
}

/* A manual close already tore the overlay down — drop the TOP entry and unwind its history slot so
 * the back stack matches what's on screen. (Overlays close LIFO, so the top is the right one.) */
export function settleTop() {
  if (!stack.length) return;
  stack.pop();
  unwinding = true;
  try { history.back(); } catch (e) { unwinding = false; }
}

window.addEventListener("popstate", () => {
  if (unwinding) { unwinding = false; return; }   // our own settleTop() back() — already torn down
  const onClose = stack.pop();
  if (onClose) { try { onClose(); } catch (e) { /* a closer that throws must not wedge the stack */ } }
});
