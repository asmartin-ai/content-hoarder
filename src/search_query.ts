/**
 * Search-bar operator parsing.
 *
 * Mirrors the Python parser token-for-token: unknown operators and
 * malformed known operators degrade to free-text tokens (they are not
 * dropped and do not error).
 */

import { NSFW_TAGS } from "./models.ts";

export interface ParsedQuery {
  text: string;

  source: string | string[] | null;
  kind: string | string[] | null;
  status: string | string[] | null;
  subreddit: string | string[] | null;
  author: string | string[] | null;

  tags: string[];
  // When true: tags are AND-ed (one required-membership check per tag).
  // When false: tags are OR-ed (any tag matches).
  tagsAll: boolean;

  isSaved: number | null; // 1/0 (SQLite-friendly)
  nsfw: boolean;
  decayed: boolean; // is:decayed — carries a decay-wave stamp (db.decay)
  swept: boolean; // is:swept — decayed in the labeled initial backfill pass
  snoozed: boolean; // is:snoozed — currently hidden by metadata.snoozed_until
  openInFirefox: boolean; // is:firefox-tab — metadata.open_in_firefox (incl. promoted YT tabs)
  deleted: boolean; // is:deleted — metadata.media_status='gone' (durable SSOT; the `deleted` tag is fragile)
  has: string | string[] | null; // has:video|image|gallery — metadata.media_type facet
  ocr: boolean; // is:ocr — items carrying non-empty metadata.ocr_text

  before: number | null; // unix seconds (UTC)
  after: number | null;

  scoreMin: number | null;
  scoreMax: number | null;

  exclude: string[]; // -term tokens
  exact: string[]; // "quoted phrases"
}

const _OP_RE = /^(?<neg>-?)(?<key>\w+):(?<val>.+)$/;

const _R_SUB_RE = /^r\/(\w+)$/;

// Reddit usernames are [A-Za-z0-9_-]; anchored so a bare `u/<name>`
// token is the author-operator shorthand but a reddit profile URL
// token is NOT captured.
const _U_USER_RE = /^u\/([\w-]+)$/;

/**
 * Split on whitespace, respecting double-quoted phrases.
 *
 * Returns `[token, quoted]` where `quoted=true` means the token came
 * from inside a balanced pair of double quotes.
 */
function tokenize(q: string): Array<[string, boolean]> {
  const s = q || "";
  const out: Array<[string, boolean]> = [];
  let i = 0;
  const n = s.length;

  while (i < n) {
    while (i < n && /\s/.test(s[i]!)) i += 1;

    if (i >= n) break;

    if (s[i] === '"') {
      let j = i + 1;

      while (j < n && s[j] !== '"') j += 1;

      if (j < n && s[j] === '"') {
        out.push([s.slice(i + 1, j), true]);
        i = j + 1;
        continue;
      }
      // Unbalanced quote -> degrade to a normal token (keep the quote).
    }

    let j = i;

    while (j < n && !/\s/.test(s[j]!)) j += 1;
    out.push([s.slice(i, j), false]);
    i = j;
  }

  return out;
}

function parseYyyymmdd(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);

  if (!m) return null;

  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));

  if (Number.isNaN(dt.getTime())) return null;

  return Math.floor(dt.getTime() / 1000);
}

function dedupePreserveOrder(xs: string[]): string[] {
  const out: string[] = [];

  for (const x of xs) {
    if (x && !out.includes(x)) out.push(x);
  }

  return out;
}

/** Inclusive `(min, max)` bounds for `score:`, or `null` on parse failure. */
function parseScore(value: string): [number | null, number | null] | null {
  const s = (value || "").trim();

  if (!s) return null;

  let op = "=";
  let num = s;

  for (const cand of [">=", "<=", ">", "<", "="]) {
    if (s.startsWith(cand)) {
      op = cand;
      num = s.slice(cand.length).trim();
      break;
    }
  }

  const n = Number.parseInt(num, 10);

  if (Number.isNaN(n)) return null;

  if (op === ">") return [n + 1, null];

  if (op === ">=") return [n, null];

  if (op === "<") return [null, n - 1];

  if (op === "<=") return [null, n];

  // '=' or no explicit op
  return [n, n];
}

/**
 * Parse a query string into structured operators + leftover free text.
 *
 * Unknown operators (unknown `key:value`) and malformed known
 * operators degrade to free-text tokens (they are not dropped and do
 * not error).
 */
export function parse(q: string): ParsedQuery {
  const textTerms: string[] = [];
  const exclude: string[] = [];
  const exact: string[] = [];

  const sourceGroups: string[][] = [];
  const kindGroups: string[][] = [];
  const statusGroups: string[][] = [];
  const subredditGroups: string[][] = [];
  const authorGroups: string[][] = [];
  const tagsGroups: string[][] = []; // each token's group; later collapsed
  let isSaved: number | null = null;
  let nsfw = false;
  let decayed = false;
  let swept = false;
  let snoozed = false;
  let openInFirefox = false;
  let deleted = false;
  let ocr = false;
  const hasGroups: string[][] = [];
  let before: number | null = null;
  let after: number | null = null;
  let scoreMin: number | null = null;
  let scoreMax: number | null = null;

  for (const [tok, quoted] of tokenize(q)) {
    const t = (tok || "").trim();

    if (!t) continue;

    if (quoted) {
      const phrase = t.trim();

      if (phrase) exact.push(phrase);
      continue;
    }

    if (t.startsWith("-") && t.length > 1 && !t.includes(":")) {
      exclude.push(t.slice(1));
      continue;
    }

    const m = _OP_RE.exec(t);

    if (!m) {
      const rSub = _R_SUB_RE.exec(t);

      if (rSub) {
        subredditGroups.push([rSub[1]!]);
        continue;
      }

      const uUser = _U_USER_RE.exec(t);

      if (uUser) {
        authorGroups.push([uUser[1]!]);
        continue;
      }

      textTerms.push(t);
      continue;
    }

    if (m.groups?.neg === "-") {
      // Operator negation isn't in-scope yet; degrade to free text.
      textTerms.push(t);
      continue;
    }

    const key = (m.groups?.key ?? "").trim().toLowerCase();
    const val = (m.groups?.val ?? "").trim();

    if (["source", "kind", "status", "subreddit", "author"].includes(key)) {
      if (!val) {
        textTerms.push(t);
        continue;
      }

      const parts = val
        .split(/[,|]/)
        .values()
        .map((part) => part.trim())
        .filter((part) => part.length > 0)
        .toArray();

      if (!parts.length) {
        textTerms.push(t);
        continue;
      }

      // source/kind/status are stored canonical-lowercase, so normalize the
      // typed value (e.g. `source:YouTube` -> `youtube`) or it would
      // silently match nothing. subreddit/author are left as-typed
      // (searchItems matches them COLLATE NOCASE).
      if (key === "source") {
        sourceGroups.push(parts.map((p) => p.toLowerCase()));
      } else if (key === "kind") {
        kindGroups.push(parts.map((p) => p.toLowerCase()));
      } else if (key === "status") {
        statusGroups.push(parts.map((p) => p.toLowerCase()));
      } else if (key === "subreddit") {
        subredditGroups.push(parts);
      } else {
        authorGroups.push(parts);
      }

      continue;
    }

    if (key === "tag") {
      const parts = val
        .split(/[,|]/)
        .values()
        .map((part) => part.trim())
        .filter((part) => part.length > 0)
        .toArray();

      if (!parts.length) {
        textTerms.push(t);
        continue;
      }

      tagsGroups.push(parts);
      continue;
    }

    if (key === "is") {
      const v = val.toLowerCase();

      if (v === "saved") {
        isSaved = 1;
        continue;
      }

      if (v === "unsaved") {
        isSaved = 0;
        continue;
      }

      if (v === "nsfw") {
        nsfw = true;
        continue;
      }

      if (v === "decayed") {
        decayed = true;
        continue;
      }

      if (v === "swept") {
        swept = true;
        continue;
      }

      if (v === "snoozed") {
        snoozed = true;
        continue;
      }

      if (v === "firefox-tab" || v === "firefoxtab") {
        openInFirefox = true;
        continue;
      }

      if (v === "deleted") {
        deleted = true;
        continue;
      }

      if (v === "ocr") {
        ocr = true;
        continue;
      }

      textTerms.push(t);
      continue;
    }

    if (key === "has") {
      // Media facet over metadata.media_type (populated by the reddit
      // connector + archive refinement). Unknown values degrade to free
      // text like any operator.
      const parts = val
        .split(/[,|]/)
        .values()
        .map((part) => part.trim().toLowerCase())
        .filter((part) => part.length > 0)
        .toArray();

      if (!parts.length) {
        textTerms.push(t);
        continue;
      }

      if (parts.every((p) => p === "video" || p === "image" || p === "gallery")) {
        hasGroups.push(parts);
        continue;
      }

      textTerms.push(t);
      continue;
    }

    if (key === "before" || key === "after") {
      const ts = parseYyyymmdd(val);

      if (ts === null) {
        textTerms.push(t);
        continue;
      }

      if (key === "before") before = ts;
      else after = ts;
      continue;
    }

    if (key === "score") {
      const bounds = parseScore(val);

      if (bounds === null) {
        textTerms.push(t);
        continue;
      }

      [scoreMin, scoreMax] = bounds;
      continue;
    }

    // Unknown operator -> free text
    textTerms.push(t);
  }

  // Collapse per-key groups for source/kind/status/subreddit/has.
  // Empty → None, single value → str, multiple → deduped list.
  const collapse = (groups: string[][]): string | string[] | null => {
    if (!groups.length) return null;
    const flat = dedupePreserveOrder(groups.flat());

    if (!flat.length) return null;

    if (flat.length === 1) return flat[0]!;

    return flat;
  };

  const source = collapse(sourceGroups);
  const kind = collapse(kindGroups);
  const status = collapse(statusGroups);
  const subreddit = collapse(subredditGroups);
  const author = collapse(authorGroups);
  const has = collapse(hasGroups);

  // Collapse tag groups into the simple API shape.
  //
  // Supported forms (per docs/search-operators-spec.md):
  // - repeated tag:foo tag:bar => AND (tagsAll=true)
  // - tag:foo,bar or tag:foo|bar => OR within that token
  //
  // Mixed AND+OR grouping (e.g. tag:a,b tag:c) is intentionally not
  // represented by this v1 shape; we degrade to a global OR when any
  // OR-group is present.
  let tagsAll = false;
  let tags: string[] = [];

  if (tagsGroups.length) {
    const hasOr = tagsGroups.some((g) => g.length > 1);

    if (hasOr) {
      tagsAll = false;
      tags = dedupePreserveOrder(tagsGroups.flat());
    } else {
      tagsAll = tagsGroups.length > 1;
      tags = dedupePreserveOrder(tagsGroups.flatMap((group) => (group.length ? [group[0]!] : [])));
    }
  }

  return {
    text: textTerms.join(" ").trim(),
    source,
    kind,
    status,
    subreddit,
    author,
    tags,
    tagsAll,
    isSaved,
    nsfw,
    decayed,
    swept,
    snoozed,
    openInFirefox,
    deleted,
    ocr,
    has,
    before,
    after,
    scoreMin,
    scoreMax,
    exclude: dedupePreserveOrder(
      exclude
        .values()
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
        .toArray(),
    ),
    exact: dedupePreserveOrder(
      exact
        .values()
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
        .toArray(),
    ),
  };
}

/** Expose the NSFW tag vocabulary for callers/tests. */
export function nsfwTags(): readonly string[] {
  return NSFW_TAGS;
}
