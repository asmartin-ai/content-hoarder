import { existsSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";

const STATIC_DIR = join(import.meta.dir, "..", "static");

const LIBRARY_TEMPLATE = join(import.meta.dir, "..", "templates", "index.html");

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
    headers: { "Content-Type": contentType, "Cache-Control": "no-cache" },
  });
}

export function serviceWorkerResponse(): Response {
  return new Response(Bun.file(join(STATIC_DIR, "sw.js")), {
    headers: {
      "Content-Type": "text/javascript",
      "Service-Worker-Allowed": "/",
      "Cache-Control": "no-cache",
    },
  });
}

export function htmlResponse(
  body: string | Blob,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  const headers = new Headers(init.headers);

  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Content-Security-Policy", "frame-ancestors 'none'");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Cache-Control", "private, no-cache");

  return new Response(body, { ...init, headers });
}

export function templateResponse(): Response {
  return htmlResponse(Bun.file(LIBRARY_TEMPLATE));
}
