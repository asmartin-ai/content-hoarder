import { expect, test, vi } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as db from "../src/db.ts";
import { handleBulkStatus } from "../src/web/handlers/items.ts";
import { withLibrary } from "../src/web/state.ts";
import { newItem, parseMetadata, MetadataSchema, type Metadata } from "../src/models.ts";
import {
  MODEL_SETTING_KEY,
  autoLearnNow,
  extractFeatures,
  fit,
  learn,
  loadModel,
  noteDecision,
  outcomeBuckets,
  scoreItem,
  type ScoreModel,
} from "../src/triage_score.ts";

interface SeedSpec {
  id: string;
  status?: string;
  source?: string;
  kind?: string;
  subreddit?: string;
  channel?: string;
  created_utc?: number;
  saved_utc?: number;
  metadata?: Metadata;
}

function seed(database: Database, specs: SeedSpec[]): void {
  for (const spec of specs)
    db.mergeUpsert(
      database,
      newItem({
        source: spec.source ?? "reddit",
        source_id: spec.id,
        kind: spec.kind ?? "post",
        title: `item ${spec.id}`,
        status: spec.status ?? "inbox",
        created_utc: spec.created_utc ?? 1_600_000_000,
        saved_utc: spec.saved_utc,
        metadata: MetadataSchema.parse({
          subreddit: spec.subreddit,
          channel: spec.channel,
          ...spec.metadata,
        }),
      }),
    );
}

function seeds(
  prefix: string,
  count: number,
  status: string,
  extra: Partial<SeedSpec>,
): SeedSpec[] {
  return Array.from({ length: count }, (_, index) => ({
    ...extra,
    id: `${prefix}${index}`,
    status,
  }));
}

function withDb(body: (database: Database) => void): void {
  const database = new Database(":memory:");

  try {
    db.initDb(database);
    body(database);
  } finally {
    database.close();
  }
}

const metadataOf = (database: Database, fullname: string): Metadata =>
  parseMetadata(db.getItem(database, fullname)?.metadata);

const storedSearchText = (database: Database, fullname: string): string =>
  (
    database.query("SELECT search_text FROM items WHERE fullname=?").get(fullname) as
      | { search_text: string }
      | undefined
  )?.search_text ?? "";

test("fit counts decided outcomes per feature and excludes decayed items", () => {
  withDb((database) => {
    seed(database, [
      ...seeds("keep", 10, "keep", { subreddit: "kept" }),
      ...seeds("done", 1, "done", { subreddit: "kept" }),
      ...seeds("arch", 2, "archived", { subreddit: "kept" }),
      ...seeds("other", 4, "archived", { subreddit: "dropped" }),
      ...seeds("one", 1, "keep", { subreddit: "dropped" }),
      ...seeds("decay", 3, "keep", { subreddit: "kept", metadata: { decayed_at: 1 } }),
    ]);

    const model = fit(database, { minSupport: 2 });

    expect(model.outcomes?.["sub:kept"]).toEqual([13, 11, 2]);
    expect(model.outcomes?.["sub:dropped"]).toEqual([5, 1, 4]);
    expect(model.outcomes?.["sub:decayed"]).toBeUndefined();
    expect(model.outcomes?.["sk:reddit/post"]).toEqual([18, 12, 6]);
    expect(model.keep_prior).toBe(0.65);

    const buckets = outcomeBuckets(model, { minDecided: 8 });

    expect(buckets.find(({ feature }) => feature === "sub:kept")).toMatchObject({
      decided: 13,
      kept: 11,
      archived: 2,
      keep_rate: 0.846154,
      letgo_rate: 0.153846,
    });
    expect(buckets.map(({ feature }) => feature)).not.toContain("sub:dropped");
  });
});

test("outcomeBuckets sorts by let-go rate then decided count", () => {
  const model: ScoreModel = {
    version: 1,
    fitted_utc: 0,
    trained_on: 0,
    processed: 0,
    prior: 0,
    alpha: 50,
    min_support: 20,
    features: {},
    outcomes: {
      "sub:small": [10, 1, 9],
      "sub:large": [20, 2, 18],
      "sub:sharp": [20, 1, 19],
      "sub:thin": [3, 0, 3],
    },
  };

  expect(outcomeBuckets(model).map(({ feature }) => feature)).toEqual([
    "sub:sharp",
    "sub:large",
    "sub:small",
  ]);
});

test("extractFeatures records a valid AI verdict", () => {
  const base = { source: "reddit", kind: "post", created_utc: 1_600_000_000 };

  expect(
    extractFeatures(base, parseMetadata({ llm: { verdict: "keep", reason: "useful", tags: [] } })),
  ).toContain("ai:keep");
  expect(
    extractFeatures(base, parseMetadata({ llm: { verdict: "skip", reason: "noise", tags: [] } })),
  ).toContain("ai:skip");
  expect(
    extractFeatures(base, parseMetadata(JSON.stringify({ llm: { verdict: "keep" } }))),
  ).not.toContain("ai:keep");
  expect(
    extractFeatures(
      base,
      parseMetadata(JSON.stringify({ llm: { verdict: "maybe", reason: "?" } })),
    ),
  ).not.toEqual(expect.arrayContaining(["ai:keep", "ai:skip"]));
});

test("loadModel still parses a persisted model without outcomes", () => {
  withDb((database) => {
    db.setSetting(
      database,
      MODEL_SETTING_KEY,
      JSON.stringify({
        version: 1,
        fitted_utc: 1,
        trained_on: 3,
        processed: 2,
        prior: 0.5,
        alpha: 50,
        min_support: 20,
        features: {},
      }),
    );

    const model = loadModel(database);

    expect(model).not.toBeNull();
    expect(model?.version).toBe(1);
    expect(model?.outcomes).toBeUndefined();
  });
});

test("apply ranks a likely-kept subreddit above a likely-let-go one", () => {
  withDb((database) => {
    seed(database, [
      ...seeds("keep", 10, "keep", { subreddit: "kept" }),
      ...seeds("drop", 10, "archived", { subreddit: "dropped" }),
      { id: "in_kept", subreddit: "kept" },
      { id: "in_dropped", subreddit: "dropped" },
    ]);

    learn(database, { apply: true });

    const kept = metadataOf(database, "reddit:in_kept");
    const dropped = metadataOf(database, "reddit:in_dropped");

    expect(kept.triage_score).toBeNumber();
    expect(kept.triage_score).toBeGreaterThan(dropped.triage_score ?? 0);
    expect(kept.triage_score).toBeGreaterThanOrEqual(0);
    expect(kept.triage_score).toBeLessThanOrEqual(1);
    expect(kept.triage_why).toContain("r/kept: kept or finished 10 of 10");
    expect(dropped.triage_why).toContain("r/dropped: let go 10 of 10");
  });
});

test("apply derives p_keep from the single most specific outcome bucket", () => {
  withDb((database) => {
    seed(database, [
      ...seeds("alpha_keep", 9, "keep", { subreddit: "alpha" }),
      ...seeds("alpha_arch", 1, "archived", { subreddit: "alpha" }),
      ...seeds("beta_arch", 10, "archived", { subreddit: "beta" }),
      { id: "alpha_inbox", subreddit: "alpha" },
    ]);

    learn(database, { apply: true });

    const model = loadModel(database);

    expect(model).not.toBeNull();
    expect(model?.keep_prior).toBe(0.454545);

    const item = db.getItem(database, "reddit:alpha_inbox");

    expect(item).not.toBeNull();

    const [processedScore] = scoreItem(
      model!,
      extractFeatures(item!, parseMetadata(item!.metadata)),
    );

    const expectedKeep = (9 + model!.alpha * (model!.keep_prior ?? 0.5)) / (10 + model!.alpha);
    const expected = Number(Math.sqrt(processedScore * expectedKeep).toFixed(4));

    expect(metadataOf(database, "reddit:alpha_inbox").triage_score).toBe(expected);
    expect(metadataOf(database, "reddit:alpha_inbox").triage_why).toContain(
      "r/alpha: kept or finished 9 of 10",
    );
  });
});

test("thin buckets leave p_keep at the global base rate", () => {
  withDb((database) => {
    seed(database, [
      ...seeds("thin_keep", 4, "keep", { subreddit: "thin" }),
      ...seeds("thin_arch", 1, "archived", { subreddit: "thin" }),
      { id: "thin_inbox", subreddit: "thin" },
    ]);

    learn(database, { apply: true });

    const model = loadModel(database);

    expect(model).not.toBeNull();
    expect(model?.keep_prior).toBe(0.714286);

    const item = db.getItem(database, "reddit:thin_inbox");

    expect(item).not.toBeNull();

    const [processedScore] = scoreItem(
      model!,
      extractFeatures(item!, parseMetadata(item!.metadata)),
    );

    const expected = Number(Math.sqrt(processedScore * (model!.keep_prior ?? 0.5)).toFixed(4));

    expect(metadataOf(database, "reddit:thin_inbox").triage_score).toBe(expected);
  });
});

test("apply writes a history hint and removes it when evidence weakens", () => {
  withDb((database) => {
    seed(database, [
      ...seeds("pics_arch", 9, "archived", { subreddit: "pics" }),
      ...seeds("pics_keep", 1, "keep", { subreddit: "pics" }),
      ...seeds("neutral", 10, "keep", { subreddit: "neutral" }),
      { id: "pics_inbox", subreddit: "pics" },
    ]);

    learn(database, { apply: true });

    expect(metadataOf(database, "reddit:pics_inbox").triage_hint).toEqual({
      verdict: "skip",
      reason: "You let go 9 of 10 from r/pics",
    });

    seed(database, seeds("pics_more", 4, "keep", { subreddit: "pics" }));
    learn(database, { apply: true });

    expect(metadataOf(database, "reddit:pics_inbox").triage_hint).toBeUndefined();
  });
});

test("apply names a channel in plain words", () => {
  withDb((database) => {
    seed(database, [
      ...seeds("ver", 9, "keep", {
        source: "youtube",
        kind: "video",
        channel: "Veritasium",
      }),
      ...seeds("ver_drop", 1, "archived", {
        source: "youtube",
        kind: "video",
        channel: "Veritasium",
      }),
      ...seeds("other", 10, "archived", {
        source: "youtube",
        kind: "video",
        channel: "Other Channel",
      }),
      { id: "ver_inbox", source: "youtube", kind: "video", channel: "Veritasium" },
    ]);

    learn(database, { apply: true });

    expect(metadataOf(database, "youtube:ver_inbox").triage_hint).toEqual({
      verdict: "keep",
      reason: "You kept or finished 9 of 10 from Veritasium",
    });
  });
});

test("apply names creation age without claiming save time", () => {
  const created = Math.floor(Date.now() / 1000) - 3 * 365 * 86_400;
  const saved = Math.floor(Date.now() / 1000) - 86_400;

  withDb((database) => {
    seed(database, [
      ...seeds("thin_kind", 3, "archived", {
        source: "youtube",
        kind: "video",
        created_utc: created,
        saved_utc: saved,
      }),
      ...seeds("other_kind", 5, "archived", { created_utc: created, saved_utc: saved }),
      {
        id: "age_inbox",
        source: "youtube",
        kind: "video",
        created_utc: created,
        saved_utc: saved,
      },
    ]);

    learn(database, { apply: true });

    expect(metadataOf(database, "youtube:age_inbox").triage_hint).toEqual({
      verdict: "skip",
      reason: "You let go 8 of 8 items from over 2 years ago",
    });
  });
});

test("age hints fall back to first_seen when creation time is missing", () => {
  withDb((database) => {
    seed(database, [
      ...seeds("fallback_yt", 4, "archived", {
        source: "youtube",
        kind: "video",
        created_utc: 0,
      }),
      ...seeds("fallback_post", 4, "archived", { created_utc: 0 }),
      { id: "fallback_inbox", source: "youtube", kind: "video", created_utc: 0 },
    ]);

    learn(database, { apply: true });

    expect(metadataOf(database, "youtube:fallback_inbox").triage_hint).toEqual({
      verdict: "skip",
      reason: "You let go 8 of 8 items from the last month",
    });
  });
});

test("apply names the AI verdict that was counted", () => {
  withDb((database) => {
    seed(database, [
      ...seeds("ai_keep", 10, "keep", {
        metadata: { llm: { verdict: "keep", reason: "useful", tags: [] } },
      }),
      ...seeds("ai_skip", 10, "archived", {
        metadata: { llm: { verdict: "skip", reason: "noise", tags: [] } },
      }),
      {
        id: "ai_keep_inbox",
        metadata: { llm: { verdict: "keep", reason: "useful", tags: [] } },
      },
      {
        id: "ai_skip_inbox",
        metadata: { llm: { verdict: "skip", reason: "noise", tags: [] } },
      },
    ]);

    learn(database, { apply: true });

    expect(metadataOf(database, "reddit:ai_keep_inbox").triage_why).toContain(
      "items the AI suggested keeping: kept or finished 10 of 10",
    );
    expect(metadataOf(database, "reddit:ai_skip_inbox").triage_why).toContain(
      "items the AI suggested letting go: let go 10 of 10",
    );
  });
});

test("apply leaves search_text untouched", () => {
  withDb((database) => {
    seed(database, [{ id: "search_inbox", subreddit: "pics", metadata: { tags: ["zzz"] } }]);

    const before = storedSearchText(database, "reddit:search_inbox");

    learn(database, { apply: true });

    expect(storedSearchText(database, "reddit:search_inbox")).toBe(before);
    expect(metadataOf(database, "reddit:search_inbox").triage_score).toBeNumber();
  });
});

test("apply re-reads each chunk so interleaved metadata writes survive", () => {
  withDb((database) => {
    seed(database, seeds("chunk", 520, "inbox", { subreddit: "pics" }));
    database.exec(`
      CREATE TRIGGER mark_late AFTER UPDATE OF metadata ON items
      WHEN json_extract(NEW.metadata, '$.triage_score') IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM settings WHERE key='late_marked')
      BEGIN
        INSERT INTO settings(key,value) VALUES('late_marked','1');
        UPDATE items SET metadata=json_set(metadata,'$.late_marker',1)
          WHERE fullname='reddit:chunk519';
      END
    `);

    learn(database, { apply: true });

    const late = metadataOf(database, "reddit:chunk519");

    expect(late.late_marker).toBe(1);
    expect(late.triage_score).toBeNumber();
  });
});

test("autoLearnNow applies only once the threshold is reached", async () => {
  const previous = process.env.TRIAGE_AUTO_LEARN_EVERY;
  const database = new Database(":memory:");

  vi.useFakeTimers();
  process.env.TRIAGE_AUTO_LEARN_EVERY = "2";

  try {
    db.initDb(database);
    seed(database, [
      ...seeds("now_keep", 4, "keep", { subreddit: "kept" }),
      ...seeds("now_drop", 4, "archived", { subreddit: "dropped" }),
      { id: "now_inbox", subreddit: "kept" },
    ]);

    expect(await autoLearnNow(database)).toBeNull();

    noteDecision(database);

    expect(await autoLearnNow(database)).toBeNull();

    noteDecision(database);

    const result = await autoLearnNow(database);

    expect(result?.applied).toBe(true);
    expect(loadModel(database)).not.toBeNull();
    expect(db.getSetting(database, "auto_learn_pending", "0")).toBe("0");
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();

    if (previous === undefined) delete process.env.TRIAGE_AUTO_LEARN_EVERY;
    else process.env.TRIAGE_AUTO_LEARN_EVERY = previous;
    database.close();
  }
});

test("noteDecision learns once the threshold is reached, not before", () => {
  const previous = process.env.TRIAGE_AUTO_LEARN_EVERY;
  const database = new Database(":memory:");

  vi.useFakeTimers();
  process.env.TRIAGE_AUTO_LEARN_EVERY = "3";

  try {
    db.initDb(database);
    seed(database, [
      ...seeds("auto_keep", 5, "keep", { subreddit: "kept" }),
      ...seeds("auto_drop", 5, "archived", { subreddit: "dropped" }),
      { id: "auto_inbox", subreddit: "kept" },
    ]);

    noteDecision(database);
    noteDecision(database);
    vi.runAllTimers();

    expect(loadModel(database)).toBeNull();
    expect(db.getSetting(database, "auto_learn_pending", "0")).toBe("2");

    noteDecision(database);
    vi.runAllTimers();

    expect(loadModel(database)).not.toBeNull();
    expect(db.getSetting(database, "auto_learn_pending", "0")).toBe("0");
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();

    if (previous === undefined) delete process.env.TRIAGE_AUTO_LEARN_EVERY;
    else process.env.TRIAGE_AUTO_LEARN_EVERY = previous;
    database.close();
  }
});

test("file-backed auto learn runs one worker per path and keeps newer increments", async () => {
  const directory = mkdtempSync(join(tmpdir(), "content-hoarder-triage-worker-"));
  const path = join(directory, "library.db");
  const previous = process.env.TRIAGE_AUTO_LEARN_EVERY;

  process.env.TRIAGE_AUTO_LEARN_EVERY = "3";

  const first = db.connect(path);
  const second = db.connect(path);

  try {
    seed(first, [
      ...seeds("worker_keep", 5, "keep", { subreddit: "kept" }),
      ...seeds("worker_drop", 5, "archived", { subreddit: "dropped" }),
      { id: "worker_inbox", subreddit: "kept" },
    ]);

    noteDecision(first);
    noteDecision(first);
    noteDecision(second);

    const running = autoLearnNow(first);

    noteDecision(second);

    const [a, b] = await Promise.all([running, autoLearnNow(second)]);

    expect(a).toBe(b);
    expect(a?.applied).toBe(true);
    expect(loadModel(second)).not.toBeNull();
    expect(metadataOf(second, "reddit:worker_inbox").triage_score).toBeNumber();
    expect(db.getSetting(second, "auto_learn_pending", "0")).toBe("1");

    await Promise.resolve();

    expect(await autoLearnNow(second)).toBeNull();
  } finally {
    if (previous === undefined) delete process.env.TRIAGE_AUTO_LEARN_EVERY;
    else process.env.TRIAGE_AUTO_LEARN_EVERY = previous;
    first.close();
    second.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an all-archive history keeps scores above zero and varied", () => {
  withDb((database) => {
    seed(database, [
      ...seeds("all_arch", 24, "archived", { subreddit: "letgo" }),
      ...seeds("all_fresh", 20, "inbox", { subreddit: "fresh" }),
      { id: "all_inbox_known", subreddit: "letgo" },
      { id: "all_inbox_unknown", subreddit: "fresh" },
    ]);

    const model = fit(database);

    expect(model.keep_prior).toBe(0.038462);

    learn(database, { apply: true });

    const known = metadataOf(database, "reddit:all_inbox_known").triage_score ?? 0;
    const unknown = metadataOf(database, "reddit:all_inbox_unknown").triage_score ?? 0;

    expect(unknown).toBeGreaterThan(0);
    expect(known).toBeGreaterThan(unknown);
  });
});

test("an all-keep history keeps scores below one", () => {
  withDb((database) => {
    seed(database, [
      ...seeds("all_keep", 12, "keep", { subreddit: "kept" }),
      { id: "all_keep_inbox", subreddit: "kept" },
    ]);

    const model = fit(database);

    expect(model.keep_prior).toBe(0.928571);

    learn(database, { apply: true });

    const score = metadataOf(database, "reddit:all_keep_inbox").triage_score ?? 0;

    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });
});

test("bulk decisions clear hint outcomes and count changed rows toward auto learning", async () => {
  const previous = process.env.TRIAGE_AUTO_LEARN_EVERY;
  const database = new Database(":memory:");

  process.env.TRIAGE_AUTO_LEARN_EVERY = "100";

  try {
    db.initDb(database);
    seed(database, [
      { id: "bulk_a" },
      { id: "bulk_b" },
      { id: "bulk_c" },
      { id: "bulk_unchanged" },
    ]);

    for (const id of ["bulk_a", "bulk_b", "bulk_c"])
      db.setStatus(database, `reddit:${id}`, "keep", { hint: { verdict: "keep", by: "ai" } });

    db.setStatus(database, "reddit:bulk_unchanged", "archived", {
      hint: { verdict: "skip", by: "ai" },
    });

    const response = await withLibrary(database, () =>
      handleBulkStatus(
        new Request("http://local/bulk/status", {
          method: "POST",
          body: JSON.stringify({
            fullnames: ["reddit:bulk_a", "reddit:bulk_b", "reddit:bulk_c", "reddit:bulk_unchanged"],
            status: "archived",
          }),
        }),
      ),
    );

    expect(await response.json()).toEqual({ updated: 3 });

    for (const id of ["bulk_a", "bulk_b", "bulk_c"]) {
      expect(metadataOf(database, `reddit:${id}`).hint_outcome).toBeUndefined();
      expect(db.getItem(database, `reddit:${id}`)?.status).toBe("archived");
    }

    expect(metadataOf(database, "reddit:bulk_unchanged").hint_outcome).toMatchObject({
      verdict: "skip",
    });
    expect(db.hintAgreement(database).shown).toBe(1);
    expect(db.getSetting(database, "auto_learn_pending", "0")).toBe("3");
  } finally {
    if (previous === undefined) delete process.env.TRIAGE_AUTO_LEARN_EVERY;
    else process.env.TRIAGE_AUTO_LEARN_EVERY = previous;
    database.close();
  }
});

test("bulk returns to inbox do not count toward auto learning", async () => {
  const previous = process.env.TRIAGE_AUTO_LEARN_EVERY;
  const database = new Database(":memory:");

  process.env.TRIAGE_AUTO_LEARN_EVERY = "100";

  try {
    db.initDb(database);
    seed(database, [
      { id: "bulk_inbox_a", status: "keep" },
      { id: "bulk_inbox_b", status: "archived" },
    ]);

    await withLibrary(database, () =>
      handleBulkStatus(
        new Request("http://local/bulk/status", {
          method: "POST",
          body: JSON.stringify({
            fullnames: ["reddit:bulk_inbox_a", "reddit:bulk_inbox_b"],
            status: "inbox",
          }),
        }),
      ),
    );

    expect(db.getSetting(database, "auto_learn_pending", "0")).toBe("0");
  } finally {
    if (previous === undefined) delete process.env.TRIAGE_AUTO_LEARN_EVERY;
    else process.env.TRIAGE_AUTO_LEARN_EVERY = previous;
    database.close();
  }
});

test("an unexpired claim from another process blocks auto learning", async () => {
  const previous = process.env.TRIAGE_AUTO_LEARN_EVERY;
  const database = new Database(":memory:");

  process.env.TRIAGE_AUTO_LEARN_EVERY = "2";
  vi.useFakeTimers();

  try {
    db.initDb(database);
    seed(database, [
      ...seeds("claim_keep", 5, "keep", { subreddit: "kept" }),
      ...seeds("claim_drop", 5, "archived", { subreddit: "dropped" }),
      { id: "claim_inbox", subreddit: "kept" },
    ]);

    noteDecision(database);
    noteDecision(database);

    db.setSetting(
      database,
      "auto_learn_claim",
      JSON.stringify({ token: "other", until: Date.now() + 600_000 }),
    );

    expect(await autoLearnNow(database)).toBeNull();
    expect(loadModel(database)).toBeNull();
    expect(db.getSetting(database, "auto_learn_pending", "0")).toBe("2");

    db.setSetting(
      database,
      "auto_learn_claim",
      JSON.stringify({ token: "other", until: Date.now() - 1 }),
    );

    const result = await autoLearnNow(database);

    expect(result?.applied).toBe(true);
    expect(db.getSetting(database, "auto_learn_pending", "0")).toBe("0");
    expect(db.getSetting(database, "auto_learn_claim")).toBeNull();
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();

    if (previous === undefined) delete process.env.TRIAGE_AUTO_LEARN_EVERY;
    else process.env.TRIAGE_AUTO_LEARN_EVERY = previous;
    database.close();
  }
});

test("two connections racing the auto-learn claim run exactly one learn", async () => {
  const directory = mkdtempSync(join(tmpdir(), "content-hoarder-triage-claim-"));
  const previous = process.env.TRIAGE_AUTO_LEARN_EVERY;

  process.env.TRIAGE_AUTO_LEARN_EVERY = "3";
  vi.useFakeTimers();

  const first = db.connect(join(directory, "library.db"));
  const second = db.connect(`${directory}/./library.db`);

  try {
    seed(first, [
      ...seeds("race_keep", 5, "keep", { subreddit: "kept" }),
      ...seeds("race_drop", 5, "archived", { subreddit: "dropped" }),
      { id: "race_inbox", subreddit: "kept" },
    ]);

    noteDecision(first);
    noteDecision(first);
    noteDecision(second);

    const [a, b] = await Promise.all([autoLearnNow(first), autoLearnNow(second)]);
    const learned = [a, b].filter((result) => result !== null);

    expect(learned).toHaveLength(1);
    expect(learned[0]?.applied).toBe(true);
    expect(loadModel(second)).not.toBeNull();
    expect(db.getSetting(second, "auto_learn_pending", "0")).toBe("0");
    expect(db.getSetting(second, "auto_learn_claim")).toBeNull();
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();

    if (previous === undefined) delete process.env.TRIAGE_AUTO_LEARN_EVERY;
    else process.env.TRIAGE_AUTO_LEARN_EVERY = previous;
    first.close();
    second.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
