import type { Database } from "bun:sqlite";
import { getItem, mergeUpsert, withTransaction, writeItemMetadata } from "./db.ts";
import { appendCompanion, companionRecord } from "./consolidate.ts";
import { newItem, parseMetadata, VALID_STATUSES, type Metadata, type RawItem } from "./models.ts";
import { youtubeId } from "./connectors/firefox.ts";

export const NOTE_PROMOTE_MARKER = "note_youtube";

const URL_PATTERN = /https?:\/\/\S+/gi;

export function candidateUrls(text: string): string[] {
  const urls: string[] = [];

  for (const raw of text.matchAll(URL_PATTERN)) {
    const url = raw[0].replace(/[\])>}."',;:!?]+$/g, "");

    if (url && !urls.includes(url)) urls.push(url);
  }

  return urls;
}

export function noteYoutubeIds(item: {
  body?: string;
  url?: string;
  metadata?: Metadata;
}): string[] {
  const ids: string[] = [];

  const add = (url: string) => {
    const id = youtubeId(url);

    if (id && !ids.includes(id)) ids.push(id);
  };

  for (const url of candidateUrls(item.body ?? "")) add(url);

  if (item.url) add(item.url);

  for (const url of item.metadata?.urls ?? []) add(String(url));

  return ids;
}

function promotedTargets(metadata: Metadata): string[] {
  const value = metadata.promoted_to;

  if (Array.isArray(value))
    return [...new Set(value.map((entry) => String(entry).trim()).filter(Boolean))];

  if (value?.trim()) return [value.trim()];

  return [];
}

function addPromotionTarget(metadata: Metadata, target: string): boolean {
  const current = promotedTargets(metadata);

  if (current.includes(target)) return false;
  current.push(target);
  metadata.promoted_to = current.length === 1 ? current[0]! : current;
  metadata.promoted_to_by = NOTE_PROMOTE_MARKER;

  return true;
}

interface NotePlan {
  fullname: string;
  vid: string;
  youtube_fullname: string;
  source: string;
  kind: string;
}

interface NotePlanResult {
  orphan: NotePlan[];
  companion: NotePlan[];
}

export function plan(db: Database): NotePlanResult {
  const youtubeIds = new Set(
    db
      .query<{ source_id: string }, []>("SELECT source_id FROM items WHERE source='youtube'")
      .all()
      .map(({ source_id }) => source_id),
  );

  const orphan: NotePlan[] = [];
  const companion: NotePlan[] = [];

  const rows = db
    .query<
      {
        fullname: string;
        source: string;
        source_id: string;
        kind: string;
        title: string;
        body: string;
        url: string;
        status: string;
        processed_utc: number | null;
        metadata: string;
      },
      []
    >(
      "SELECT fullname,source,source_id,kind,title,body,url,status,processed_utc,metadata FROM items WHERE source IN ('keep','obsidian') ORDER BY fullname",
    )
    .all();

  for (const row of rows) {
    const ids = noteYoutubeIds({
      body: row.body,
      url: row.url,
      metadata: parseMetadata(row.metadata),
    });

    if (ids.length !== 1) continue;
    const vid = ids[0];

    if (!vid) continue;

    const entry: NotePlan = {
      fullname: row.fullname,
      vid,
      youtube_fullname: `youtube:${vid}`,
      source: row.source || "",
      kind: row.kind || "note",
    };

    (youtubeIds.has(vid) ? companion : orphan).push(entry);
  }

  return { orphan, companion };
}

function promoteFromNote(note: RawItem, vid: string): RawItem {
  const status = VALID_STATUSES.find((valid) => valid === note.status) ?? "inbox";

  const raw = newItem({
    source: "youtube",
    source_id: vid,
    kind: "video",
    title: String(note.title || "").trim(),
    url: `https://youtu.be/${vid}`,
    status,
    metadata: {
      thumbnail: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
      title_source: "note",
      promoted_by: NOTE_PROMOTE_MARKER,
    },
  });

  return { ...raw, processed_utc: note.processed_utc };
}

export function migrate(db: Database, opts: { apply?: boolean } = {}) {
  const classified = plan(db);
  const candidates = [...classified.orphan, ...classified.companion];

  const result = {
    candidates: candidates.length,
    orphan: classified.orphan.length,
    companion: classified.companion.length,
    promoted: 0,
    attached: 0,
    already_done: 0,
    applied: opts.apply ?? false,
  };

  if (!opts.apply) return result;
  withTransaction(db, () => {
    for (const candidate of candidates) {
      const note = getItem(db, candidate.fullname);

      if (!note) continue;
      const noteMetadata = parseMetadata(note.metadata);

      if (promotedTargets(noteMetadata).includes(candidate.youtube_fullname)) {
        result.already_done++;
        continue;
      }

      let youtube = getItem(db, candidate.youtube_fullname);

      if (!youtube) {
        const noteItem: RawItem = { ...note, metadata: JSON.stringify(noteMetadata) };
        mergeUpsert(db, promoteFromNote(noteItem, candidate.vid));
        result.promoted++;
        youtube = getItem(db, candidate.youtube_fullname);
      }

      if (!youtube) continue;
      const youtubeMetadata = parseMetadata(youtube.metadata);

      if (appendCompanion(youtubeMetadata, companionRecord(note, noteMetadata))) {
        writeItemMetadata(db, youtube, youtubeMetadata);
        result.attached++;
      }

      if (addPromotionTarget(noteMetadata, candidate.youtube_fullname))
        writeItemMetadata(db, note, noteMetadata);
    }
  });

  return result;
}
