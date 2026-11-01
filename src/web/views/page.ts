import { html, raw, type SafeHtml } from "./html.ts";

export type Tab = "today" | "clear";

const SPLASHES: Array<[string, string]> = [
  [
    "1290x2796",
    "(device-width: 430px) and (device-height: 932px) and (-webkit-device-pixel-ratio: 3)",
  ],
  [
    "1179x2556",
    "(device-width: 393px) and (device-height: 852px) and (-webkit-device-pixel-ratio: 3)",
  ],
  [
    "1170x2532",
    "(device-width: 390px) and (device-height: 844px) and (-webkit-device-pixel-ratio: 3)",
  ],
  [
    "1080x2340",
    "(device-width: 375px) and (device-height: 812px) and (-webkit-device-pixel-ratio: 3)",
  ],
  [
    "750x1334",
    "(device-width: 375px) and (device-height: 667px) and (-webkit-device-pixel-ratio: 2)",
  ],
  [
    "640x1136",
    "(device-width: 320px) and (device-height: 568px) and (-webkit-device-pixel-ratio: 2)",
  ],
  [
    "2048x2732",
    "(device-width: 1024px) and (device-height: 1366px) and (-webkit-device-pixel-ratio: 2)",
  ],
  [
    "1668x2388",
    "(device-width: 834px) and (device-height: 1194px) and (-webkit-device-pixel-ratio: 2)",
  ],
  [
    "1668x2224",
    "(device-width: 834px) and (device-height: 1112px) and (-webkit-device-pixel-ratio: 2)",
  ],
  [
    "1536x2048",
    "(device-width: 768px) and (device-height: 1024px) and (-webkit-device-pixel-ratio: 2)",
  ],
  [
    "1488x2266",
    "(device-width: 744px) and (device-height: 1133px) and (-webkit-device-pixel-ratio: 2)",
  ],
];

const SVG_OPEN =
  '<svg class="ch-ico" xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" ' +
  'fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" ' +
  'stroke-linejoin="round" aria-hidden="true">';

const NAV_ICONS = {
  today: raw(
    `${SVG_OPEN}<path d="M12 12m-4 0a4 4 0 1 0 8 0a4 4 0 1 0 -8 0" />` +
      '<path d="M3 12h1m8 -9v1m8 8h1m-9 8v1m-6.4 -15.4l.7 .7m12.1 -.7l-.7 .7m0 11.4l.7 .7m-12.1 -.7l-.7 .7" /></svg>',
  ),
  clear: raw(
    `${SVG_OPEN}<path d="M12 4l-8 4l8 4l8 -4l-8 -4" /><path d="M4 12l8 4l8 -4" />` +
      '<path d="M4 16l8 4l8 -4" /></svg>',
  ),
  library: raw(
    `${SVG_OPEN}<path d="M5 5a1 1 0 0 1 1 -1h2a1 1 0 0 1 1 1v14a1 1 0 0 1 -1 1h-2a1 1 0 0 1 -1 -1z" />` +
      '<path d="M9 5a1 1 0 0 1 1 -1h2a1 1 0 0 1 1 1v14a1 1 0 0 1 -1 1h-2a1 1 0 0 1 -1 -1z" />' +
      '<path d="M5 8h4" /><path d="M9 16h4" />' +
      '<path d="M13.803 4.56l2.184 -.53c.562 -.135 1.133 .19 1.282 .732l3.695 13.418a1.02 1.02 0 0 1 -.634 1.219l-.133 .041l-2.184 .53c-.562 .135 -1.133 -.19 -1.282 -.732l-3.695 -13.418a1.02 1.02 0 0 1 .634 -1.219l.133 -.041z" />' +
      '<path d="M14 9l4 -1" /><path d="M16 16l3.923 -.98" /></svg>',
  ),
};

const MOON = raw(
  `${SVG_OPEN}<path d="M12 3c.132 0 .263 0 .393 0a7.5 7.5 0 0 0 7.92 12.446a9 9 0 1 1 -8.313 -12.454z" /></svg>`,
);

export function moonIcon(): SafeHtml {
  return MOON;
}

const TABS: Array<{ id: Tab | "library"; href: string; label: string }> = [
  { id: "today", href: "/", label: "Today" },
  { id: "clear", href: "/clear", label: "Clear" },
  { id: "library", href: "/library", label: "Library" },
];

export function navHtml(tab: Tab | "library"): SafeHtml {
  const tabs = TABS.map(
    (entry) =>
      html`<a
        class="ch-tab"
        data-tab="${entry.id}"
        href="${entry.href}"
        ${entry.id === tab ? raw(' aria-current="page"') : ""}
        >${NAV_ICONS[entry.id]}<span>${entry.label}</span></a
      >`,
  );

  return html`<nav class="ch-nav" aria-label="Main">
    <a class="ch-brand" href="/"><span class="ch-led"></span><span>content-hoarder</span></a>
    <div class="ch-tabs">${tabs}</div>
    <button class="ch-iconbtn" id="theme-toggle" type="button" aria-label="Switch light/dark">
      ${MOON}
    </button>
  </nav>`;
}

const HEAD_META = raw(
  [
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />',
    '<meta name="theme-color" content="#0f1115" />',
    '<meta name="apple-mobile-web-app-capable" content="yes" />',
    '<meta name="mobile-web-app-capable" content="yes" />',
    '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />',
    '<meta name="apple-mobile-web-app-title" content="Hoarder" />',
    '<link rel="apple-touch-icon" href="/static/apple-touch-icon.png" />',
    ...SPLASHES.map(
      ([size, media]) =>
        `<link rel="apple-touch-startup-image" href="/static/apple-touch-startup-image-${size}.png" media="${media}" />`,
    ),
  ].join("\n    "),
);

const HEAD_ASSETS = raw(
  [
    '<link rel="manifest" href="/manifest.webmanifest" />',
    '<link rel="icon" href="/static/icon.svg" type="image/svg+xml" />',
    '<link rel="stylesheet" href="/static/core/tokens.css" />',
    '<link rel="stylesheet" href="/static/core/nav.css" />',
    '<script src="/static/theme.js"></script>',
    '<script src="/static/haptics.js"></script>',
    '<script src="/static/vendor/htmx.min.js" defer></script>',
    '<script type="module" src="/static/home/main.js"></script>',
  ].join("\n    "),
);

const ROOM_CSS: Record<Tab, string> = {
  today: "/static/home/today.css",
  clear: "/static/home/clear.css",
};

export function renderPage(opts: {
  title: string;
  tab: Tab;
  body: SafeHtml;
  round?: boolean;
}): string {
  const bodyClass = opts.round ? "has-tabbar is-round" : "has-tabbar";

  return `<!doctype html>\n${html`<html lang="en">
    <head>
      ${HEAD_META}
      <title>${opts.title} · content-hoarder</title>
      ${HEAD_ASSETS}
      <link rel="stylesheet" href="/static/home/home.css" />
      <link rel="stylesheet" href="${ROOM_CSS[opts.tab]}" />
    </head>
    <body class="${bodyClass}" data-page="${opts.tab}">
      ${navHtml(opts.tab)}
      <main id="view" class="view">${opts.body}</main>
      <div id="toast" hidden aria-live="polite"></div>
    </body>
  </html> `}`;
}
