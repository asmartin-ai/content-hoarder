import type { Database } from "bun:sqlite";
import { mergeUpsert, getItem, withTransaction } from "./db.ts";
import {
  buildSearchText,
  newItem,
  parseMetadata,
  VALID_STATUSES,
  type ItemCore,
  type ItemStatus,
  type Metadata,
  type RawItem,
} from "./models.ts";
import { youtubeId } from "./connectors/firefox.ts";

export const PROMOTE_MARKER = "consolidate";

const VIDEO_MARKER = /\s*\[video\]/gi;

interface Candidate {
  fullname: string;
  source: string;
  source_id: string;
  kind: string;
  url: string;
  title: string;
  status: ItemStatus;
  processed_utc: number | null;
  vid: string;
  matched_url: string;
  youtube_fullname: string;
  metadata: Metadata;
}

interface CandidatePlan {
  foldable: Candidate[];
  skipped_no_youtube: Candidate[];
}

type Companion = NonNullable<Metadata["companions"]>[number];

export function companionRecord(
  row: Pick<ItemCore, "source" | "source_id" | "kind" | "fullname" | "url">,
  metadata: Metadata,
): Companion {
  const record: Companion = {
    source: row.source || "",
    kind: row.kind || "item",
    fullname: row.fullname || "",
  };

  const permalink = String(metadata.permalink ?? "").trim();

  if (permalink) record.permalink = permalink;
  else if (row.source === "hackernews") {
    const sid = String(row.source_id ?? "").trim();
    record.url = sid ? `https://news.ycombinator.com/item?id=${sid}` : row.url || "";
  } else record.url = row.url || "";

  return record;
}

export function appendCompanion(metadata: Metadata, companion: Companion): boolean {
  const companions = Array.isArray(metadata.companions) ? metadata.companions : [];

  if (companions.some((entry) => entry.fullname === companion.fullname)) {
    metadata.companions = companions;

    return false;
  }

  metadata.companions = [...companions, companion];

  return true;
}

function candidateUrls(url: string, metadata: Metadata): string[] {
  const outlinks = metadata.outlinks;

  const candidates = [
    url,
    ...(Array.isArray(outlinks) ? outlinks : outlinks ? [outlinks] : []),
  ].filter(Boolean);

  return [...new Set(candidates)];
}

function youtubeMatch(url: string, metadata: Metadata): [string, string] {
  for (const candidate of candidateUrls(url, metadata)) {
    const videoId = youtubeId(candidate);

    if (videoId) return [videoId, candidate];
  }

  return ["", ""];
}

function candidates(db: Database): CandidatePlan {
  const youtubeIds = new Set(
    db
      .query<{ source_id: string }, []>("SELECT source_id FROM items WHERE source='youtube'")
      .all()
      .map((row) => row.source_id),
  );

  const foldable: Candidate[] = [];
  const skipped: Candidate[] = [];

  const rows = db
    .query<
      {
        fullname: string;
        source: string;
        source_id: string;
        kind: string;
        url: string;
        title: string;
        status: string;
        processed_utc: number | null;
        metadata: string;
      },
      []
    >(
      "SELECT fullname,source,source_id,kind,url,title,status,processed_utc,metadata FROM items WHERE source<>'youtube' AND url<>'' ORDER BY fullname",
    )
    .all();

  for (const row of rows) {
    const metadata = parseMetadata(row.metadata);
    const [vid, matchedUrl] = youtubeMatch(row.url || "", metadata);

    if (!vid) continue;
    const youtubeFullname = `youtube:${vid}`;

    if (metadata.consolidated_into === youtubeFullname) continue;

    const entry: Candidate = {
      ...row,
      status: VALID_STATUSES.find((status) => status === row.status) ?? "inbox",
      vid,
      matched_url: matchedUrl,
      youtube_fullname: youtubeFullname,
      metadata,
    };

    (youtubeIds.has(vid) ? foldable : skipped).push(entry);
  }

  return { foldable, skipped_no_youtube: skipped };
}

function promoteItem(record: Candidate): RawItem {
  const title = (record.title || "").replace(VIDEO_MARKER, "").trim();

  const raw = newItem({
    source: "youtube",
    source_id: record.vid,
    kind: "video",
    title,
    url: `https://youtu.be/${record.vid}`,
    status: record.status,
    metadata: {
      thumbnail: `https://i.ytimg.com/vi/${record.vid}/hqdefault.jpg`,
      title_source: "companion",
      promoted_by: PROMOTE_MARKER,
    },
  });

  return { ...raw, processed_utc: record.processed_utc };
}

function updateMetadata(db: Database, item: ItemCore, metadata: Metadata): void {
  db.query("UPDATE items SET metadata=?,search_text=? WHERE fullname=?").run(
    JSON.stringify(metadata),
    buildSearchText(item, metadata),
    item.fullname,
  );
}

function foldOne(
  db: Database,
  record: Candidate,
  result: { companions_added: number; companions_marked: number },
): void {
  const youtubeItem = getItem(db, record.youtube_fullname);
  const companionItem = getItem(db, record.fullname);

  if (!youtubeItem || !companionItem) return;
  const youtubeMetadata = parseMetadata(youtubeItem.metadata);
  const companionMetadata = parseMetadata(companionItem.metadata);
  const companion = companionRecord(companionItem, companionMetadata);

  if (appendCompanion(youtubeMetadata, companion)) {
    updateMetadata(db, youtubeItem, youtubeMetadata);
    result.companions_added++;
  }

  if (companionMetadata.consolidated_into !== record.youtube_fullname) {
    companionMetadata.consolidated_into = record.youtube_fullname;
    updateMetadata(db, companionItem, companionMetadata);
    result.companions_marked++;
  }
}

export function migrate(db: Database, opts: { apply?: boolean } = {}) {
  const planResult = candidates(db);
  const promotable = planResult.skipped_no_youtube;

  const result = {
    foldable: planResult.foldable.length,
    promoted: promotable.length,
    youtube_created: new Set(promotable.map((record) => record.vid)).size,
    companions_added: 0,
    companions_marked: 0,
    applied: opts.apply ?? false,
    sample_foldable: planResult.foldable.slice(0, 5).map(({ fullname }) => fullname),
    sample_promoted: promotable.slice(0, 5).map(({ fullname }) => fullname),
  };

  if (!opts.apply) return result;
  withTransaction(db, () => {
    let created = 0;

    for (const record of promotable)
      if (mergeUpsert(db, promoteItem(record)) === "inserted") created++;

    for (const record of [...planResult.foldable, ...promotable]) foldOne(db, record, result);
    result.youtube_created = created;
  });

  return result;
}

export function unconsolidate(db: Database, opts: { apply?: boolean } = {}) {
  // SAFETY: This query selects only the fullname column from the items table.
  const rows = db
    .query(
      "SELECT fullname FROM items WHERE metadata LIKE '%consolidated_into%' OR metadata LIKE '%companions%' OR metadata LIKE '%promoted_by%'",
    )
    .all() as Array<{ fullname: string }>;

  const result = {
    candidates: rows.length,
    youtube_companions_cleared: 0,
    companions_unmarked: 0,
    promoted_rows_deleted: 0,
    applied: opts.apply ?? false,
    sample: rows.slice(0, 5).map(({ fullname }) => fullname),
  };

  if (!opts.apply) return result;
  withTransaction(db, () => {
    for (const { fullname } of rows) {
      const item = getItem(db, fullname);

      if (!item) continue;
      const metadata = parseMetadata(item.metadata);

      if (item.source === "youtube" && metadata.promoted_by === PROMOTE_MARKER) {
        db.query("DELETE FROM items WHERE fullname=?").run(fullname);
        result.promoted_rows_deleted++;
        continue;
      }

      let changed = false;

      if (metadata.companions) {
        delete metadata.companions;

        if (item.source === "youtube") result.youtube_companions_cleared++;
        changed = true;
      }

      if (metadata.consolidated_into) {
        delete metadata.consolidated_into;
        result.companions_unmarked++;
        changed = true;
      }

      if (changed) updateMetadata(db, item, metadata);
    }
  });

  return result;
}
