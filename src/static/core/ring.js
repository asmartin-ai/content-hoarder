/* core/ring.js — WinPebbles drawn as a ring: one arc per pebble of the daily goal, lit in win
   green as the day's clears land (Apple's rings, minus the debt — it resets, never nags).
   Shared by the server (web/views/today.ts) and the round island (home/round.js); the output is
   numbers-only SVG, safe to inline. */

const R = 44;

const GAP_DEG = 17; // wide enough that the round caps never touch: separate pebbles

const point = (deg) => {
  const rad = ((deg - 90) * Math.PI) / 180;

  return (50 + R * Math.cos(rad)).toFixed(2) + " " + (50 + R * Math.sin(rad)).toFixed(2);
};

/** `<svg class="ring">` with `goal` arcs, the first `n` lit; "" when there is no goal. */
export function ringSvg(n, goal) {
  if (!(goal > 0)) return "";
  const seg = 360 / goal;
  const gap = goal > 1 ? GAP_DEG : 0;
  let arcs = "";

  for (let i = 0; i < goal; i++) {
    const a0 = i * seg + gap / 2;
    const a1 = goal > 1 ? (i + 1) * seg - gap / 2 : 359.99;
    const large = a1 - a0 > 180 ? 1 : 0;

    arcs +=
      '<path class="' +
      (i < n ? "arc on" : "arc") +
      '" style="--i:' +
      i +
      '" d="M ' +
      point(a0) +
      " A " +
      R +
      " " +
      R +
      " 0 " +
      large +
      " 1 " +
      point(a1) +
      '" />';
  }

  return (
    '<svg class="ring' +
    (n >= goal ? " is-met" : "") +
    '" viewBox="0 0 100 100" aria-hidden="true">' +
    arcs +
    "</svg>"
  );
}
