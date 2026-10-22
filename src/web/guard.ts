import { isIP } from "node:net";
import { json } from "./http.ts";

export function localHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1") return true;

  if (isIP(host) === 4) {
    const [first = 0, second = 0] = host.split(".").map(Number);

    return (
      first === 127 ||
      first === 10 ||
      (first === 192 && second === 168) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 100 && second >= 64 && second <= 127)
    );
  }

  return isIP(host) === 6 && /^(fc|fd|fe[89ab])/i.test(host);
}

export function guard(request: Request): Response | null {
  const host = request.headers.get("host") ?? "";
  let hostname: string;

  try {
    hostname = new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return json({ error: "forbidden host" }, 403);
  }

  if (!localHost(hostname)) return json({ error: "forbidden host" }, 403);

  if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
    const origin = request.headers.get("origin");

    if (origin) {
      try {
        if (new URL(origin).host.toLowerCase() !== host.toLowerCase())
          return json({ error: "cross-origin request rejected" }, 403);
      } catch {
        return json({ error: "cross-origin request rejected" }, 403);
      }
    }
  }

  return null;
}
