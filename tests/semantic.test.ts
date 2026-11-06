import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as db from "../src/db.ts";
import { newItem } from "../src/models.ts";
import { setAiConsent } from "../src/assist/consent.ts";
import { withLibrary } from "../src/web/state.ts";
import { searchRoute } from "../src/web/handlers/search.ts";
import {
  ask,
  boundChunkTokens,
  chunkText,
  lexicalPassage,
  ragConsent,
  searchLexicalSources,
  searchVectorChunks,
  semanticStatus,
  setRagConsent,
  validateCitations,
  type Evidence,
} from "../src/semantic.ts";

const opened: Database[] = [];

afterEach(() => {
  for (const conn of opened.splice(0)) conn.close();
});

function library(): Database {
  const conn = new Database(":memory:");
  opened.push(conn);
  db.initDb(conn);
  semanticStatus(conn);

  return conn;
}

const embedding = Float32Array.from({ length: 384 }, (_, index) => (index === 0 ? 1 : 0));

function seed(
  conn: Database,
  id: string,
  metadata: Record<string, string | number | string[]> = {},
  status = "inbox",
): string {
  const item = newItem({
    source: "reddit",
    source_id: `t3_${id}`,
    title: `Reliable backups ${id}`,
    body: "Keep verified independent copies of important records.",
    metadata,
  });

  db.mergeUpsert(conn, item);
  conn.query("UPDATE items SET status=? WHERE fullname=?").run(status, item.fullname);
  conn
    .query("INSERT INTO semantic_docs(ref,hash,dirty) VALUES(?,?,0)")
    .run(item.fullname, "synthetic-test-only");

  const chunk = conn
    .query(
      "INSERT INTO semantic_chunks(ref,title,text,url,start_line,end_line) VALUES(?,?,?,'https://example.com/source',1,2)",
    )
    .run(item.fullname, item.title, item.body);

  conn
    .query("INSERT INTO semantic_vectors(rowid,embedding) VALUES(?,?)")
    .run(chunk.lastInsertRowid, embedding);

  return item.fullname;
}

test("native vectors and consent remain inside the selected library", async () => {
  const first = library(),
    second = library();

  const a = seed(first, "first"),
    b = seed(second, "second");

  expect(searchVectorChunks(first, embedding).map((row) => row.ref)).toEqual([a]);
  expect(searchVectorChunks(second, embedding).map((row) => row.ref)).toEqual([b]);
  setRagConsent(first, true);
  expect(ragConsent(second)).toBe(false);

  const response = await withLibrary(second, () =>
    searchRoute(new Request("http://localhost/api/semantic/status")),
  );

  expect(await response?.json()).toMatchObject({ indexed: 1, consent: false });
});

test("native ranking excludes ineligible source, status, tags, NSFW, snooze and consolidation before its limit", () => {
  const conn = library();
  const keep = seed(conn, "keep", { tags: ["backup"] });
  seed(conn, "adult", { tags: ["backup"], over_18: 1 });
  seed(conn, "sleep", { tags: ["backup"], snoozed_until: Math.floor(Date.now() / 1000) + 3600 });
  seed(conn, "merged", { tags: ["backup"], consolidated_into: keep });
  seed(conn, "archived", { tags: ["backup"] }, "archived");
  seed(conn, "untagged");

  const filters = {
    source: "reddit",
    status: "inbox",
    tags: ["backup"],
    hideNsfw: true,
    hideSnoozed: true,
  };

  expect(searchVectorChunks(conn, embedding, filters).map((row) => row.ref)).toEqual([keep]);
  expect(searchVectorChunks(conn, embedding, { ...filters, source: "youtube" })).toEqual([]);
  expect(
    searchVectorChunks(conn, embedding, {
      ...filters,
      exact: ["reliable backups"],
      exclude: ["keep"],
    }),
  ).toEqual([]);
  expect(searchVectorChunks(conn, embedding, { ...filters, exact: ["unmatched phrase"] })).toEqual(
    [],
  );
  expect(searchVectorChunks(conn, embedding, { ...filters, exclude: ["keep"] })).toEqual([]);
});

test("source edits, thread cache changes, deletion and replacement reject stale vectors", () => {
  const conn = library();
  const ref = seed(conn, "changing");
  conn.query("UPDATE items SET body='Recovered new content' WHERE fullname=?").run(ref);
  expect(searchVectorChunks(conn, embedding)).toEqual([]);
  expect(semanticStatus(conn).stale).toBe(1);
  conn.query("UPDATE semantic_docs SET dirty=0 WHERE ref=?").run(ref);
  db.setRedditThread(conn, ref, "[]");
  expect(searchVectorChunks(conn, embedding)).toEqual([]);
  conn.query("UPDATE semantic_docs SET dirty=0 WHERE ref=?").run(ref);
  conn.query("DELETE FROM items WHERE fullname=?").run(ref);
  expect(searchVectorChunks(conn, embedding)).toEqual([]);
  db.mergeUpsert(
    conn,
    newItem({ source: "reddit", source_id: "t3_changing", title: "Replacement" }),
  );
  expect(searchVectorChunks(conn, embedding)).toEqual([]);
});

test("old hint consent never authorizes full-text generation and offline blocks it", async () => {
  const conn = library();
  setAiConsent(conn, true);
  await expect(ask(conn, "What did I save?")).rejects.toThrow("Separate full-text RAG consent");
  const previous = process.env.CONTENT_HOARDER_OFFLINE;
  process.env.CONTENT_HOARDER_OFFLINE = "1";

  try {
    setRagConsent(conn, true);
    await expect(ask(conn, "What did I save?")).rejects.toThrow("Offline mode");

    const response = await withLibrary(conn, () =>
      searchRoute(
        new Request("http://localhost/api/semantic/ask", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: "What did I save?" }),
        }),
      ),
    );

    expect(response?.status).toBe(403);
  } finally {
    if (previous === undefined) delete process.env.CONTENT_HOARDER_OFFLINE;
    else process.env.CONTENT_HOARDER_OFFLINE = previous;
  }
});

test("citations must name actual supplied evidence and chunks preserve source spans", () => {
  const evidence: Evidence[] = [
    {
      id: "S1",
      source: "content-hoarder",
      ref: "reddit:t3_test",
      title: "Test",
      text: "Evidence",
      startLine: 1,
      endLine: 1,
      score: 1,
    },
  ];

  expect(validateCitations("Supported [S1]", evidence)).toEqual(["S1"]);
  expect(() => validateCitations("Invented [S2]", evidence)).toThrow();
  expect(() => validateCitations("No source", evidence)).toThrow();

  const chunks = chunkText(
    "# Heading\n\nParagraph one.\n\nParagraph two.",
    "https://example.com/thread/comment",
  );

  expect(chunks.map((chunk) => [chunk.startLine, chunk.endLine])).toEqual([
    [1, 1],
    [3, 3],
    [5, 5],
  ]);
  expect(chunks.every((chunk) => chunk.url.endsWith("/comment"))).toBe(true);
  expect(chunkText("x".repeat(4000)).every((chunk) => chunk.text.length <= 600)).toBe(true);
});

test("status and tag changes preserve vectors while current eligibility still applies", () => {
  const conn = library(),
    ref = seed(conn, "triage");

  conn
    .query("UPDATE items SET status='done',metadata=? WHERE fullname=?")
    .run(JSON.stringify({ tags: ["backup"] }), ref);
  expect(semanticStatus(conn)).toMatchObject({ indexed: 1, stale: 0 });
  expect(searchVectorChunks(conn, embedding, { status: "inbox" })).toEqual([]);
  expect(
    searchVectorChunks(conn, embedding, { status: "done", tags: ["backup"] }).map((row) => row.ref),
  ).toEqual([ref]);
});

test("lexical evidence selects the matching deep-body passage instead of the title", () => {
  const chunks = chunkText(
    "General title\n\nUnrelated introduction.\n\nChecksums detect corruption during backup verification.",
  );

  const passage = lexicalPassage(chunks, "backup verification");
  expect(passage?.text).toContain("Checksums detect corruption");
  expect(passage?.startLine).toBe(5);
  expect(lexicalPassage(chunks, "", ["backup verification"])?.text).toContain("Checksums");
});

test("token splitting preserves precise multiline spans and does not invent newlines", () => {
  const original = "A".repeat(180) + "\n" + "B".repeat(180) + "\n" + "C".repeat(180);
  const chunk = { text: original, startLine: 7, endLine: 9, url: "https://example.com/comment" };
  const split = boundChunkTokens(chunk, (text) => text.length);
  expect(split.every((part) => part.text.length <= 240)).toBe(true);

  for (const part of split) {
    const from = original.indexOf(part.text);
    expect(from).toBeGreaterThanOrEqual(0);
    expect(part.startLine).toBe(7 + (original.slice(0, from).match(/\n/g)?.length ?? 0));
    expect(part.endLine).toBe(part.startLine + (part.text.match(/\n/g)?.length ?? 0));
  }

  const longLine = chunkText("x".repeat(500));
  expect(longLine).toHaveLength(1);
  expect(longLine[0]?.text).toBe("x".repeat(500));
  expect(longLine[0]?.endLine).toBe(1);
});

test("native ranking limits distinct sources instead of letting a long thread monopolize results", () => {
  const conn = library();
  const long = seed(conn, "long");

  for (let index = 0; index < 120; index++) {
    const chunk = conn
      .query(
        "INSERT INTO semantic_chunks(ref,title,text,url,start_line,end_line) VALUES(?,?,?,'https://example.com/comment',1,1)",
      )
      .run(long, "Long thread", `Additional useful discussion passage ${index}`);

    conn
      .query("INSERT INTO semantic_vectors(rowid,embedding) VALUES(?,?)")
      .run(chunk.lastInsertRowid, embedding);
  }

  const short = seed(conn, "short");
  const matches = searchVectorChunks(conn, embedding);
  expect(matches.map((row) => row.ref)).toEqual([long, short]);
  expect(matches).toHaveLength(2);
});

test("comment phrases and exclusions constrain both native and lexical retrieval before ranking", () => {
  const conn = library();
  const ref = seed(conn, "comments");
  db.setRedditThread(conn, ref, "[]");
  conn.query("UPDATE semantic_docs SET dirty=0 WHERE ref=?").run(ref);

  const inserted = conn
    .query(
      "INSERT INTO semantic_chunks(ref,title,text,url,start_line,end_line) VALUES(?,?,?,'https://example.com/comment',1,1)",
    )
    .run(
      ref,
      "Thread comment",
      "A useful cached comment explains glacier checksum validation with independent verification.",
    );

  conn
    .query("INSERT INTO semantic_vectors(rowid,embedding) VALUES(?,?)")
    .run(inserted.lastInsertRowid, embedding);

  const exact = { status: "inbox", exact: ["glacier checksum"] };
  expect(searchVectorChunks(conn, embedding, exact).map((row) => row.ref)).toEqual([ref]);
  expect(searchLexicalSources(conn, "", exact).map((row) => row.fullname)).toEqual([ref]);
  expect(searchLexicalSources(conn, "glacier").map((row) => row.fullname)).toEqual([ref]);
  expect(db.searchItems(conn, "glacier")).toEqual([]);

  const excluded = { status: "inbox", exclude: ["glacier"] };
  expect(searchVectorChunks(conn, embedding, excluded)).toEqual([]);
  expect(searchLexicalSources(conn, "", excluded)).toEqual([]);
  expect(searchLexicalSources(conn, "backups", excluded)).toEqual([]);
  expect(searchVectorChunks(conn, embedding, { ...exact, exclude: ["validation"] })).toEqual([]);

  conn
    .query("UPDATE semantic_chunks SET text='Updated comment about archival storage' WHERE id=?")
    .run(inserted.lastInsertRowid);
  expect(searchLexicalSources(conn, "glacier")).toEqual([]);
  expect(searchLexicalSources(conn, "archival").map((row) => row.fullname)).toEqual([ref]);
  conn.query("UPDATE semantic_docs SET dirty=1 WHERE ref=?").run(ref);
  expect(searchLexicalSources(conn, "archival")).toEqual([]);
  expect(searchLexicalSources(conn, "backups", excluded)).toEqual([]);
  expect(searchVectorChunks(conn, embedding)).toEqual([]);
});
