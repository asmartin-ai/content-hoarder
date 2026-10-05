import * as z from "zod";
import type { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSearchText, parseMetadata, type Metadata, type RawItem } from "./models.ts";
import { pathFor, isValidId } from "./media_store.ts";

export const DEFAULT_MIN_CONFIDENCE = 40;

export const DEFAULT_LANG = "eng";

export const DEFAULT_MAX_CHARS = 20_000;

const MIN_IMAGE_SIDE = 80;

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;

const VIDEO_EXT = /\.(mp4|webm|mov|mkv)$/i;

export class OcrError extends Error {}

export type OcrEngineResult = {
  text: string;
  mean_confidence: number | null;
  engine: "tesseract";
  engine_version: string;
  skip_reason?: "too_small" | "low_confidence";
};

type TesseractTsvResult = { text: string; meanConfidence: number | null };

const archivedMediaSchema = z.record(z.string(), z.string());

export function parseTesseractTsv(tsv: string): TesseractTsvResult {
  const lines = tsv.trim().split(/\r?\n/);

  if (
    lines[0] !==
    "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext"
  ) {
    throw new OcrError("Tesseract returned malformed TSV output");
  }

  const words: string[] = [];
  const confidences: number[] = [];

  for (const line of lines.slice(1)) {
    const fields = line.split("\t");

    if (fields.length < 12 || fields[0] !== "5") continue;
    const text = fields[11]?.trim() ?? "";
    const confidence = Number(fields[10]);

    if (text) words.push(text);

    if (Number.isFinite(confidence) && confidence >= 0) confidences.push(confidence);
  }

  return {
    text: words.join(" ").trim(),
    meanConfidence: confidences.length
      ? confidences.reduce((a, b) => a + b, 0) / confidences.length
      : null,
  };
}

function run(binary: string, args: string[]): string {
  try {
    return execFileSync(binary, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (message.includes("ENOENT")) throw new OcrError(`${binary} executable not found on PATH`);
    throw new OcrError(`${binary} failed: ${message}`);
  }
}

export function tesseractAvailable(): boolean {
  try {
    run("tesseract", ["--version"]);

    return true;
  } catch {
    return false;
  }
}

export function defaultEngine(
  path: string,
  opts: { lang?: string; minConfidence?: number } = {},
): OcrEngineResult {
  const lang = opts.lang ?? DEFAULT_LANG;
  const minConfidence = opts.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  let dimensions: string;

  try {
    dimensions = run("magick", ["identify", "-format", "%w\t%h", `${path}[0]`]);
  } catch (error) {
    throw new OcrError(
      `Cannot inspect OCR image: ${error instanceof Error ? error.message : error}`,
    );
  }

  const width = Number(dimensions.trim().split("\t")[0]);
  const height = Number(dimensions.trim().split("\t")[1]);

  if (!Number.isFinite(width) || !Number.isFinite(height))
    throw new OcrError("ImageMagick returned invalid image dimensions");
  const version = run("tesseract", ["--version"]).split(/\r?\n/, 1)[0] ?? "tesseract";

  if (Math.min(width, height) < MIN_IMAGE_SIDE)
    return {
      text: "",
      mean_confidence: null,
      engine: "tesseract",
      engine_version: version,
      skip_reason: "too_small",
    };
  const tempDir = mkdtempSync(join(tmpdir(), "content-hoarder-ocr-"));
  const input = join(tempDir, "frame.png");

  try {
    run("magick", [`${path}[0]`, "-alpha", "remove", input]);
  } catch (error) {
    rmSync(tempDir, { recursive: true, force: true });
    throw new OcrError(
      `Cannot convert OCR image: ${error instanceof Error ? error.message : error}`,
    );
  }

  try {
    const tsv = run("tesseract", [input, "stdout", "-l", lang, "tsv"]);
    const parsed = parseTesseractTsv(tsv);

    if (parsed.meanConfidence !== null && parsed.meanConfidence < minConfidence) {
      return {
        text: "",
        mean_confidence: parsed.meanConfidence,
        engine: "tesseract",
        engine_version: version,
        skip_reason: "low_confidence",
      };
    }

    return {
      text: parsed.text,
      mean_confidence: parsed.meanConfidence,
      engine: "tesseract",
      engine_version: version,
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export function localImageBlobs(metadata: Metadata): Array<[string, string]> {
  const archived = archivedMediaSchema.safeParse(metadata.archived_media);

  if (!archived.success) return [];
  const out: Array<[string, string]> = [];
  const seen = new Set<string>();

  for (const [key, value] of Object.entries(archived.data)) {
    if (!value || seen.has(value) || VIDEO_EXT.test(value)) continue;

    if (!IMAGE_EXT.test(value) && !isValidId(value)) continue;
    const path = pathFor(value);

    if (!path || VIDEO_EXT.test(path) || !IMAGE_EXT.test(path)) continue;
    seen.add(value);
    out.push([key, value]);
  }

  return out;
}

export function needsOcr(metadata: Metadata, force = false): boolean {
  return force || !(metadata.ocr_at && (metadata.ocr_text || metadata.ocr_empty));
}

function joinedText(parts: string[], maxChars: number): string {
  return parts.filter(Boolean).join("\n").trim().slice(0, maxChars).trimEnd();
}

export type OcrItemResult = {
  fullname: string;
  status: "missing" | "no_local_image" | "skipped" | "ok" | "empty" | "would_ocr" | "would_empty";
  blobs?: number;
  chars?: number;
  text_preview?: string;
  applied?: boolean;
};

export type OcrOptions = {
  apply?: boolean;
  force?: boolean;
  lang?: string;
  minConfidence?: number;
  maxChars?: number;
};

export type OcrBatchResult = {
  items: number;
  ocr_ok: number;
  empty: number;
  skipped: number;
  no_local_image: number;
  failed: number;
  applied: boolean;
  fail_reasons: Record<string, number>;
};

export function ocrItem(conn: Database, fullname: string, options: OcrOptions = {}): OcrItemResult {
  const item = conn.query<RawItem, [string]>("SELECT * FROM items WHERE fullname=?").get(fullname);

  if (!item) return { fullname, status: "missing" };
  const metadata = parseMetadata(item.metadata);
  const blobs = localImageBlobs(metadata);

  if (!blobs.length) return { fullname, status: "no_local_image", blobs: 0 };

  if (!needsOcr(metadata, options.force))
    return { fullname, status: "skipped", blobs: blobs.length };
  const texts: string[] = [];

  const details: Record<
    string,
    { blob: string; chars: number; mean_confidence: number | null; lang: string }
  > = {};

  let engineVersion: string | undefined;

  for (const [key, blob] of blobs) {
    const path = pathFor(blob);

    if (!path) continue;

    const result = defaultEngine(path, {
      lang: options.lang,
      minConfidence: options.minConfidence,
    });

    engineVersion = result.engine_version || engineVersion;
    const text = result.text.trim();

    if (text) texts.push(text);
    details[key] = {
      blob,
      chars: text.length,
      mean_confidence: result.mean_confidence,
      lang: options.lang ?? DEFAULT_LANG,
    };
  }

  const text = joinedText(texts, options.maxChars ?? DEFAULT_MAX_CHARS);

  const result: OcrItemResult = {
    fullname,
    status: text ? "ok" : "empty",
    blobs: blobs.length,
    chars: text.length,
    text_preview: text.slice(0, 80),
  };

  if (!options.apply) {
    result.status = text ? "would_ocr" : "would_empty";

    return result;
  }

  const current = parseMetadata(item.metadata);
  current.ocr_at = Math.floor(Date.now() / 1000);
  current.ocr_engine = "tesseract";
  current.ocr_details = details;

  if (engineVersion) current.ocr_engine_version = engineVersion;

  if (text) {
    current.ocr_text = text;
    delete current.ocr_empty;
  } else {
    delete current.ocr_text;
    current.ocr_empty = true;
  }

  const serialized = JSON.stringify(current);
  conn
    .query("UPDATE items SET metadata=?, search_text=? WHERE fullname=?")
    .run(serialized, buildSearchText(item, current), fullname);
  result.status = text ? "ok" : "empty";
  result.applied = true;

  return result;
}

export async function ocrAll(
  conn: Database,
  options: OcrOptions & { limit?: number; throttle?: number } = {},
): Promise<OcrBatchResult> {
  const result: OcrBatchResult = {
    items: 0,
    ocr_ok: 0,
    empty: 0,
    skipped: 0,
    no_local_image: 0,
    failed: 0,
    applied: options.apply ?? false,
    fail_reasons: {},
  };

  const rows = conn
    .query<{ fullname: string; metadata: string }, []>(
      "SELECT fullname, metadata FROM items WHERE metadata LIKE '%archived_media%' ORDER BY last_seen_utc DESC",
    )
    .all();

  let budget = options.limit;

  for (const row of rows) {
    if (budget !== undefined && budget <= 0) break;
    const metadata = parseMetadata(row.metadata);

    if (!localImageBlobs(metadata).length) continue;

    if (!needsOcr(metadata, options.force)) {
      result.skipped++;
      continue;
    }

    result.items++;

    if (budget !== undefined) budget--;

    try {
      const one = ocrItem(conn, row.fullname, options);

      if (one.status === "ok" || one.status === "would_ocr") result.ocr_ok++;
      else if (one.status === "empty" || one.status === "would_empty") result.empty++;
      else if (one.status === "skipped") result.skipped++;
      else if (one.status === "no_local_image") result.no_local_image++;
      else {
        result.failed++;
        result.fail_reasons[one.status] = (result.fail_reasons[one.status] ?? 0) + 1;
      }

      if (options.throttle && options.apply) await Bun.sleep(options.throttle * 1000);
    } catch (error) {
      result.failed++;

      const reason =
        error instanceof OcrError
          ? "ocr_unavailable"
          : error instanceof Error
            ? error.name
            : "error";

      result.fail_reasons[reason] = (result.fail_reasons[reason] ?? 0) + 1;

      if (error instanceof OcrError) break;
    }
  }

  return result;
}
