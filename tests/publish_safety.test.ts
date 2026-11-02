import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanRepository } from "../scripts/publish_safety_check.ts";

type GitResult = { exitCode: number; stdout: string; stderr: string };

function runGit(root: string, args: string[]): GitResult {
  const result = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });

  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

function withRepository(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "publish-safety-"));

  try {
    const init = runGit(root, ["init", "-q"]);

    if (init.exitCode !== 0) throw new Error(`git init failed: ${init.stderr}`);
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function trackAndCommit(root: string, message: string): void {
  for (const args of [
    ["add", "-A"],
    [
      "-c",
      "user.name=Safety Test",
      "-c",
      "user.email=safety@example.invalid",
      "commit",
      "-qm",
      message,
    ],
  ]) {
    const result = runGit(root, args);

    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
}

test("tracked sensitive paths and credential contents are reported", () => {
  withRepository((root) => {
    mkdirSync(join(root, "data"), { recursive: true });
    mkdirSync(join(root, "exports"), { recursive: true });
    mkdirSync(join(root, "tests", "fixtures", "sandbox"), { recursive: true });
    writeFileSync(join(root, ".env"), "MODE=local\n");
    writeFileSync(join(root, ".env.local"), "MODE=local\n");
    writeFileSync(join(root, "data", "private.db"), "synthetic db\n");
    writeFileSync(join(root, "exports", "records.json"), "[]\n");
    writeFileSync(
      join(root, "config.json"),
      'access_token="abcdefghijklmnopqrstuvwxyz1234567890" # example config\n',
    );
    writeFileSync(
      join(root, "tests", "fixtures", "sandbox", "items.json"),
      '{"access_token":"abcdefghijklmnopqrstuvwxyz1234567890"}\n',
    );
    trackAndCommit(root, "fixtures with sensitive content");

    const findings = scanRepository(root);
    expect(findings).toContainEqual({ path: ".env", kind: "DATA_TRACKED" });
    expect(findings).toContainEqual({ path: ".env.local", kind: "DATA_TRACKED" });
    expect(findings).toContainEqual({ path: "data/private.db", kind: "DATA_TRACKED" });
    expect(findings).toContainEqual({ path: "exports/records.json", kind: "DATA_TRACKED" });
    expect(findings).toContainEqual({ path: "config.json", kind: "SECRET", line: 1 });
    expect(findings).toContainEqual({
      path: "tests/fixtures/sandbox/items.json",
      kind: "SECRET",
      line: 1,
    });
  });
});

test("placeholder examples and safe tracked fixtures pass", () => {
  withRepository((root) => {
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "tests"), { recursive: true });
    writeFileSync(join(root, ".env.example"), "API_SECRET=change-me-to-something-random\n");
    writeFileSync(join(root, "src", "config.json"), 'client_secret="placeholderplaceholder"\n');
    writeFileSync(
      join(root, "tests", "detector.test.ts"),
      'const sample = "AKIAABCDEFGHIJKLMNOP";\n',
    );
    writeFileSync(join(root, "README.md"), "Configuration uses environment variables.\n");
    trackAndCommit(root, "safe fixtures");

    expect(scanRepository(root)).toEqual([]);
  });
});

test("optional history scan finds a secret removed from the current tree", () => {
  withRepository((root) => {
    writeFileSync(
      join(root, "config.ts"),
      'api_secret="your-secret-here"\napi_secret="abcdefghijklmnopqrstuvwxyz1234567890"\n',
    );
    trackAndCommit(root, "synthetic historical credential");
    writeFileSync(join(root, "config.ts"), "api_secret=redacted\n");
    trackAndCommit(root, "remove synthetic credential");

    expect(scanRepository(root)).toEqual([]);
    expect(scanRepository(root, true)).toContainEqual({
      path: "config.ts",
      kind: "HISTORY_SECRET",
    });
  });
});

function withDenylist(run: () => void): void {
  const directory = mkdtempSync(join(tmpdir(), "publish-denylist-"));
  const file = join(directory, "denylist.txt");
  const previous = process.env.CONTENT_HOARDER_PUBLISH_DENYLIST;

  writeFileSync(file, "# synthetic terms\nplaceholder-owner-handle\n");
  process.env.CONTENT_HOARDER_PUBLISH_DENYLIST = file;

  try {
    run();
  } finally {
    if (previous === undefined) delete process.env.CONTENT_HOARDER_PUBLISH_DENYLIST;
    else process.env.CONTENT_HOARDER_PUBLISH_DENYLIST = previous;
    rmSync(directory, { recursive: true, force: true });
  }
}

test("private identifiers and machine paths are reported in source and tests", () => {
  withDenylist(() =>
    withRepository((root) => {
      mkdirSync(join(root, "src"), { recursive: true });
      mkdirSync(join(root, "tests"), { recursive: true });
      writeFileSync(join(root, "src", "handles.ts"), 'const owner = "placeholder-owner-handle";\n');
      const homePath = ["/home", "someone", "Projects", "app", "data"].join("/");
      const drivePath = ["K:", "Projects", "app", "data"].join("\\");

      writeFileSync(join(root, "tests", "handles.test.ts"), `const path = "${homePath}";\n`);
      writeFileSync(join(root, "README.md"), `Backups live in \`${drivePath}\`.\n`);
      writeFileSync(join(root, "docs.md"), "Set it to `C:\\path\\to\\app` or `/home/user/app`.\n");
      trackAndCommit(root, "synthetic identifiers");

      const findings = scanRepository(root);

      expect(findings).toContainEqual({
        path: "src/handles.ts",
        kind: "PRIVATE_IDENTIFIER",
        line: 1,
      });
      expect(findings).toContainEqual({
        path: "tests/handles.test.ts",
        kind: "PRIVATE_IDENTIFIER",
        line: 1,
      });
      expect(findings).toContainEqual({ path: "README.md", kind: "PRIVATE_IDENTIFIER", line: 1 });
      expect(findings.every((finding) => finding.path !== "docs.md")).toBe(true);
    }),
  );
});
