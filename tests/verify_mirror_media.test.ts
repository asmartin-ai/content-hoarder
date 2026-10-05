import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { verifyMirror } from "../scripts/verify_mirror_media.ts";

function temporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), "verify-mirror-media-"));
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

test("verifies content-addressed blobs and reports one-byte corruption", async () => {
  const directory = temporaryDirectory();

  try {
    const good = Buffer.from("synthetic valid media bytes");
    writeFileSync(join(directory, hash(good)), good);
    const original = Buffer.from("synthetic bytes to corrupt");
    const name = hash(original);
    const corrupted = Buffer.from(original);
    corrupted[0] = (corrupted[0] ?? 0) ^ 1;
    const corruptPath = join(directory, name);
    writeFileSync(corruptPath, corrupted);

    const result = await verifyMirror(directory);
    expect(result.checked).toBe(2);
    expect(result.mismatched).toBe(1);
    expect(result.mismatchLines).toEqual([
      `MISMATCH ${corruptPath}  expected=${name}  got=${hash(corrupted)}`,
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("skips non-blob files and limits reported paths to twenty", async () => {
  const directory = temporaryDirectory();

  try {
    mkdirSync(join(directory, "nested"));
    const bytes = Buffer.from("valid");
    writeFileSync(join(directory, hash(bytes)), bytes);
    writeFileSync(join(directory, "Thumbs.db"), "housekeeping");

    for (let index = 0; index < 21; index++) {
      writeFileSync(join(directory, "nested", `junk-${index}.tmp`), "ignored");
    }

    const result = await verifyMirror(directory);
    expect(result.checked).toBe(1);
    expect(result.mismatched).toBe(0);
    expect(result.mismatchLines).toEqual([]);
    expect(result.nonBlobCount).toBe(22);
    expect(result.nonBlobPaths).toHaveLength(20);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("accepts a valid empty destination", async () => {
  const directory = temporaryDirectory();

  try {
    expect(await verifyMirror(directory)).toEqual({
      checked: 0,
      mismatched: 0,
      mismatchLines: [],
      nonBlobCount: 0,
      nonBlobPaths: [],
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("CLI reports a missing destination with exit status one", () => {
  const parent = temporaryDirectory();
  const missing = join(parent, "missing");

  try {
    const result = Bun.spawnSync(
      [
        process.execPath,
        "run",
        join(import.meta.dir, "../scripts/verify_mirror_media.ts"),
        missing,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(`ERROR: dest does not exist: ${missing}`);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
