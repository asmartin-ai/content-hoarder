import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

export type MirrorVerification = {
  checked: number;
  mismatched: number;
  mismatchLines: string[];
  nonBlobCount: number;
  nonBlobPaths: string[];
};

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");

  for await (const chunk of createReadStream(path)) hash.update(chunk);

  return hash.digest("hex");
}

export async function verifyMirror(dest: string): Promise<MirrorVerification> {
  const result: MirrorVerification = {
    checked: 0,
    mismatched: 0,
    mismatchLines: [],
    nonBlobCount: 0,
    nonBlobPaths: [],
  };

  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);

      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }

      if (!entry.isFile()) continue;

      const stem = entry.name.includes(".")
        ? entry.name.slice(0, entry.name.lastIndexOf("."))
        : entry.name;

      if (!/^[0-9a-f]{64}$/.test(stem)) {
        result.nonBlobCount++;

        if (result.nonBlobPaths.length < 20) result.nonBlobPaths.push(path);
        continue;
      }

      result.checked++;
      const actual = await sha256File(path);

      if (actual !== stem) {
        result.mismatched++;
        result.mismatchLines.push(`MISMATCH ${path}  expected=${stem}  got=${actual}`);
      }
    }
  }

  await walk(dest);

  return result;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const dest = argv[0] ?? "/path/to/media";

  try {
    const info = await stat(dest);

    if (!info.isDirectory()) throw Object.assign(new Error("not a directory"), { code: "ENOTDIR" });
  } catch {
    console.error(`ERROR: dest does not exist: ${dest}`);
    console.error("Run scripts/mirror-media.bat first.");

    return 1;
  }

  const result = await verifyMirror(dest);

  for (const line of result.mismatchLines) console.log(line);

  for (const path of result.nonBlobPaths) console.error(`non-blob (skipped): ${path}`);

  if (result.nonBlobCount > 20)
    console.error(`... and ${result.nonBlobCount - 20} more non-blob files`);
  console.log(
    `\n=== Result ===\n  files checked: ${result.checked}\n  mismatches:    ${result.mismatched}`,
  );

  if (result.mismatched)
    console.log(`\nFAILED: ${result.mismatched} blob(s) failed integrity check.`);
  else if (result.checked) console.log("\nOK: all blobs verified.");

  return result.mismatched ? 1 : 0;
}

if (import.meta.main) process.exitCode = await main();
