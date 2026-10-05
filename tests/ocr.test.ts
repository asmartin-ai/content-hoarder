import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ocrAll, ocrItem, parseTesseractTsv } from "../src/ocr.ts";
import * as db from "../src/db.ts";
import { newItem } from "../src/models.ts";

const TSV =
  "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n5\t1\t1\t1\t1\t1\t0\t0\t10\t10\t90\tHELLO\n5\t1\t1\t1\t1\t2\t11\t0\t10\t10\t70\tWORLD\n";

test("Tesseract TSV parser returns word text and word-level mean confidence", () => {
  expect(parseTesseractTsv(TSV)).toEqual({ text: "HELLO WORLD", meanConfidence: 80 });
  expect(
    parseTesseractTsv(
      "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n",
    ),
  ).toEqual({ text: "", meanConfidence: null });
});

test("OCR item and batch preserve read-only behavior without eligible local image", async () => {
  const conn = new Database(":memory:");
  db.initDb(conn);

  const item = newItem({
    source: "reddit",
    source_id: "ocr-offline",
    title: "saved",
    metadata: { archived_media: { "https://example.test/no.png": "missing.png" } },
  });

  db.mergeUpsert(conn, item);
  const before = db.getItem(conn, item.fullname)?.metadata;
  expect(ocrItem(conn, item.fullname)).toEqual({
    fullname: item.fullname,
    status: "no_local_image",
    blobs: 0,
  });
  expect((await ocrAll(conn, { apply: true })).items).toBe(0);
  expect(db.getItem(conn, item.fullname)?.metadata).toBe(before);
  conn.close();
});
