/**
 * One shared fetch transport primitive for every network caller.
 *
 * SSRF-guarded, retry/backoff-carrying transport. Async — every network caller
 * awaits it. Any 4xx/5xx status raises `HttpError`; 429/5xx retry when
 * retries remain, honoring `Retry-After` exactly.
 */

import { BlockList, isIP } from "node:net";
import { offline } from "./config.ts";

const _RETRY_JITTER_CAP = 60.0; // seconds; full-jitter backoff never waits longer than this

// Global rate cap: never pace inter-request gaps faster than this, even if a
// caller passes a tiny throttle. ~0.6s ≈ Reddit's authenticated 100 QPM
// budget; the real defaults (drain 1.0s, hydrate 2.0s) sit far above it,
// so this only guards against misconfiguration.
export const MIN_THROTTLE = 0.6;

// Public DNS names pass through; private and special IP ranges are blocked.
// The explicit loopback option is only for configured local-origin services.
const _LOCALHOST_NAMES = {
  localhost: true,
  "localhost.localdomain": true,
} as const;

const _IPV4_BLOCKED: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 11],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

const _blockedIps = new BlockList();

const _mappedIpv4 = new BlockList();

_mappedIpv4.addSubnet("::ffff:0:0", 96, "ipv6");

for (const [network, prefix] of _IPV4_BLOCKED) _blockedIps.addSubnet(network, prefix, "ipv4");

for (const [network, prefix] of [
  ["::", 8],
  ["fe80::", 10],
  ["fc00::", 7],
  ["ff00::", 8],
  ["2001:db8::", 32],
] as const)
  _blockedIps.addSubnet(network, prefix, "ipv6");

/**
 * Validate an HTTP(S) fetch target without network access. `allowLoopback`
 * permits only HTTP localhost, 127.0.0.1, and ::1 URLs.
 */
export function safeFetchUrl(
  url: string,
  opts: { allowLoopback?: boolean } = {},
): readonly [boolean, string] {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    return [false, "bad_url"];
  }

  const scheme = parsed.protocol.slice(0, -1).toLowerCase();
  const hostClean = parsed.hostname.toLowerCase();
  const host = hostClean.startsWith("[") ? hostClean.slice(1, -1) : hostClean;
  const authority = /^https?:\/\/([^/?#]*)/i.exec(url)?.[1] ?? "";
  const hostPort = authority.slice(authority.lastIndexOf("@") + 1);

  const rawHost = hostPort.startsWith("[")
    ? hostPort.slice(0, hostPort.indexOf("]") + 1).toLowerCase()
    : (hostPort.split(":", 1)[0] ?? "").toLowerCase();

  if (scheme !== "http" && scheme !== "https") return [false, "bad_scheme"];

  if (!host) return [false, "no_host"];

  if (rawHost.includes("%")) return [false, "blocked_host"];

  if (
    opts.allowLoopback &&
    scheme === "http" &&
    ((host === "localhost" && rawHost === "localhost") ||
      (host === "127.0.0.1" && rawHost === "127.0.0.1") ||
      (host === "::1" && rawHost === "[::1]"))
  )
    return [true, "ok"];

  if (offline()) return [false, "offline"];
  const hostWithoutDot = host.endsWith(".") ? host.slice(0, -1) : host;

  if (
    Object.hasOwn(_LOCALHOST_NAMES, host) ||
    Object.hasOwn(_LOCALHOST_NAMES, hostWithoutDot) ||
    host.endsWith(".localhost") ||
    hostWithoutDot.endsWith(".localhost")
  )
    return [false, "blocked_host"];
  const kind = isIP(host);

  if (kind === 0) return [true, "ok"];

  if (kind === 4 && rawHost !== hostClean) return [false, "blocked_host"];

  if (kind === 6 && _mappedIpv4.check(host, "ipv6")) return [false, "blocked_host"];

  return _blockedIps.check(host, kind === 4 ? "ipv4" : "ipv6")
    ? [false, "blocked_host"]
    : [true, "ok"];
}

/** Raised by `request` on any non-success HTTP / network / transport condition. */
export class HttpError extends Error {
  status: number | null;
  retryAfter: number | null;
  headers: Record<string, string>;
  kind: string | null;
  reason: unknown;

  constructor(
    message: string,
    opts: {
      status?: number | null;
      retryAfter?: number | null;
      headers?: Record<string, string> | null;
      kind?: string | null;
      reason?: unknown;
    } = {},
  ) {
    super(message);
    this.name = "HttpError";
    this.status = opts.status ?? null;
    this.retryAfter = opts.retryAfter ?? null;
    this.headers = opts.headers ?? {};
    this.kind = opts.kind ?? null;
    this.reason = opts.reason;
  }
}

/** Numeric `Retry-After` from a (case-insensitively searched) header dict. */
export function retryAfterSeconds(
  headers: Record<string, string> | null | undefined,
): number | null {
  const found = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === "retry-after");

  if (!found) return null;
  const seconds = Number.parseFloat(found[1]);

  return Number.isNaN(seconds) || seconds < 0 ? null : seconds;
}

/**
 * AWS "full jitter" backoff: a uniform random wait in
 * `[0, min(cap, base * 2**attempt)]`. Lowest upstream load / no
 * thundering herd — we optimize for being polite to the server, not
 * for our own completion time. `attempt` is 0-based; `rng` is
 * injectable so tests stay deterministic.
 */
export function fullJitterDelay(
  base: number,
  attempt: number,
  opts: { cap?: number; rng?: () => number } = {},
): number {
  const cap = opts.cap ?? _RETRY_JITTER_CAP;
  const rng = opts.rng ?? Math.random;

  return rng() * Math.min(cap, base * 2 ** attempt);
}

/**
 * A steady-state politeness delay jittered around `base` — uniform in
 * `[0.75*base, 1.75*base)` so no two successive gaps are identical
 * (kills the exact-interval bot fingerprint). For `base=2.0` this is
 * the de-risking spec's `uniform(1.5, 3.5)`. `rng` injectable for
 * deterministic tests.
 */
export function jitteredThrottle(base: number, opts: { rng?: () => number } = {}): number {
  const rng = opts.rng ?? Math.random;

  return base * (0.75 + rng());
}

/**
 * Percent-encode a URL's path + query so the request line stays ASCII.
 *
 * A non-ASCII char in the URL (e.g. a unicode slug in a legacy Reddit
 * permalink `/r/x/comments/abc/café/`) must be transformed **only when
 * the URL isn't already ASCII**, so every existing (ASCII) URL is
 * returned byte-for-byte unchanged. The broad `safe` sets include `%`,
 * preserving any pre-existing `%xx` escapes (no double-encoding) and
 * the query's `=&` structure. The host is assumed ASCII (true for our
 * endpoints).
 */
function asciiSafeUrl(url: string): string {
  let needsEncoding = false;

  for (const character of url) {
    if ((character.codePointAt(0) ?? 0) > 0x7f) {
      needsEncoding = true;
      break;
    }
  }

  if (!needsEncoding) return url;
  const p = new URL(url);

  const quote = (s: string, safe: string): string => {
    let out = "";

    for (const ch of s) {
      const code = ch.codePointAt(0) ?? 0;

      if (
        (code >= 0x30 && code <= 0x39) ||
        (code >= 0x41 && code <= 0x5a) ||
        (code >= 0x61 && code <= 0x7a) ||
        code === 0x2d ||
        code === 0x2e ||
        code === 0x5f ||
        code === 0x7e ||
        safe.includes(ch)
      ) {
        out += ch;
      } else {
        for (const byte of new TextEncoder().encode(ch)) {
          out += "%" + byte.toString(16).toUpperCase().padStart(2, "0");
        }
      }
    }

    return out;
  };

  const path = quote(p.pathname, "/%:@-._~!$&'()*+,;=");
  const query = quote(p.search.replace(/^\?/, ""), "=&%:@-._~!$'()*+,;/?");

  return `${p.protocol}//${p.host}${path}${query ? `?${query}` : ""}${p.hash}`;
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string> | null;
  data?: Uint8Array | string | null;
  /** Seconds. */
  timeout?: number;
  retries?: number;
  backoff?: number;
  /** Takes seconds. Injectable for deterministic tests. */
  sleep?: (seconds: number) => Promise<void> | void;
  userAgent?: string | null;
  jitter?: boolean;
  rng?: () => number;
  /** Allows only HTTP URLs targeting localhost, 127.0.0.1, or ::1. */
  allowLoopback?: boolean;
  /** Reject a successful response once its body exceeds this byte limit. */
  maxResponseBytes?: number;
}

/**
 * GET/POST `url` and return `[status, headersDict, rawBytes]`.
 *
 * On success the status is the response status, `headersDict` carries
 * the response headers as a plain dict, and `rawBytes` is the
 * undecoded body — adapters decode or JSON-parse as they see fit.
 *
 * Raises `HttpError` on an HTTP error status, a URL/transport error,
 * or a read timeout. When `retries > 0`, a 429 or 5xx response is
 * retried up to `retries` extra times: a numeric `Retry-After` is
 * always honored exactly; otherwise the wait is `backoff` doubled
 * each attempt, or — when `jitter=true` — AWS full-jitter
 * (`fullJitterDelay`, the lower-load default). The final failure
 * still raises `HttpError` carrying the last status / Retry-After /
 * headers.
 */
async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array> {
  const length = Number(response.headers.get("content-length"));

  if (Number.isFinite(length) && length > maxBytes) {
    await response.body?.cancel();
    throw new HttpError("response exceeds byte limit", { kind: "size" });
  }

  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  while (true) {
    const { done, value } = await reader.read();

    if (done) break;

    if (!value) continue;
    size += value.byteLength;

    if (size > maxBytes) {
      await reader.cancel();
      throw new HttpError("response exceeds byte limit", { kind: "size" });
    }

    chunks.push(value);
  }

  const body = new Uint8Array(size);
  let offset = 0;

  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return body;
}

export async function request(
  url: string,
  opts: RequestOptions = {},
): Promise<[number, Record<string, string>, Uint8Array]> {
  const method = opts.method ?? "GET";
  const timeout = opts.timeout ?? 20.0;
  const retries = opts.retries ?? 0;
  const backoff = opts.backoff ?? 2.0;
  const jitter = opts.jitter ?? false;
  const sleep = opts.sleep ?? Bun.sleep;
  const rng = opts.rng ?? Math.random;

  const reqHeaders = { ...opts.headers };

  if (opts.userAgent !== null && opts.userAgent !== undefined) {
    if (reqHeaders["User-Agent"] === undefined) {
      reqHeaders["User-Agent"] = opts.userAgent;
    }
  }

  const [safe, reason] = safeFetchUrl(url, { allowLoopback: opts.allowLoopback });

  if (!safe)
    throw new HttpError(`blocked request URL (${reason}): ${url}`, { kind: "url", reason });
  const target = asciiSafeUrl(url);

  let delay = backoff;

  for (let attempt = 0; attempt <= retries; attempt++) {
    let resp: Response;
    let raw: Uint8Array;

    try {
      resp = await fetch(target, {
        method,
        headers: reqHeaders,
        // Body must be bytes when present (POST); GET carries none.
        body:
          opts.data instanceof Uint8Array
            ? new Uint8Array(opts.data)
            : opts.data
              ? new TextEncoder().encode(opts.data)
              : undefined,
        signal: AbortSignal.timeout(timeout * 1000),
      });
      raw =
        resp.status >= 400
          ? new Uint8Array()
          : opts.maxResponseBytes === undefined
            ? new Uint8Array(await resp.arrayBuffer())
            : await readBounded(resp, opts.maxResponseBytes);
    } catch (e) {
      if (e instanceof HttpError) throw e;

      // Read timeouts surface as TimeoutError (AbortSignal.timeout) and do NOT
      // go through the network-error branch — catch them so a stall can't escape.
      if (e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError")) {
        throw new HttpError(`connection error for ${url}: ${e}`, { kind: "conn" });
      }

      // TypeError from fetch = DNS/refused/network-level failure (tagged
      // "url", the network reason — not "conn").
      throw new HttpError(`network error for ${url}: ${e instanceof Error ? e.message : e}`, {
        kind: "url",
        reason: e,
      });
    }

    const respHeaders: Record<string, string> = {};
    resp.headers.forEach((v, k) => {
      respHeaders[k] = v;
    });

    if (resp.status >= 400) {
      const ra = retryAfterSeconds(respHeaders);

      if (attempt < retries && (resp.status === 429 || (resp.status >= 500 && resp.status < 600))) {
        if (ra !== null) {
          await sleep(ra); // authoritative — honor exactly
        } else if (jitter) {
          await sleep(fullJitterDelay(backoff, attempt, { rng }));
        } else {
          await sleep(delay);
        }

        delay *= 2;
        continue;
      }

      throw new HttpError(`HTTP ${resp.status} for ${url}`, {
        status: resp.status,
        retryAfter: ra,
        headers: respHeaders,
        kind: "http",
      });
    }

    return [resp.status, respHeaders, raw];
  }

  throw new HttpError(`request retry loop exhausted for ${url}`, {
    kind: "conn",
  });
}
