import { NSFW_TAGS } from "./models.ts";

export interface ParsedQuery {
  text: string;

  source: string | string[] | null;
  kind: string | string[] | null;
  status: string | string[] | null;
  subreddit: string | string[] | null;
  author: string | string[] | null;

  tags: string[];
  tagsAll: boolean;

  isSaved: number | null;
  nsfw: boolean;
  decayed: boolean;
  swept: boolean;
  snoozed: boolean;
  openInFirefox: boolean;
  deleted: boolean;
  has: string | string[] | null;
  ocr: boolean;

  before: number | null;
  after: number | null;

  scoreMin: number | null;
  scoreMax: number | null;

  exclude: string[];
  exact: string[];
}

const _OP_RE = /^(?<neg>-?)(?<key>\w+):(?<val>.+)$/;

const _R_SUB_RE = /^r\/(\w+)$/;

const _U_USER_RE = /^u\/([\w-]+)$/;

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

  return [n, n];
}

export function parse(q: string): ParsedQuery {
  const textTerms: string[] = [];
  const exclude: string[] = [];
  const exact: string[] = [];

  const sourceGroups: string[][] = [];
  const kindGroups: string[][] = [];
  const statusGroups: string[][] = [];
  const subredditGroups: string[][] = [];
  const authorGroups: string[][] = [];
  const tagsGroups: string[][] = [];
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

    textTerms.push(t);
  }

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

export function nsfwTags(): readonly string[] {
  return NSFW_TAGS;
}
