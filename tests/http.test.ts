import { expect, test } from "bun:test";
import { isPublicAddress, request, safeFetchUrl } from "../src/_http.ts";
import { withOnline } from "./network.ts";

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

test("tests run offline: public hosts are refused, opted-in loopback still works", () => {
  expect(safeFetchUrl("https://www.reddit.com/r/x/comments/abc/.json")).toEqual([false, "offline"]);
  expect(safeFetchUrl("https://api.pullpush.io/reddit/search")[0]).toBe(false);
  expect(safeFetchUrl("http://127.0.0.1:1234/v1", { allowLoopback: true })).toEqual([true, "ok"]);
});

test("online mode lets public hosts through the guard again", () =>
  withOnline(() => {
    expect(safeFetchUrl("https://www.reddit.com/r/x/comments/abc/.json")).toEqual([true, "ok"]);
  }));

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

test("the URL guard refuses literal CGNAT addresses", () =>
  withOnline(() => {
    expect(safeFetchUrl("http://100.100.1.2/")).toEqual([false, "blocked_host"]);
    expect(safeFetchUrl("http://100.64.0.1/")).toEqual([false, "blocked_host"]);
    expect(safeFetchUrl("http://100.127.255.255/")).toEqual([false, "blocked_host"]);
  }));

test("isPublicAddress rejects CGNAT, mapped CGNAT and loopback, accepts the next range", () => {
  expect(isPublicAddress("100.64.0.1")).toBe(false);
  expect(isPublicAddress("100.127.255.255")).toBe(false);
  expect(isPublicAddress("100.128.0.1")).toBe(true);
  expect(isPublicAddress("::ffff:100.64.0.1")).toBe(false);
  expect(isPublicAddress("::")).toBe(false);
  expect(isPublicAddress("::1")).toBe(false);
  expect(isPublicAddress("8.8.8.8")).toBe(true);
  expect(isPublicAddress("not-an-ip")).toBe(false);
});
