import { expect, test } from "bun:test";
import { request, safeFetchUrl } from "../src/_http.ts";

test("local LLM transport opt-in permits only exact HTTP loopback origins", () => {
  expect(safeFetchUrl("http://localhost:1234/v1", { allowLoopback: true })).toEqual([true, "ok"]);
  expect(safeFetchUrl("http://127.0.0.1:1234/v1", { allowLoopback: true })).toEqual([true, "ok"]);
  expect(safeFetchUrl("http://[::1]:1234/v1", { allowLoopback: true })).toEqual([true, "ok"]);
  expect(safeFetchUrl("https://localhost:1234/v1", { allowLoopback: true })[0]).toBe(false);
  expect(safeFetchUrl("http://127.0.0.2:1234/v1", { allowLoopback: true })[0]).toBe(false);
  expect(safeFetchUrl("http://192.168.1.5:1234/v1", { allowLoopback: true })[0]).toBe(false);
  expect(safeFetchUrl("http://localhost:1234/v1")[0]).toBe(false);
  expect(safeFetchUrl("http://localhost./", { allowLoopback: true })[0]).toBe(false);
  expect(safeFetchUrl("http://sub.localhost./")[0]).toBe(false);
});

test("canonical IPv6 and mapped special ranges remain blocked", () => {
  for (const url of [
    "http://[::1]/",
    "http://[::]/",
    "http://[fe80:0000:0000:0000:0000:0000:0000:0001]/",
    "http://[fc00::1]/",
    "http://[ff02::1]/",
    "http://[2001:db8::1]/",
    "http://[::ffff:7f00:1]/",
    "http://[::ffff:a9fe:a9fe]/",
  ])
    expect(safeFetchUrl(url)[0]).toBe(false);
  expect(safeFetchUrl("http://[::ffff:808:808]/")[0]).toBe(false);
  expect(safeFetchUrl("http://2130706433/")[0]).toBe(false);
  expect(safeFetchUrl("http://0x7f000001/")[0]).toBe(false);
  expect(safeFetchUrl("http://2130706433/", { allowLoopback: true })[0]).toBe(false);
});

test("HTTP requests to IPv6 loopback need explicit opt-in", async () => {
  const server = Bun.serve({ hostname: "::1", port: 0, fetch: () => new Response("local-only") });

  try {
    const url = `http://[::1]:${server.port}/`;
    await expect(request(url, { retries: 0 })).rejects.toMatchObject({ kind: "url" });
    const [status, , body] = await request(url, { allowLoopback: true, retries: 0 });
    expect(status).toBe(200);
    expect(new TextDecoder().decode(body)).toBe("local-only");
  } finally {
    server.stop(true);
  }
});
