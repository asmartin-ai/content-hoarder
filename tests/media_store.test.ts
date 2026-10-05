import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isValidId, mimeFor, pathFor, store, storePath } from "../src/media_store";

test("media blobs are content-addressed, deduplicated, and traversal-safe", async () => {
  const root = mkdtempSync(join(tmpdir(), "content-hoarder-media-"));
  const bytes = new TextEncoder().encode("synthetic image data");
  const first = store(bytes, { mime: "image/png", baseDir: root });
  const path = pathFor(first, { baseDir: root });
  expect(first.endsWith(".png")).toBe(true);

  if (!path) throw new Error("stored blob could not be resolved");
  expect(readFileSync(path).equals(Buffer.from(bytes))).toBe(true);
  const modified = statSync(path).mtimeMs;
  expect(store(bytes, { mime: "image/png", baseDir: root })).toBe(first);
  expect(statSync(path).mtimeMs).toBe(modified);
  expect(isValidId(first)).toBe(true);
  expect(isValidId(`../${first}`)).toBe(false);
  expect(pathFor("../etc/passwd", { baseDir: root })).toBeNull();
  expect(mimeFor(first)).toBe("image/png");

  const source = join(root, "video");
  await Bun.write(source, bytes);
  expect(await storePath(source, { mime: "video/webm", baseDir: root })).toBe(
    `${first.slice(0, 64)}.webm`,
  );
});
