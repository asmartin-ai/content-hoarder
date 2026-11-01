const R = 44;

const GAP_DEG = 17;

const point = (deg) => {
  const rad = ((deg - 90) * Math.PI) / 180;

  return (50 + R * Math.cos(rad)).toFixed(2) + " " + (50 + R * Math.sin(rad)).toFixed(2);
};

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
