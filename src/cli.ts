import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import * as config from "./config.ts";
import * as db from "./db.ts";
import { createInterface } from "node:readline/promises";
import { importPath } from "./pipeline.ts";
import { allConnectors } from "./connectors/registry.ts";
import { VERSION } from "./version.ts";
import * as categorize from "./categorize.ts";
import * as dedup from "./dedup.ts";
import * as enrich from "./enrich.ts";
import * as exportModule from "./export.ts";
import { evaluateAllFolders, evaluateFolder } from "./folders.ts";
import type { FolderQueryDefinition } from "./db.ts";
import { serveApp } from "./web.ts";
import { recoverTitles } from "./youtube_recover.ts";
import { countTargets, recover } from "./archival/service.ts";
import * as noteYoutube from "./note_youtube.ts";
import * as consolidate from "./consolidate.ts";
import * as ocrModule from "./ocr.ts";
import * as mediaArchive from "./media_archive.ts";
import { scanMedia } from "./media_scan.ts";
import {
  hydrateOne,
  hydrateFromDir,
  hydrateBatch,
  backfillTitlesLocal,
  backfillTitlesNetwork,
  backfillThumbnails,
} from "./reddit_hydrate.ts";
import {
  isAutosyncEnabled,
  setAutosyncEnabled,
  sync as syncReddit,
  RECONCILE_MAX_PAGES,
} from "./reddit_sync.ts";
import { sync as syncHn } from "./hn_sync.ts";
import * as redditUnsave from "./reddit_unsave.ts";
import * as redditTrickle from "./reddit_trickle.ts";
import * as redditOauth from "./reddit_oauth.ts";
import * as firefoxTabs from "./firefox_tabs.ts";
import * as firefoxYoutube from "./firefox_youtube.ts";
import * as rsmThreads from "./rsm_threads.ts";
import * as redgifs from "./redgifs_resolver.ts";
import * as tagSuggest from "./tag_suggest.ts";
import * as triageScore from "./triage_score.ts";
import * as llm from "./assist/llm.ts";
import * as resurface from "./resurface.ts";
import * as karakeep from "./bridge/karakeep.ts";

const commandOptions = {
  "init-db": {},
  import: {
    positional: true,
    source: "string",
    enrich: "boolean",
    reconcile: "boolean",
    "reconcile-dry-run": "boolean",
    "reconcile-complete": "boolean",
  },
  "reddit-hydrate-titles": { "dry-run": "boolean", network: "boolean", limit: "string" },
  enrich: {
    source: "string",
    all: "boolean",
    archives: "boolean",
    titles: "boolean",
    scores: "boolean",
    "gallery-previews": "boolean",
    limit: "string",
  },
  categorize: {
    source: "string",
    all: "boolean",
    limit: "string",
    "dry-run": "boolean",
    topics: "boolean",
    llm: "boolean",
    backend: "string",
    suggest: "boolean",
    discovery: "boolean",
    review: "boolean",
    accept: "string",
    reject: "string",
    tag: "string",
    "source-type": "string",
  },
  "reddit-hydrate": {
    positional: true,
    from: "string",
    limit: "string",
    "include-orphans": "boolean",
    overwrite: "boolean",
    batch: "boolean",
    throttle: "string",
    "dry-run": "boolean",
    yes: "boolean",
  },
  "reddit-thumbnails": { apply: "boolean", limit: "string" },
  dedup: { by: "string", resolve: "boolean", clear: "boolean" },
  "migrate-firefox-tabs": { apply: "boolean" },
  "firefox-token": { generate: "boolean" },
  "migrate-note-youtube": { apply: "boolean" },
  "migrate-rsm-threads": { from: "string", "all-threads": "boolean" },
  consolidate: { apply: "boolean", undo: "boolean" },
  serve: { host: "string", port: "string", tls: "boolean" },
  stats: {},
  sources: {},
  bankruptcy: { before: "string", source: "string", "dry-run": "boolean" },
  decay: {
    tag: "string",
    subreddit: "string",
    before: "string",
    source: "string",
    label: "string",
    apply: "boolean",
    undo: "boolean",
    "decayed-after": "string",
    "decayed-before": "string",
  },
  promote: { status: "string", limit: "string", "dry-run": "boolean" },
  "learn-triage": { "min-support": "string", alpha: "string", limit: "string", apply: "boolean" },
  "assist-auto-archive": {
    "min-skip-rate": "string",
    "min-support": "string",
    source: "string",
    apply: "boolean",
  },
  delete: {
    tag: "string",
    subreddit: "string",
    before: "string",
    fullname: "string",
    status: "string",
    swept: "boolean",
    source: "string",
    "also-unsave": "boolean",
    max: "string",
    apply: "boolean",
    yes: "boolean",
  },
  "purge-done": { "retention-days": "string", max: "string", apply: "boolean", yes: "boolean" },
  "scan-media": {
    status: "string",
    limit: "string",
    recheck: "boolean",
    workers: "string",
    batch: "string",
    apply: "boolean",
  },
  "archive-media": {
    salvageable: "boolean",
    galleries: "boolean",
    images: "boolean",
    twitter: "boolean",
    videos: "boolean",
    limit: "string",
    throttle: "string",
    "max-video-bytes": "string",
    "video-timeout": "string",
    apply: "boolean",
  },
  ocr: {
    limit: "string",
    apply: "boolean",
    force: "boolean",
    lang: "string",
    "min-confidence": "string",
    throttle: "string",
  },
  export: {
    out: "string",
    format: "string",
    tag: "string",
    status: "string",
    source: "string",
    subreddit: "string",
  },
  "export-obsidian": { vault: "string", status: "string" },
  suggest: { source: "string", limit: "string" },
  "reddit-sync": {
    "max-pages": "string",
    full: "boolean",
    reconcile: "boolean",
    "reconcile-dry-run": "boolean",
    "enable-auto": "boolean",
    "disable-auto": "boolean",
  },
  "hn-sync": { user: "string", "max-pages": "string", full: "boolean", throttle: "string" },
  "reddit-unsave": {
    login: "boolean",
    cookie: "string",
    enable: "boolean",
    disable: "boolean",
    drain: "boolean",
    live: "boolean",
    yes: "boolean",
    "dry-run": "boolean",
    trickle: "boolean",
    status: "boolean",
    "enqueue-existing": "boolean",
    limit: "string",
    throttle: "string",
  },
  "reddit-oauth": { login: "boolean", logout: "boolean", status: "boolean" },
  "triage-drift": {
    "min-support": "string",
    alpha: "string",
    limit: "string",
    "since-processed": "string",
    apply: "boolean",
  },
  snooze: {
    fullname: "string",
    until: "string",
    "window-days": "string",
    "escalate-after": "string",
    undo: "boolean",
    wave: "string",
    escalate: "boolean",
    limit: "string",
    apply: "boolean",
    yes: "boolean",
  },
  folder: {
    positional: true,
    source: "string",
    tag: "string",
    "tags-all": "boolean",
    status: "string",
    subreddit: "string",
    kind: "string",
    has: "string",
    q: "string",
    desc: "string",
    apply: "boolean",
    "dry-run": "boolean",
  },
  tag: { positional: true },
  "resolve-redgifs": { limit: "string", "redgifs-ok": "boolean", apply: "boolean" },
} as const;

type OptKind = "string" | "boolean";

const nestedCommandOptions = {
  folder: {
    list: [],
    create: ["source", "tag", "tags-all", "status", "subreddit", "kind", "has", "q", "desc"],
    rename: [],
    delete: [],
    evaluate: ["dry-run"],
    assign: [],
    stats: [],
  },
  tag: {
    list: [],
    create: [],
    rename: [],
    delete: [],
  },
} as const;

const nestedCommandHelp = {
  folder: `usage: content_hoarder folder [-h]
                              {list,create,rename,delete,evaluate,assign,stats} ...

positional arguments:
  {list,create,rename,delete,evaluate,assign,stats}
    list                List all folders with item counts.
    create              Create a folder from a saved query.
    rename              Rename a folder.
    delete              Delete a folder.
    evaluate            Evaluate folder rules and assign items.
    assign              Manually assign an item to a folder.
    stats               Per-folder item counts.

options:
  -h, --help            show this help message and exit`,
  "folder list": `usage: content_hoarder folder list [-h]

options:
  -h, --help  show this help message and exit`,
  "folder create": `usage: content_hoarder folder create [-h] [--source SOURCE] [--tag TAG]
                                     [--tags-all] [--status STATUS]
                                     [--subreddit SUBREDDIT] [--kind KIND]
                                     [--has HAS] [--q Q] [--desc DESCRIPTION]
                                     name

positional arguments:
  name                  Display name for the folder.

options:
  -h, --help            show this help message and exit
  --source SOURCE       Filter: source (reddit, youtube, ...)
  --tag TAG             Filter: tag(s) (repeatable for AND)
  --tags-all            Filter: require ALL specified tags (AND)
  --status STATUS       Filter: status (inbox, keep, archived, done)
  --subreddit SUBREDDIT
                        Filter: subreddit
  --kind KIND           Filter: item kind (post, comment, ...)
  --has HAS             Filter: has: video, body, image, media
  --q Q                 Filter: free-text search
  --desc DESCRIPTION    Optional description for the folder.`,
  "folder rename": `usage: content_hoarder folder rename [-h] id name

positional arguments:
  id          Folder id.
  name        New display name.

options:
  -h, --help  show this help message and exit`,
  "folder delete": `usage: content_hoarder folder delete [-h] id

positional arguments:
  id          Folder id.

options:
  -h, --help  show this help message and exit`,
  "folder evaluate": `usage: content_hoarder folder evaluate [-h] [--dry-run] [id]

positional arguments:
  id          Folder id (omit to evaluate all).

options:
  -h, --help  show this help message and exit
  --dry-run   Preview matches without writing.`,
  "folder assign": `usage: content_hoarder folder assign [-h] fullname [folder]

positional arguments:
  fullname    Item fullname.
  folder      Folder name (omit to clear).

options:
  -h, --help  show this help message and exit`,
  "folder stats": `usage: content_hoarder folder stats [-h]

options:
  -h, --help  show this help message and exit`,
  tag: `usage: content_hoarder tag [-h] {list,create,rename,delete} ...

positional arguments:
  {list,create,rename,delete}
    list                List registered user tags with item counts.
    create              Pre-create an empty user tag (0 items — issue #70).
    rename              Rename a user tag across the vocabulary in one action
                        (row + every item's stamp).
    delete              Delete a user tag (row + every item's stamp).

options:
  -h, --help            show this help message and exit`,
  "tag list": `usage: content_hoarder tag list [-h]

options:
  -h, --help  show this help message and exit`,
  "tag create": `usage: content_hoarder tag create [-h] name

positional arguments:
  name        Tag name (normalized to lowercase).

options:
  -h, --help  show this help message and exit`,
  "tag rename": `usage: content_hoarder tag rename [-h] id name

positional arguments:
  id          User tag id.
  name        New display name.

options:
  -h, --help  show this help message and exit`,
  "tag delete": `usage: content_hoarder tag delete [-h] id

positional arguments:
  id          User tag id.

options:
  -h, --help  show this help message and exit`,
} as const;

const pythonRootUsage = `usage: content_hoarder [-h] [--version]
                       {init-db,import,reddit-hydrate-titles,enrich,categorize,reddit-hydrate,reddit-thumbnails,dedup,migrate-firefox-tabs,firefox-token,migrate-note-youtube,migrate-rsm-threads,consolidate,serve,stats,sources,bankruptcy,decay,promote,learn-triage,assist-auto-archive,delete,purge-done,scan-media,archive-media,ocr,export,export-obsidian,suggest,reddit-sync,hn-sync,reddit-unsave,reddit-oauth,triage-drift,snooze,folder,tag,resolve-redgifs} ...`;

const nestedPositionalSpecs = {
  folder: {
    list: { minimum: 0, maximum: 0, required: [], integerIndex: undefined },
    create: { minimum: 1, maximum: 1, required: ["name"], integerIndex: undefined },
    rename: { minimum: 2, maximum: 2, required: ["id", "name"], integerIndex: 0 },
    delete: { minimum: 1, maximum: 1, required: ["id"], integerIndex: 0 },
    evaluate: { minimum: 0, maximum: 1, required: [], integerIndex: 0 },
    assign: { minimum: 1, maximum: 2, required: ["fullname"], integerIndex: undefined },
    stats: { minimum: 0, maximum: 0, required: [], integerIndex: undefined },
  },
  tag: {
    list: { minimum: 0, maximum: 0, required: [], integerIndex: undefined },
    create: { minimum: 1, maximum: 1, required: ["name"], integerIndex: undefined },
    rename: { minimum: 2, maximum: 2, required: ["id", "name"], integerIndex: 0 },
    delete: { minimum: 1, maximum: 1, required: ["id"], integerIndex: 0 },
  },
} as const;

function printNestedCommandHelp(command: "folder" | "tag", argv: string[]): number {
  const subcommand = argv.find((argument) => argument !== "--help" && argument !== "-h");
  const helpName = subcommand ? `${command} ${subcommand}` : command;
  const helpEntry = Object.entries(nestedCommandHelp).find(([name]) => name === helpName);

  if (helpEntry) {
    console.log(helpEntry[1]);

    return 0;
  }

  const usage = nestedCommandHelp[command].split("\n\n")[0];

  const choices = Object.keys(nestedCommandOptions[command])
    .map((name) => `'${name}'`)
    .join(", ");

  console.error(
    `${usage}\ncontent_hoarder ${command}: error: argument ${command}_cmd: invalid choice: '${subcommand}' (choose from ${choices})`,
  );

  return 2;
}

function printNestedParseError(command: "folder" | "tag", argv: string[], error: Error): number {
  const subcommand = argv[0];
  const parentUsage = nestedCommandHelp[command].split("\n\n")[0];

  if (!subcommand) {
    console.error(
      `${parentUsage}\ncontent_hoarder ${command}: error: the following arguments are required: ${command}_cmd`,
    );

    return 2;
  }

  const positionalSpec = Object.entries(nestedPositionalSpecs[command]).find(
    ([name]) => name === subcommand,
  );

  const choiceList = Object.keys(nestedCommandOptions[command])
    .map((name) => `'${name}'`)
    .join(", ");

  if (!positionalSpec) {
    console.error(
      `${parentUsage}\ncontent_hoarder ${command}: error: argument ${command}_cmd: invalid choice: '${subcommand}' (choose from ${choiceList})`,
    );

    return 2;
  }

  const subcommandHelp = Object.entries(nestedCommandHelp).find(
    ([name]) => name === `${command} ${subcommand}`,
  )?.[1];

  const usage = subcommandHelp?.split("\n\n")[0] ?? parentUsage;

  const options =
    Object.entries(nestedCommandOptions[command]).find(([name]) => name === subcommand)?.[1] ?? [];

  const positionalSpecValue = positionalSpec[1];
  const positionals: string[] = [];
  const unrecognized: string[] = [];
  let missingOption: string | undefined;

  for (let index = 1; index < argv.length; index++) {
    const token = argv[index] ?? "";

    if (token === "--") {
      positionals.push(...argv.slice(index + 1));

      break;
    }

    if (token.startsWith("-")) {
      const separator = token.indexOf("=");

      const optionName = token.slice(
        token.startsWith("--") ? 2 : 1,
        separator < 0 ? undefined : separator,
      );

      const hasValue = separator >= 0;

      if (!options.some((allowedOption) => allowedOption === optionName)) {
        unrecognized.push(token);

        if (!hasValue && argv[index + 1] && !argv[index + 1]!.startsWith("-"))
          unrecognized.push(argv[++index]!);

        continue;
      }

      if (optionName !== "tags-all" && optionName !== "dry-run" && !hasValue) {
        const value = argv[index + 1];

        if (!value || value.startsWith("-")) missingOption = optionName;
        else index++;
      }

      continue;
    }

    positionals.push(token);
  }

  if (missingOption) {
    console.error(
      `${usage}\ncontent_hoarder ${command} ${subcommand}: error: argument --${missingOption}: expected one argument`,
    );

    return 2;
  }

  if (unrecognized.length) {
    console.error(
      `${pythonRootUsage}\ncontent_hoarder: error: unrecognized arguments: ${unrecognized.join(" ")}`,
    );

    return 2;
  }

  if (positionals.length < positionalSpecValue.minimum) {
    const required = positionalSpecValue.required.slice(positionals.length);

    console.error(
      `${usage}\ncontent_hoarder ${command} ${subcommand}: error: the following arguments are required: ${required.join(", ")}`,
    );

    return 2;
  }

  if (positionals.length > positionalSpecValue.maximum) {
    console.error(
      `${pythonRootUsage}\ncontent_hoarder: error: unrecognized arguments: ${positionals.slice(positionalSpecValue.maximum).join(" ")}`,
    );

    return 2;
  }

  if (positionalSpecValue.integerIndex !== undefined) {
    const id = positionals[positionalSpecValue.integerIndex];

    if (id !== undefined && !/^[+-]?\d+$/.test(id)) {
      console.error(
        `${usage}\ncontent_hoarder ${command} ${subcommand}: error: argument id: invalid int value: '${id}'`,
      );

      return 2;
    }
  }

  console.error(`error: ${error.message}`);

  return 2;
}

type CommandName = keyof typeof commandOptions;

type CliValue = string | boolean | string[];

interface CliArgs {
  _: string[];
  [key: string]: CliValue | undefined;
}

interface CliParseOption {
  type: OptKind;
  multiple: boolean;
}

interface CliParseOptions {
  [name: string]: CliParseOption;
}

const CliValueSchema = z.union([z.string(), z.boolean(), z.array(z.string())]);

const help = `Local triage-first content manager.\n\nCommands:\n  init-db, import, enrich, categorize, dedup, serve, stats, sources, bankruptcy, decay, delete, purge-done, scan-media, archive-media, ocr, export, export-obsidian, promote, suggest, learn-triage, assist-auto-archive, triage-drift, snooze, reddit-sync, hn-sync, reddit-unsave, reddit-oauth, reddit-hydrate, reddit-hydrate-titles, reddit-thumbnails, migrate-firefox-tabs, firefox-token, migrate-note-youtube, migrate-rsm-threads, consolidate, folder, tag, resolve-redgifs\n\nUse <command> --help for command options.\n`;

function commandSchema(command: string): (typeof commandOptions)[CommandName] | null {
  if (!Object.hasOwn(commandOptions, command)) return null;

  // SAFETY: hasOwn above verifies command names this module defines.
  return commandOptions[command as CommandName];
}

function printCommandHelp(command: string): void {
  const schema = commandSchema(command);

  if (!schema) throw new Error(`unknown command: ${command}`);

  const rows = Object.entries(schema)
    .filter(([name]) => name !== "positional")
    .map(([name, kind]) => `  --${name}${kind === "boolean" ? "" : ` <${name.toUpperCase()}>`}`)
    .join("\n");

  const positionals = new Map([
    ["import", "<PATH>"],
    ["reddit-hydrate", "[FULLNAME]"],
    ["folder", "<SUBCOMMAND> [ARGS...]"],
    ["tag", "<SUBCOMMAND> [ARGS...]"],
  ]);

  const usage = positionals.get(command) ? ` ${positionals.get(command)}` : "";
  console.log(
    `Usage: content-hoarder ${command}${usage} [options]${rows ? `\n\nOptions:\n${rows}` : ""}`,
  );
}

function parseCommandArgs(command: string, argv: string[]): CliArgs {
  const schema = commandSchema(command);

  if (!schema) throw new Error(`unknown command: ${command}`);
  const positional = "positional" in schema;

  const nestedOptions =
    command === "folder" || command === "tag"
      ? Object.entries(nestedCommandOptions[command]).find(([name]) => name === argv[0])?.[1]
      : undefined;

  if ((command === "folder" || command === "tag") && nestedOptions === undefined)
    throw new Error(`unknown ${command} subcommand: ${argv[0] ?? ""}`);

  const repeatable = new Set(
    command === "decay"
      ? ["tag", "subreddit"]
      : command === "delete"
        ? ["tag", "subreddit", "fullname"]
        : command === "folder" || command === "export"
          ? ["tag"]
          : command === "snooze"
            ? ["fullname"]
            : [],
  );

  const options: CliParseOptions = {};
  const allowedNestedOptions = nestedOptions ? new Set<string>(nestedOptions) : null;

  for (const [name, kind] of Object.entries(schema)) {
    if (name !== "positional" && (!allowedNestedOptions || allowedNestedOptions.has(name)))
      options[name] = {
        type: kind === "boolean" ? "boolean" : "string",
        multiple: repeatable.has(name),
      };
  }

  const parsed = parseArgs({
    args: argv,
    options,
    allowPositionals: true,
    strict: true,
    tokens: false,
  });

  if (!positional && parsed.positionals.length)
    throw new Error(`unexpected argument: ${parsed.positionals[0]}`);
  const result: CliArgs = { _: parsed.positionals };

  for (const [name, value] of Object.entries(parsed.values)) {
    const validated = CliValueSchema.safeParse(value);

    if (validated.success) result[name] = validated.data;
  }

  if (command === "folder" || command === "tag") {
    const subcommand = result._[0] ?? "";
    const restLength = result._.length - 1;

    const spec = Object.entries(nestedPositionalSpecs[command]).find(
      ([name]) => name === subcommand,
    )?.[1];

    if (!spec || restLength < spec.minimum || restLength > spec.maximum)
      throw new Error(`invalid positional arguments for ${command} ${subcommand}`);

    if (spec.integerIndex !== undefined) {
      const id = result._[spec.integerIndex + 1];

      if (id !== undefined && !/^[+-]?\d+$/.test(id))
        throw new Error(`invalid integer positional for ${command} ${subcommand}`);
    }
  }

  const by = text(result, "by");
  const format = text(result, "format");
  const backend = text(result, "backend");

  if (command === "dedup" && by !== undefined && by !== "url" && by !== "title")
    throw new Error("--by must be url or title");

  if (command === "export" && format !== undefined && format !== "csv" && format !== "json")
    throw new Error("--format must be csv or json");

  if (
    command === "categorize" &&
    backend !== undefined &&
    backend !== "local" &&
    backend !== "fireworks"
  )
    throw new Error("--backend must be local or fireworks");

  if (command === "hn-sync" && !text(result, "user")) throw new Error("hn-sync requires --user");

  if (command === "migrate-rsm-threads" && !text(result, "from"))
    throw new Error("migrate-rsm-threads requires --from");

  if (
    command === "import" &&
    bool(result, "reconcile-complete") &&
    !bool(result, "reconcile") &&
    !bool(result, "reconcile-dry-run")
  )
    throw new Error("--reconcile-complete requires --reconcile or --reconcile-dry-run");

  return result;
}

function bool(args: CliArgs, name: string): boolean {
  return args[name] === true;
}

function text(args: CliArgs, name: string, fallback?: string): string | undefined {
  const value = z.string().safeParse(args[name]);

  return value.success ? value.data : fallback;
}

function number(args: CliArgs, name: string, fallback?: number): number | undefined {
  const value = text(args, name);

  if (value === undefined) return fallback;

  if (!value.trim()) throw new Error(`--${name} must be a number`);
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) throw new Error(`--${name} must be a number`);

  if (
    [
      "limit",
      "max",
      "retention-days",
      "workers",
      "batch",
      "max-pages",
      "min-support",
      "since-processed",
      "window-days",
      "escalate-after",
      "max-video-bytes",
      "video-timeout",
    ].includes(name) &&
    !Number.isInteger(parsed)
  )
    throw new Error(`--${name} must be an integer`);

  return parsed;
}

function values(args: CliArgs, name: string): string[] | undefined {
  const parsed = z.union([z.string(), z.array(z.string())]).safeParse(args[name]);

  if (!parsed.success) return undefined;

  return Array.isArray(parsed.data) ? parsed.data : [parsed.data];
}

function compactPythonJson(value: FolderQueryDefinition): string {
  const serialized = JSON.stringify(value);

  if (serialized === undefined) return "{}";

  let output = "";
  let inString = false;
  let escaped = false;

  for (const character of serialized) {
    output += character;

    if (escaped) {
      escaped = false;

      continue;
    }

    if (inString && character === "\\") {
      escaped = true;

      continue;
    }

    if (character === '"') inString = !inString;
    else if (!inString && (character === "," || character === ":")) output += " ";
  }

  return output;
}

function json<T>(value: T): void {
  console.log(JSON.stringify(value, null, 2));
}

function openDb(): Database {
  return db.connect();
}

function parseDate(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const epoch = Date.parse(value);

  if (!Number.isFinite(epoch) || !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value))
    throw new Error(`${flag} must be YYYY-MM-DD (got ${JSON.stringify(value)})`);

  return Math.floor(epoch / 1000);
}

export function backupDb(conn: Database, suffix: string): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 15);

  const backupPath = join(dirname(config.dbPath()), `app.backup-${suffix}-${stamp}.db`);
  mkdirSync(dirname(backupPath), { recursive: true });
  conn.query("VACUUM INTO ?").run(backupPath);

  return backupPath;
}

function appendAudit<T>(filename: string, audit: T): void {
  const path = join(dirname(config.dbPath()), filename);
  appendFileSync(path, `${JSON.stringify(audit)}\n`, "utf8");
}

async function run(command: string, args: CliArgs): Promise<number> {
  switch (command) {
    case "init-db": {
      const conn = openDb();
      const backfilled = db.normalizeProcessingTags(conn);

      try {
        db.initDb(conn);
      } finally {
        conn.close();
      }

      const note = backfilled ? ` (backfilled ${backfilled} processing-tag rows)` : "";
      console.log(`Initialized database at ${config.dbPath()}${note}`);

      return 0;
    }

    case "import": {
      const path = args._[0];

      if (!path || args._.length !== 1) throw new Error("import requires exactly one path");
      const conn = openDb();

      try {
        const result = await importPath(conn, path, {
          source: text(args, "source"),
          enrich: bool(args, "enrich"),
          reconcile: bool(args, "reconcile"),
          reconcileDryRun: bool(args, "reconcile-dry-run"),
          reconcileComplete: bool(args, "reconcile-complete"),
        });

        console.log(
          `imported=${result.imported} skipped=${result.skipped} errors=${result.errors.length}`,
        );

        for (const error of result.errors.slice(0, 10)) console.log(`  ! ${error}`);

        if (result.reconcile !== null) {
          console.log(
            `${bool(args, "reconcile-dry-run") ? "[dry-run] " : ""}reconcile (mark missing reddit saves as un-saved):`,
          );

          for (const kind of ["post", "comment"] as const) {
            const info = result.reconcile[kind];

            if (info.skipped)
              console.log(`  ${kind}: skipped (${info.skipped}; ${info.present} in export)`);
            else
              console.log(
                `  ${kind}: ${info.present} in export, ${bool(args, "reconcile-dry-run") ? "would un-save" : "un-saved"} ${info.unsaved}`,
              );
          }
        }
      } finally {
        conn.close();
      }

      return 0;
    }

    case "stats": {
      const conn = openDb();

      try {
        json(db.getCounts(conn));
      } finally {
        conn.close();
      }

      return 0;
    }

    case "sources":
      for (const connector of allConnectors())
        console.log(
          `${connector.id.padEnd(11)} ${connector.label}${connector.id === "firefox" ? " (deferred)" : ""}`,
        );

      return 0;
    case "serve":
      return runServe(args);
    case "bankruptcy": {
      const before = parseDate(text(args, "before"), "--before");

      if (before === undefined) throw new Error("--before is required");
      const conn = openDb();

      try {
        const count = db.bankruptcy(conn, before, {
          source: text(args, "source"),
          dryRun: bool(args, "dry-run"),
        });

        console.log(
          `${bool(args, "dry-run") ? "would archive" : "archived"} ${count} inbox item(s) older than ${text(args, "before")}`,
        );
      } finally {
        conn.close();
      }

      return 0;
    }

    case "decay": {
      const conn = openDb();

      try {
        if (bool(args, "undo")) {
          if (values(args, "tag") || values(args, "subreddit") || text(args, "before"))
            throw new Error("--tag/--subreddit/--before don't apply to --undo");

          const result = db.undecay(conn, {
            decayedAfter: parseDate(text(args, "decayed-after"), "--decayed-after"),
            decayedBefore: parseDate(text(args, "decayed-before"), "--decayed-before"),
            apply: bool(args, "apply"),
          });

          json(result);

          if (!bool(args, "apply"))
            console.error(
              `(dry run — ${result.total} decayed item(s) would return to inbox; re-run with --apply to commit.)`,
            );
        } else {
          const before = parseDate(text(args, "before"), "--before");
          const tags = values(args, "tag") ?? [];

          if (!tags.length && !values(args, "subreddit") && before === undefined)
            throw new Error("decay needs at least one selector: --tag, --subreddit, or --before");

          const unknown = tags.filter(
            (tag) => !categorize.FILTER_TAGS.some((curatedTag) => curatedTag === tag),
          );

          if (unknown.length)
            console.error(
              `warning: tag(s) not in the curated vocabulary (typo?): ${unknown.join(", ")}`,
            );

          const result = db.decay(conn, {
            tags,
            subreddits: values(args, "subreddit"),
            beforeUtc: before,
            source: text(args, "source", "reddit"),
            label: text(args, "label"),
            apply: bool(args, "apply"),
          });

          json(result);

          if (!bool(args, "apply"))
            console.error(
              `(dry run — ${result.total} inbox item(s) would decay to archived; re-run with --apply to commit. Run against a COPY of the DB first.)`,
            );
        }
      } finally {
        conn.close();
      }

      return 0;
    }

    case "delete":
      return runDelete(args);
    case "purge-done":
      return runPurgeDone(args);
    case "snooze":
      return runSnooze(args);
    case "folder":
      return runFolder(args);
    case "tag":
      return runTag(args);
    default:
      return runExtended(command, args);
  }
}

async function runServe(args: CliArgs): Promise<number> {
  const host = text(args, "host", config.host()) ?? config.host();
  const port = number(args, "port", config.port()) ?? config.port();
  const tls = bool(args, "tls") || config.get("CONTENT_HOARDER_TLS") === "1";
  const server = await serveApp({ dbPath: config.dbPath(), host, port, tls });
  console.log(`Serving on ${tls ? "https" : "http"}://${host}:${server.port}/  (Ctrl+C to stop)`);

  return 0;
}

function runDelete(args: CliArgs): number {
  const tags = values(args, "tag");
  const subreddits = values(args, "subreddit");
  const fullnames = values(args, "fullname");
  const beforeUtc = parseDate(text(args, "before"), "--before");

  if (
    !tags?.length &&
    !subreddits?.length &&
    !fullnames?.length &&
    beforeUtc === undefined &&
    !bool(args, "swept") &&
    !text(args, "status")
  ) {
    throw new Error(
      "delete needs at least one selector (--tag/--subreddit/--before/--fullname/--swept/--status)",
    );
  }

  const options = {
    tags,
    subreddits,
    beforeUtc,
    source: text(args, "source", "reddit"),
    status: text(args, "status"),
    swept: bool(args, "swept"),
    fullnames,
    alsoUnsave: bool(args, "also-unsave"),
    maxRows: number(args, "max", 5000),
  };

  const conn = openDb();

  try {
    const plan = db.deleteItems(conn, { ...options, apply: false });

    if (!bool(args, "apply")) {
      json(plan);
      console.error(
        `(dry run — ${plan.total} item(s) would be PERMANENTLY deleted; re-run with --apply --yes to commit. Irreversible except via the automatic backup.)`,
      );

      return 0;
    }

    if (!bool(args, "yes")) {
      json(plan);
      console.error("refusing: a hard delete needs BOTH --apply and --yes.");

      return 3;
    }

    const backup = backupDb(conn, "pre-delete");
    const result = db.deleteItems(conn, { ...options, apply: true });
    appendAudit("delete-audit.jsonl", {
      ts: Math.floor(Date.now() / 1000),
      selectors: options,
      result,
      backup,
    });
    json({ ...result, backup });
  } finally {
    conn.close();
  }

  return 0;
}

function runPurgeDone(args: CliArgs): number {
  const conn = openDb();

  try {
    const retention = number(args, "retention-days");

    if (retention !== undefined)
      db.setSetting(conn, "done_retention_days", String(Math.trunc(retention)));
    const now = Math.floor(Date.now() / 1000);
    const maxRows = number(args, "max", 5000) ?? 5000;
    const plan = db.purgeDone(conn, { now, maxRows, apply: false });

    if (!bool(args, "apply")) {
      json(plan);
      console.error(
        `(dry run — ${plan.total} done item(s) older than ${plan.retention_days}d would be PERMANENTLY deleted; re-run with --apply --yes. Irreversible except via the automatic backup.)`,
      );

      return 0;
    }

    if (!bool(args, "yes")) {
      json(plan);
      console.error("refusing: a retention purge needs BOTH --apply and --yes.");

      return 3;
    }

    if (plan.total > maxRows) {
      json(plan);
      console.error(
        `refusing: ${plan.total} > --max ${maxRows} (blast-radius cap); raise --max deliberately if intended.`,
      );

      return 4;
    }

    const backup = backupDb(conn, "pre-purge-done");
    const result = db.purgeDone(conn, { now, maxRows, apply: true });
    appendAudit("delete-audit.jsonl", {
      ts: Math.floor(Date.now() / 1000),
      op: "purge_done",
      retentionDays: retention,
      result,
      backup,
    });
    json({ ...result, backup });
  } finally {
    conn.close();
  }

  return 0;
}

function runSnooze(args: CliArgs): number {
  const conn = openDb();

  try {
    const fullnames = values(args, "fullname");
    const threshold = number(args, "escalate-after", 3) ?? 3;
    const apply = bool(args, "apply");
    const confirmed = bool(args, "yes");

    if (bool(args, "undo")) {
      const wave = number(args, "wave");

      if (wave === undefined) throw new Error("--undo needs --wave");
      const plan = db.unsnooze(conn, { snoozedWave: wave, apply: false });

      if (!apply) {
        json(plan);
        console.error(
          `(dry run — ${plan.total} snoozed item(s) would be unsnoozed; re-run with --apply --yes to commit.)`,
        );

        return 0;
      }

      if (!confirmed) {
        json(plan);
        console.error("refusing: snooze undo needs BOTH --apply and --yes.");

        return 3;
      }

      const backup = backupDb(conn, "pre-unsnooze");
      const result = db.unsnooze(conn, { snoozedWave: wave, apply: true });
      appendAudit("snooze-audit.jsonl", {
        ts: Math.floor(Date.now() / 1000),
        op: "unsnooze",
        wave,
        result,
        backup,
      });
      json({ result, backup });

      return 0;
    }

    if (bool(args, "escalate")) {
      const options = { escalateAfter: threshold, limit: number(args, "limit") };
      const plan = resurface.escalateSnoozed(conn, { ...options, apply: false });

      if (!apply) {
        json(plan);
        console.error(
          `(dry run — ${plan.total} repeat-snoozed item(s) would decay; re-run with --apply --yes to commit.)`,
        );

        return 0;
      }

      if (!confirmed) {
        json(plan);
        console.error("refusing: snooze escalation needs BOTH --apply and --yes.");

        return 3;
      }

      const backup = backupDb(conn, "pre-snooze-escalate");
      const result = resurface.escalateSnoozed(conn, { ...options, apply: true });
      appendAudit("snooze-audit.jsonl", {
        ts: Math.floor(Date.now() / 1000),
        op: "escalate",
        result,
        backup,
      });
      json({ result, backup });

      return 0;
    }

    if (!fullnames?.length)
      throw new Error("snooze needs at least one --fullname (or --undo/--escalate)");
    const explicitUntil = number(args, "until");
    const windowArg = number(args, "window-days", 7) ?? 7;

    if (explicitUntil !== undefined && text(args, "window-days") !== undefined)
      throw new Error("--until and --window-days are mutually exclusive");

    const windowDays =
      explicitUntil === undefined
        ? Math.trunc(windowArg)
        : Math.max(0, Math.round((explicitUntil - Date.now() / 1000) / 86400));

    const untilUtc = explicitUntil ?? Math.floor(Date.now() / 1000) + windowDays * 86400;
    const options = { fullnames, untilUtc, windowDays, escalateAfter: threshold };
    const plan = db.snooze(conn, { ...options, apply: false });

    if (!apply) {
      json(plan);
      console.error(
        `(dry run — ${plan.snoozed.length} item(s) would snooze and ${plan.escalated.length} would decay; re-run with --apply --yes to commit.)`,
      );

      return 0;
    }

    if (!confirmed) {
      json(plan);
      console.error("refusing: snooze needs BOTH --apply and --yes.");

      return 3;
    }

    const backup = backupDb(conn, "pre-snooze");
    const result = db.snooze(conn, { ...options, apply: true });
    appendAudit("snooze-audit.jsonl", {
      ts: Math.floor(Date.now() / 1000),
      op: "snooze",
      fullnames,
      untilUtc,
      windowDays,
      escalateAfter: threshold,
      result,
      backup,
    });
    json({ result, backup });

    return 0;
  } finally {
    conn.close();
  }
}

async function runFolder(args: CliArgs): Promise<number> {
  const [subcommand, ...rest] = args._;
  const conn = openDb();

  try {
    if (subcommand === "list") {
      const folders = db.listFolders(conn);
      const counts = db.folderCounts(conn);

      for (const folder of folders) {
        const name = String(folder.name);
        const query = folder.query_def;
        console.log(`[${String(folder.id)}] ${name}  (${counts[name] ?? 0} items)`);
        console.log(`      rule: ${query ? compactPythonJson(query) : "(no filter)"}`);

        if (folder.description) console.log(`      desc: ${String(folder.description)}`);
      }

      if (!folders.length) console.log("(no folders defined)");

      return 0;
    }

    if (subcommand === "assign") {
      const fullname = rest[0] ?? "";
      const folderName = rest[1] ?? null;

      if (!db.setItemFolder(conn, fullname, folderName)) {
        console.error(`error: item ${fullname} not found`);

        return 1;
      }

      console.log(
        folderName
          ? `Assigned ${fullname} -> folder '${folderName}'`
          : `Cleared folder on ${fullname}`,
      );

      return 0;
    }

    if (subcommand === "stats") {
      const counts = db.folderCounts(conn);
      const entries = Object.entries(counts).sort((left, right) => right[1] - left[1]);

      if (!entries.length) {
        console.log("(no items assigned to folders)");

        return 0;
      }

      const total = entries.reduce((sum, [, count]) => sum + count, 0);
      console.log(`${"Folder".padEnd(30)} ${"Items".padStart(6)}`);
      console.log("-".repeat(38));

      for (const [name, count] of entries)
        console.log(`${name.padEnd(30)} ${String(count).padStart(6)}`);
      console.log("-".repeat(38));
      console.log(`${"Total".padEnd(30)} ${String(total).padStart(6)}`);

      return 0;
    }

    if (subcommand === "create") {
      const queryDef: FolderQueryDefinition = {};

      for (const key of ["source", "status", "subreddit", "kind", "has", "q"] as const) {
        const value = text(args, key);

        if (value !== undefined) queryDef[key] = value;
      }

      const tags = values(args, "tag");

      if (tags?.length) queryDef.tag = tags;

      if (bool(args, "tags-all")) queryDef.tags_all = true;
      const folder = db.createFolder(conn, rest[0] ?? "", queryDef, text(args, "desc", ""));
      console.log(`Created folder [${String(folder.id)}] ${String(folder.name)}`);
      json(folder);

      return 0;
    }

    if (subcommand === "rename") {
      const id = numberFrom(rest[0], "folder id");
      const name = rest[1] ?? "";
      const renamed = db.renameFolder(conn, id, name);

      if (!renamed) {
        console.error(`error: folder ${id} not found`);

        return 1;
      }

      console.log(`Renamed folder [${String(renamed.id)}] -> ${String(renamed.name)}`);

      return 0;
    }

    if (subcommand === "delete") {
      const id = numberFrom(rest[0], "folder id");

      if (!db.deleteFolder(conn, id)) {
        console.error(`folder ${id} not found`);

        return 1;
      }

      console.log(`Deleted folder ${id}`);

      return 0;
    }

    if (subcommand === "evaluate") {
      const opts = { dryRun: bool(args, "dry-run") };

      const result = rest[0]
        ? [evaluateFolder(conn, numberFrom(rest[0], "folder id"), opts)]
        : evaluateAllFolders(conn, opts);

      for (const folder of result)
        console.log(
          `${opts.dryRun ? "[DRY RUN] " : ""}${folder.folder_name ?? "?"}: ${folder.total ?? 0} matched (+${folder.newly_assigned ?? 0} new, -${folder.cleared ?? 0} removed)`,
        );

      return 0;
    }

    throw new Error("folder requires list, create, rename, delete, evaluate, assign, or stats");
  } finally {
    conn.close();
  }
}

async function runTag(args: CliArgs): Promise<number> {
  const [subcommand, ...rest] = args._;
  const conn = openDb();

  try {
    if (subcommand === "list") {
      const tags = db.listUserTags(conn);

      if (!tags.length) {
        console.log("(no user tags registered — try `tag create <name>`)");

        return 0;
      }

      for (const tag of tags) console.log(`[${tag.id}] ${tag.name}  (${tag.item_count} item(s))`);

      return 0;
    }

    if (subcommand === "create") {
      const name = rest[0] ?? "";
      const created = db.createUserTag(conn, name);
      console.log(`Created user tag [${created.id}] ${created.name}`);

      return 0;
    }

    if (subcommand === "rename") {
      const id = numberFrom(rest[0], "tag id");
      const name = rest[1] ?? "";
      const renamed = db.renameUserTagInVocab(conn, id, name);
      console.log(`Renamed user tag [${renamed.id}] -> ${renamed.name}`);

      return 0;
    }

    if (subcommand === "delete") {
      const id = numberFrom(rest[0], "tag id");

      if (!db.deleteUserTag(conn, id)) {
        console.error(`error: user tag ${id} not found`);

        return 1;
      }

      console.log(`Deleted user tag ${id}`);

      return 0;
    }

    throw new Error("tag requires list, create, rename, or delete");
  } finally {
    conn.close();
  }
}

function numberFrom(value: string | undefined, name: string): number {
  const result = Number(value);

  if (value === undefined || !Number.isInteger(result))
    throw new Error(`${name} must be an integer`);

  return result;
}

async function runRedditUnsave(conn: Database, args: CliArgs): Promise<number> {
  if (bool(args, "login")) {
    const cookie = text(args, "cookie");

    if (!cookie) throw new Error('--login requires --cookie "<reddit_session value>"');

    try {
      console.log(`Signed in as u/${await redditUnsave.login(conn, cookie.trim())}`);
    } catch (error) {
      console.error(`cookie rejected: ${error instanceof Error ? error.message : String(error)}`);

      return 1;
    }

    return 0;
  }

  if (bool(args, "enable") || bool(args, "disable")) {
    (bool(args, "enable") ? redditUnsave.enable : redditUnsave.disable)(conn);
    console.log(`unsave-on-done ${bool(args, "enable") ? "enabled" : "disabled"}`);

    return 0;
  }

  if (bool(args, "enqueue-existing")) {
    console.log(
      `queued ${redditUnsave.enqueueExisting(conn)} existing 'done' reddit item(s) for unsaving`,
    );

    return 0;
  }

  if (bool(args, "trickle")) {
    if (db.getSetting(conn, "reddit_unsave_on_done", "0") !== "1") {
      console.error("trickle skipped: unsave-on-done is OFF — run `reddit-unsave --enable` first.");

      return 0;
    }

    const [audit, auditPath] = redditUnsave.auditAppender(config.dbPath());

    const result = await redditTrickle.trickle(conn, {
      limit: number(args, "limit", redditTrickle.DEFAULT_CAP),
      audit,
    });

    json({ ...result, audit_log: auditPath });

    return result.auth_error || result.network_error ? 1 : 0;
  }

  if (bool(args, "drain")) {
    const execute = bool(args, "live") && bool(args, "yes") && !bool(args, "dry-run");

    if (!execute) {
      const plan = await redditUnsave.drain(conn, { limit: number(args, "limit"), dryRun: true });
      json(plan);

      if (bool(args, "live") && !bool(args, "yes") && !bool(args, "dry-run")) {
        console.error(
          "refusing: --live needs --yes too. The plan above is a DRY RUN — nothing was sent.",
        );

        return 2;
      }

      return 0;
    }

    const [audit, auditPath] = redditUnsave.auditAppender(config.dbPath());

    const result = await redditUnsave.drain(conn, {
      limit: number(args, "limit"),
      throttle: number(args, "throttle", 1),
      audit,
      progress: (message) => console.error(message),
    });

    json({ ...result, audit_log: auditPath });

    return result.auth_error || result.network_error ? 1 : 0;
  }

  json(redditUnsave.status(conn));

  return 0;
}

async function runRedditOAuth(conn: Database, args: CliArgs): Promise<number> {
  if (bool(args, "logout")) {
    redditOauth.clear(conn);
    console.log("reddit OAuth tokens cleared.");

    return 0;
  }

  if (!bool(args, "login")) {
    json(redditOauth.status(conn));

    return 0;
  }

  if (!redditOauth.clientId()) {
    console.error("error: set REDDIT_OAUTH_CLIENT_ID (.env or a user env var) first.");

    return 2;
  }

  const state = redditOauth.newState();
  const url = redditOauth.buildAuthorizeUrl({ state });
  console.log(
    `Open this URL, approve read + history + identity + save, then paste the redirected URL or code:\\n\\n${url}\\n`,
  );
  const prompt = createInterface({ input: process.stdin, output: process.stdout });

  try {
    const redirectResponse = await prompt.question("Redirect URL or code: ");
    const username = await redditOauth.login(conn, { redirectResponse, expectedState: state });
    console.log(`OAuth configured${username ? ` as u/${username}` : ""}.`);

    return 0;
  } catch (error) {
    console.error(`OAuth failed: ${error instanceof Error ? error.message : String(error)}`);

    return 1;
  } finally {
    prompt.close();
  }
}

async function runExtended(command: string, args: CliArgs): Promise<number> {
  const conn = openDb();

  try {
    switch (command) {
      case "categorize": {
        const source = text(args, "source", "youtube") ?? "youtube";
        const tag = text(args, "tag");
        const limit = number(args, "limit");

        if (bool(args, "suggest")) {
          const result = bool(args, "discovery")
            ? tagSuggest.suggestFromDiscovery(conn, { limit })
            : bool(args, "llm")
              ? await tagSuggest.suggestFromLlm(conn, { limit, source: text(args, "source") })
              : tagSuggest.suggestFromRuleMatches(conn, {
                  source: text(args, "source"),
                  limit,
                  retry: bool(args, "all"),
                });

          json(result);

          return 0;
        }

        if (bool(args, "review")) {
          const suggestions = tagSuggest.listSuggestions(conn, {
            status: "pending",
            tag,
            sourceType: text(args, "source-type"),
            limit,
          });

          json({
            pending: suggestions.length,
            by_tag: tagSuggest.suggestionCounts(conn),
            suggestions,
          });

          return 0;
        }

        for (const [operation, bulk] of [
          ["accept", tagSuggest.acceptAllSuggestions],
          ["reject", tagSuggest.rejectAllSuggestions],
        ] as const) {
          const id = text(args, operation);

          if (id === undefined) continue;

          if (id === "all") {
            json({ [operation === "accept" ? "accepted" : "rejected"]: bulk(conn, { tag }) });

            return 0;
          }

          const parsedId = Number(id);

          if (!Number.isInteger(parsedId))
            throw new Error(
              `--${operation} needs a suggestion id or 'all', got ${JSON.stringify(id)}`,
            );

          const result =
            operation === "accept"
              ? tagSuggest.acceptSuggestion(conn, parsedId)
              : tagSuggest.rejectSuggestion(conn, parsedId);

          if (!result) {
            console.error(`error: suggestion ${parsedId} not found or not pending`);

            return 1;
          }

          json(result);

          return 0;
        }

        if (bool(args, "llm")) {
          json(
            await llm.classifySource(conn, source || "youtube", {
              limit,
              retry: bool(args, "all"),
              backend: text(args, "backend", "local"),
            }),
          );

          return 0;
        }

        const opts = { limit, retry: bool(args, "all"), dryRun: bool(args, "dry-run") };

        const result =
          source.toLowerCase() === "reddit"
            ? categorize.tagRedditSource(conn, opts)
            : ["firefox", "hackernews"].includes(source.toLowerCase())
              ? categorize.tagBrowserSource(conn, source.toLowerCase(), opts)
              : bool(args, "topics")
                ? categorize.tagYoutubeSource(conn, opts)
                : categorize.categorizeSource(conn, source, opts);

        json(await result);

        return 0;
      }

      case "enrich": {
        if (bool(args, "gallery-previews")) {
          const count = countTargets(conn, { retry: true, scope: "gallery_preview" });
          console.error(`${count} gallery item(s) need sized previews; querying archives...`);
          json(
            await recover(conn, {
              limit: number(args, "limit"),
              retry: true,
              scope: "gallery_preview",
              progress: (message) => console.error(message),
            }),
          );
        } else if (bool(args, "archives") || bool(args, "scores")) {
          const scope = bool(args, "scores") ? "all" : "removed";
          const count = countTargets(conn, { retry: bool(args, "all"), scope });
          console.error(
            `${count} reddit item(s) ${scope === "all" ? "to hydrate (score/content)" : "need recovery"}; querying archives...`,
          );
          json(
            await recover(conn, {
              limit: number(args, "limit"),
              retry: bool(args, "all"),
              scope,
              progress: (message) => console.error(message),
            }),
          );
        } else if (bool(args, "titles"))
          json(
            await recoverTitles(conn, {
              limit: number(args, "limit"),
              retry: bool(args, "all"),
              progress: (message) => console.error(message),
            }),
          );
        else {
          const allRows = bool(args, "all");

          if (text(args, "source"))
            json(
              await enrich.enrichSource(conn, text(args, "source") ?? "", {
                allRows,
                limit: number(args, "limit"),
              }),
            );
          else {
            const result = await enrich.enrichAll(conn, { allRows });

            json({
              selected: result.selected,
              updated: result.updated,
              by_source: result.bySource,
            });
          }
        }

        return 0;
      }

      case "reddit-hydrate-titles": {
        const backup = bool(args, "dry-run") ? undefined : backupDb(conn, "pre-titles");

        if (backup) console.error(`backed up DB -> ${backup}`);

        const result = bool(args, "network")
          ? await backfillTitlesNetwork(conn, {
              dryRun: bool(args, "dry-run"),
              limit: number(args, "limit"),
              progress: (message) => console.error(message),
            })
          : backfillTitlesLocal(conn, { dryRun: bool(args, "dry-run") });

        json(backup ? { ...result, backup } : result);

        return 0;
      }

      case "reddit-thumbnails": {
        const result = await backfillThumbnails(conn, {
          apply: bool(args, "apply"),
          limit: number(args, "limit"),
        });

        json(result);

        if (!bool(args, "apply"))
          console.error(
            `\n[dry run] ${result.eligible} item(s) could get a thumbnail from cached threads. Re-run with --apply to write (no network).`,
          );

        return 0;
      }

      case "reddit-hydrate": {
        if (text(args, "from")) {
          const result = await hydrateFromDir(conn, text(args, "from") ?? "", {
            limit: number(args, "limit"),
            includeOrphans: bool(args, "include-orphans"),
            overwrite: bool(args, "overwrite"),
            progress: (message) => console.error(message),
          });

          json(result);

          return result.errors === 0 ? 0 : 1;
        }

        if (bool(args, "batch")) {
          const scopeOnly = bool(args, "dry-run") || !bool(args, "yes");

          const result = await hydrateBatch(conn, {
            limit: number(args, "limit"),
            throttle: number(args, "throttle", 2),
            dryRun: scopeOnly,
            progress: (message) => console.error(message),
          });

          json(result);

          if (scopeOnly && !bool(args, "dry-run"))
            console.error(
              `\n[scope only] ${result.eligible} eligible; nothing fetched. Re-run with --yes to hydrate for real (hits Reddit at ~${number(args, "throttle", 2)}s/request).`,
            );

          return result.auth_error ? 1 : 0;
        }

        if (args._[0]) {
          const result = await hydrateOne(conn, args._[0]);
          json(result);

          return result.status === "hydrated" ? 0 : 1;
        }

        throw new Error("reddit-hydrate needs FULLNAME, --from, or --batch");
      }

      case "dedup": {
        if (bool(args, "clear")) json(dedup.clearFlags(conn));
        else if (bool(args, "resolve"))
          json(dedup.autoResolve(conn, { by: text(args, "by", "url") }));
        else {
          const result = dedup.flagDuplicates(conn, { by: text(args, "by", "url") });

          json(result);

          if (result.groups)
            console.error(
              `(flagged ${result.flagged} items in ${result.groups} possible-duplicate groups — \`dedup --resolve\` to auto-archive all-but-richest, or \`dedup --clear\`)`,
            );
        }

        return 0;
      }

      case "migrate-firefox-tabs": {
        const apply = bool(args, "apply");
        const result = firefoxYoutube.migrate(conn, { apply });

        json(result);

        if (!apply)
          console.error(
            `(dry run — ${result.dupes} dupes + ${result.orphans} orphans would become youtube items and ${result.dupes + result.orphans} firefox rows removed; re-run with --apply to commit. Run against a COPY of the DB first.)`,
          );

        return 0;
      }

      case "migrate-note-youtube": {
        const apply = bool(args, "apply");
        const result = noteYoutube.migrate(conn, { apply });

        json(result);

        if (!apply)
          console.error(
            `(dry run — ${result.candidates} candidate note→YouTube link(s): ${result.orphan} orphan (would create youtube rows) + ${result.companion} companion (would attach to existing youtube rows). Re-run with --apply to commit. Run against a COPY of the DB first.)`,
          );

        return 0;
      }

      case "migrate-rsm-threads":
        json(
          rsmThreads.migrate(conn, text(args, "from") ?? "", {
            allThreads: bool(args, "all-threads"),
          }),
        );

        return 0;
      case "consolidate": {
        const apply = bool(args, "apply");
        const undo = bool(args, "undo");

        const result = undo
          ? consolidate.unconsolidate(conn, { apply })
          : consolidate.migrate(conn, { apply });

        json(result);

        if (!apply) {
          if ("candidates" in result)
            console.error(
              `(dry run — would clear companions/unmark consolidated rows and delete promoted youtube rows across ${result.candidates} candidate item(s); re-run with --apply to commit. Run against a COPY of the DB first.)`,
            );
          else
            console.error(
              `(dry run — ${result.foldable} item(s) would fold into existing youtube rows; ${result.promoted} item(s) link to not-yet-saved YouTube videos and would be promoted into ${result.youtube_created} new youtube item(s); re-run with --apply to commit. Run against a COPY of the DB first.)`,
            );
        }

        return 0;
      }

      case "firefox-token": {
        if (!bool(args, "generate")) {
          const configured = firefoxTabs.tokenConfigured(conn);

          json({ configured });
          console.error(
            configured
              ? "A Firefox ingest token is configured. Re-run with --generate to rotate it."
              : "No Firefox ingest token is configured. Re-run with --generate to create one.",
          );

          return 0;
        }

        const token = firefoxTabs.generateToken(conn);

        json({ token });
        console.error(
          "Copy this token into the Firefox extension now; only its SHA-256 hash was stored.",
        );

        return 0;
      }

      case "reddit-sync": {
        if (bool(args, "enable-auto") || bool(args, "disable-auto")) {
          setAutosyncEnabled(conn, bool(args, "enable-auto"));
          json({
            autosync_enabled: isAutosyncEnabled(conn),
            note: "background thread starts on next app launch; the PWA-open path is live immediately",
          });

          return 0;
        }

        const full = bool(args, "full");
        const reconcile = bool(args, "reconcile");

        const requestedPages = number(args, "max-pages");

        const result = await syncReddit(conn, {
          maxPages: reconcile ? RECONCILE_MAX_PAGES : requestedPages || (full ? 50 : 3),
          full,
          stopOnKnown: !full && !reconcile,
          reconcile,
          reconcileDryRun: bool(args, "reconcile-dry-run"),
          progress: (message) => console.error(message),
        });

        json(result);

        return result.auth_error || result.network_error ? 1 : 0;
      }

      case "hn-sync": {
        const full = bool(args, "full");

        const requestedPages = number(args, "max-pages");

        const result = await syncHn(conn, {
          user: text(args, "user", "") ?? "",
          maxPages: requestedPages || (full ? 50 : 5),
          full,
          stopOnKnown: !full,
          throttle: number(args, "throttle", 1),
          progress: (message) => console.error(message),
        });

        json(result);

        return result.network_error ? 1 : 0;
      }

      case "reddit-unsave":
        return await runRedditUnsave(conn, args);
      case "reddit-oauth":
        return await runRedditOAuth(conn, args);
      case "resolve-redgifs":
        json(
          await redgifs.resolve(conn, {
            limit: number(args, "limit"),
            allowNetwork: bool(args, "redgifs-ok"),
            apply: bool(args, "apply"),
          }),
        );

        return 0;
      case "scan-media": {
        const result = await scanMedia(conn, {
          status: text(args, "status"),
          limit: number(args, "limit"),
          recheck: bool(args, "recheck"),
          apply: bool(args, "apply"),
          workers: number(args, "workers", 10),
          batch: number(args, "batch", 200),
          progress: (message) => console.error(message),
        });

        const manifest = join(dirname(config.dbPath()), "deleted-media-scan.json");
        writeFileSync(manifest, JSON.stringify(result, null, 2), "utf8");
        const { salvageable_items, ...summary } = result;
        json(summary);
        console.error(
          `manifest -> ${manifest}  (${salvageable_items.length} salvageable URL(s) recorded)`,
        );

        if (!bool(args, "apply"))
          console.error("(dry run — re-run with --apply to write media_status/tags)");

        return 0;
      }

      case "export": {
        const out = text(args, "out");

        if (!out) throw new Error("--out is required");

        const result = await exportModule.exportItems(conn, {
          out,
          format: text(args, "format", "csv") === "json" ? "json" : "csv",
          tags: values(args, "tag"),
          status: text(args, "status"),
          source: text(args, "source"),
          subreddit: text(args, "subreddit"),
        });

        console.log(`exported ${result.exported} item(s) -> ${result.path}`);

        return 0;
      }

      case "export-obsidian": {
        const vault = text(args, "vault");

        if (!vault) throw new Error("--vault is required");

        const result = await exportModule.exportObsidian(conn, {
          vault,
          status: text(args, "status", "keep"),
        });

        console.log(`exported ${result.exported} note(s) to ${result.vault}`);

        return 0;
      }

      case "suggest":
        json(
          await llm.suggestInbox(conn, {
            source: text(args, "source"),
            limit: number(args, "limit", 20),
          }),
        );

        return 0;
      case "promote": {
        const status = text(args, "status", "keep") ?? "keep";

        const result = await karakeep.promote(conn, {
          status,
          limit: number(args, "limit"),
          dryRun: bool(args, "dry-run"),
        });

        if (!result.configured) {
          console.log(
            `Karakeep not configured (set KARAKEEP_BASE_URL + KARAKEEP_API_KEY). ${result.candidates} item(s) with status=${status} are ready to push.`,
          );

          return 0;
        }

        json(result);

        return 0;
      }

      case "learn-triage": {
        const result = triageScore.learn(conn, {
          apply: bool(args, "apply"),
          minSupport: number(args, "min-support", 20),
          alpha: number(args, "alpha", 50),
          limit: number(args, "limit"),
        });

        json(result);

        if (!result.applied)
          console.error(
            `(dry run — model fitted on ${result.trained_on} rows (${result.processed} human-processed, prior ${Number.isInteger(result.prior) ? `${result.prior}.0` : result.prior}); ${result.scored} inbox item(s) would get triage_score; re-run with --apply to write. Run against a COPY of the DB first.)`,
          );

        return 0;
      }

      case "triage-drift": {
        const result = triageScore.driftReport(conn, {
          apply: bool(args, "apply"),
          minSupport: number(args, "min-support", 20),
          alpha: number(args, "alpha", 50),
          limit: number(args, "limit"),
          sinceProcessed: number(args, "since-processed"),
        });

        json(result);

        if (!result.applied) {
          if (result.has_previous && result.drift)
            console.error(
              `(dry run - drift_score ${result.drift.drift_score} across ${result.drift.rate_drift.shared} shared feature(s); ${result.new_decisions} new decision(s) since the comparison point. Re-run with --apply to refit, rescore inbox items, and persist.)`,
            );
          else
            console.error(
              "(dry run - no persisted triage model found; re-run with --apply to fit, score inbox items, and persist.)",
            );
        }

        return 0;
      }

      case "assist-auto-archive": {
        const source = text(args, "source", "reddit") ?? "reddit";

        const plan = triageScore.autoArchivePlan(conn, {
          minSkipRate: number(args, "min-skip-rate", 0.9),
          minSupport: number(args, "min-support", 2),
          source,
        });

        if (!plan.model_present) {
          json(plan);
          console.error(
            "(no persisted triage model — run `learn-triage --apply` first. Run against a COPY of the DB.)",
          );

          return 1;
        }

        if (!bool(args, "apply")) {
          json(plan);
          console.error(
            `(dry run — ${plan.total_actionable} inbox item(s) across ${plan.actionable.length} high-skip subreddit bucket(s) would archive; re-run with --apply to commit. Each bucket's wave is stamped metadata.decayed_at (surfaced as decayed_at in the apply output) and reverses via \`decay --undo\` scoped to that stamp's day — or inspect the decayed_at ids if multiple waves share a day.)`,
          );

          return 0;
        }

        const appliedBuckets = [];

        for (const bucket of plan.actionable) {
          if (bucket.inbox_count === 0) continue;

          const result = db.decay(conn, {
            subreddits: [bucket.subreddit],
            source,
            label: "auto-archive",
            apply: true,
          });

          appliedBuckets.push({
            subreddit: bucket.subreddit,
            skip_rate: bucket.skip_rate,
            n: bucket.n,
            result,
          });
        }

        json({ ...plan, applied: true, applied_buckets: appliedBuckets });

        return 0;
      }

      case "ocr": {
        const apply = bool(args, "apply");

        const result = await ocrModule.ocrAll(conn, {
          limit: number(args, "limit"),
          apply,
          force: bool(args, "force"),
          lang: text(args, "lang", "eng"),
          minConfidence: number(args, "min-confidence", 40),
          throttle: number(args, "throttle", 0),
        });

        json(result);

        if (!apply)
          console.error(
            `(dry run — ${result.items} item(s) with local images would be OCR'd; re-run with --apply)`,
          );
        else
          console.error(
            `ocr ok=${result.ocr_ok} empty=${result.empty} skipped=${result.skipped} failed=${result.failed}`,
          );

        return result.failed === 0 ? 0 : 1;
      }

      case "archive-media": {
        const scopes = (
          ["salvageable", "galleries", "images", "twitter", "videos"] as const
        ).filter((scope) => bool(args, scope));

        const apply = bool(args, "apply");

        const result = await mediaArchive.archiveMedia(conn, {
          scopes: scopes.length ? scopes : ["salvageable", "galleries"],
          limit: number(args, "limit"),
          apply,
          throttle: number(args, "throttle", 0.3),
          maxVideoBytes: number(args, "max-video-bytes", 512 * 1024 * 1024),
          videoTimeout: number(args, "video-timeout", 900),
          progress: (message) => console.error(message),
        });

        json(result);

        if (!apply)
          console.error(
            `(dry run — ${result.urls} URL(s) across ${result.items} item(s) would be fetched; re-run with --apply)`,
          );
        else
          console.error(
            `archived ${result.archived} blob(s) (${Math.floor(result.bytes / 1024 / 1024)} MB), ${result.failed} failed`,
          );

        return 0;
      }

      default:
        throw new Error(`unhandled command: ${command}`);
    }
  } finally {
    conn.close();
  }
}

export async function main(argv: string[] = Bun.argv.slice(2)): Promise<number> {
  config.loadEnv();
  const args = [...argv];

  if (args[0] === "--version" || args[0] === "-V") {
    console.log(`content_hoarder ${VERSION}`);

    return 0;
  }

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(help);

    return args.length === 0 ? 2 : 0;
  }

  const command = args.shift() ?? "";

  if (args.some((argument) => argument === "--help" || argument === "-h")) {
    if (command === "folder" || command === "tag") return printNestedCommandHelp(command, args);

    printCommandHelp(command);

    return 0;
  }

  if (
    command === "hn-sync" &&
    !args.some((argument) => argument === "--user" || argument.startsWith("--user="))
  ) {
    console.error(
      "usage: content_hoarder hn-sync [-h] --user USER [--max-pages MAX_PAGES]\n                               [--full] [--throttle THROTTLE]\ncontent_hoarder hn-sync: error: the following arguments are required: --user",
    );

    return 2;
  }

  if (
    command === "migrate-rsm-threads" &&
    !args.some((argument) => argument === "--from" || argument.startsWith("--from="))
  ) {
    console.error(
      "usage: content_hoarder migrate-rsm-threads [-h] --from RSM_APP_DB\n                                           [--all-threads]\ncontent_hoarder migrate-rsm-threads: error: the following arguments are required: --from",
    );

    return 2;
  }

  let parsed: CliArgs;

  try {
    parsed = parseCommandArgs(command, args);
  } catch (error) {
    if (command === "folder" || command === "tag")
      return printNestedParseError(
        command,
        args,
        error instanceof Error ? error : new Error(String(error)),
      );

    throw error;
  }

  return run(command, parsed);
}

if (import.meta.main) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
