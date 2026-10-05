import { existsSync, lstatSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";

const SENSITIVE_PATH_PATTERNS: readonly RegExp[] = [
  /(^|\/)\.env(?:\.(?!example$)[^/]+)?$/i,
  /(^|\/)data\/.*\.db$/,
  /(^|\/)data\/.*\.db-(shm|wal)$/,
  /(^|\/)data\/media\//,
  /(^|\/)exports?\//,
  /(^|\/)takeout.*\//i,
  /\.db$/,
  /\.sqlite$/,
  /(^|\/)nsfw_rules\.json$/,
  /(^|\/)data\/.*\.backup-/i,
  /delete-audit\.jsonl$/,
  /(^|\/)unsave-audit\.jsonl$/,
];

const SECRET_PATTERNS: readonly RegExp[] = [
  /AKIA[0-9A-Z]{16}/,
  /(?<![A-Z0-9])[0-9A-Za-z_-]{200,}/,
  /-----BEGIN (RSA |EC |OPENSSH |PGP |)PRIVATE KEY-----/,
  /["']?(client_secret|api_secret|secret_key|access_token|refresh_token)["']?\s*[=:]\s*["'][A-Za-z0-9/+=]{20,}["']/i,
];

const PLACEHOLDER_VALUES = new Set([
  "change-me-to-something-random",
  "your-secret-here",
  "changeme",
  "redacted",
  "",
]);

const PLACEHOLDER_LINE_RE = /(example|placeholder|todo|change.?me|your-|xxx|<|\{\{)/i;

const HISTORY_EXTENSIONS: readonly string[] = [
  ".py",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".json",
  ".jsonc",
  ".txt",
  ".md",
  ".yaml",
  ".yml",
  ".toml",
];

export type FindingKind = "DATA_TRACKED" | "SECRET" | "HISTORY_SECRET";

export type Finding = { path: string; kind: FindingKind; line?: number };

type GitResult = { exitCode: number; stdout: string; stderr: string };

function git(root: string, args: string[]): GitResult {
  const result = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });

  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

function trackedPaths(root: string): string[] {
  const result = git(root, ["ls-files"]);

  if (result.exitCode !== 0) {
    throw new Error(`git ls-files failed: ${result.stderr.trim()}`);
  }

  return result.stdout.split(/\r?\n/).filter((path) => path.length > 0);
}

function hasSensitivePath(path: string): boolean {
  return SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(path));
}

function secretLine(text: string): boolean {
  for (const pattern of SECRET_PATTERNS) {
    const match = pattern.exec(text);

    if (match === null) continue;
    const value = match[0].replace(/[="'\s]/g, "").toLowerCase();

    if (PLACEHOLDER_LINE_RE.test(value) || PLACEHOLDER_VALUES.has(value)) return false;

    return true;
  }

  return false;
}

function scanWorkingTree(root: string, paths: string[]): Finding[] {
  const findings: Finding[] = [];

  for (const path of paths) {
    if (path.startsWith("tests/") && !path.startsWith("tests/fixtures/")) continue;
    const fullPath = resolve(root, path);

    if (fullPath !== root && !fullPath.startsWith(`${root}${sep}`)) continue;

    if (!existsSync(fullPath) || !lstatSync(fullPath).isFile()) continue;
    let contents: string;

    try {
      contents = readFileSync(fullPath, "utf8");
    } catch {
      continue;
    }

    const lines = contents.split(/\r?\n/);

    for (let index = 0; index < lines.length; index += 1) {
      if (secretLine(lines[index]!)) findings.push({ path, kind: "SECRET", line: index + 1 });
    }
  }

  return findings;
}

function isHistoryCandidate(path: string): boolean {
  const lower = path.toLowerCase();

  return (
    HISTORY_EXTENSIONS.some((extension) => lower.endsWith(extension)) ||
    lower.endsWith(".env") ||
    lower.includes("env")
  );
}

function historyFindings(root: string, maxBlobs: number): Finding[] {
  const listing = git(root, ["rev-list", "--all", "--objects"]);

  if (listing.exitCode !== 0) return [];
  const findings: Finding[] = [];
  const seen = new Set<string>();

  for (const entry of listing.stdout.split(/\r?\n/)) {
    const splitAt = entry.indexOf(" ");

    if (splitAt < 0) continue;
    const sha = entry.slice(0, splitAt);
    const path = entry.slice(splitAt + 1);

    if (
      seen.has(sha) ||
      !isHistoryCandidate(path) ||
      (path.startsWith("tests/") && !path.startsWith("tests/fixtures/"))
    ) {
      continue;
    }

    seen.add(sha);
    const blob = git(root, ["cat-file", "-p", sha]);

    if (blob.exitCode !== 0) continue;

    if (!blob.stdout.split(/\r?\n/).some(secretLine)) continue;
    findings.push({ path, kind: "HISTORY_SECRET" });

    if (findings.length >= maxBlobs) return findings;
  }

  return findings;
}

export function scanRepository(
  rootPath: string,
  history = false,
  maxHistoryFindings = 50,
): Finding[] {
  const root = resolve(rootPath);
  const tracked = trackedPaths(root);

  const findings: Finding[] = tracked
    .filter(hasSensitivePath)
    .map((path) => ({ path, kind: "DATA_TRACKED" }));

  findings.push(...scanWorkingTree(root, tracked));

  if (history) findings.push(...historyFindings(root, maxHistoryFindings));

  return findings;
}

export function formatFindings(findings: Finding[]): string {
  if (findings.length === 0) return "publish_safety_check: clean — no sensitive content found.\n";
  const grouped = new Map<FindingKind, Set<string>>();

  for (const finding of findings) {
    const paths = grouped.get(finding.kind) ?? new Set<string>();
    paths.add(finding.line === undefined ? finding.path : `${finding.path}:${finding.line}`);
    grouped.set(finding.kind, paths);
  }

  let output = `publish_safety_check: ${findings.length} finding(s) — BLOCK before publishing:\n\n`;

  for (const kind of [...grouped.keys()].sort()) {
    output += `== ${kind} ==\n`;
    const paths = grouped.get(kind);

    if (paths) {
      for (const path of [...paths].sort()) output += `  ${path}\n`;
    }

    output += "\n";
  }

  return output;
}

export function main(args: string[], root = resolve(import.meta.dir, "..")): number {
  const unknown = args.filter((arg) => arg !== "--history");

  if (unknown.length > 0) {
    console.error(`Unknown argument: ${unknown[0]}`);

    return 2;
  }

  const findings = scanRepository(root, args.includes("--history"));
  process.stdout.write(formatFindings(findings));

  return findings.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exitCode = main(Bun.argv.slice(2));
