import { existsSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";

const STATIC_DIR = join(import.meta.dir, "..", "static");

const TEMPLATE_PATH = join(import.meta.dir, "..", "templates", "index.html");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
} satisfies Record<string, string>;

export function staticResponse(path: string): Response {
  const rel =
    path === "/manifest.webmanifest" ? "manifest.webmanifest" : path.slice("/static/".length);

  const target = resolve(STATIC_DIR, normalize(rel));

  if (!target.startsWith(`${STATIC_DIR}/`) || !existsSync(target))
    return new Response("not found", { status: 404 });

  const contentType =
    Object.entries(MIME).find(([extension]) => extension === extname(target).toLowerCase())?.[1] ??
    "application/octet-stream";

  return new Response(Bun.file(target), {
    headers: { "Content-Type": contentType },
  });
}

export function serviceWorkerResponse(): Response {
  return new Response(Bun.file(join(STATIC_DIR, "sw.js")), {
    headers: { "Content-Type": "text/javascript", "Service-Worker-Allowed": "/" },
  });
}

export function templateResponse(): Response {
  return new Response(Bun.file(TEMPLATE_PATH), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // The local triage app must never sit inside another site's iframe:
      // a framed deck click is a same-origin POST the Host/Origin guard
      // cannot distinguish from a real one (clickjacking).
      "Content-Security-Policy": "frame-ancestors 'none'",
      "X-Frame-Options": "DENY",
    },
  });
}
