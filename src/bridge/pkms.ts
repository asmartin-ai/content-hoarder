import { z } from "zod";
import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import * as config from "../config.ts";
import { HttpError, request } from "../_http.ts";
import { parseMetadata, type Item, type Metadata, type PromotionReceipt } from "../models.ts";

const SAVED_PREFIX = "saved ✓ ";

const ALREADY_SAVED_PREFIX = "already saved ✓ ";

export interface CaptureEnvelope {
  text: string;
  source_account_id: string;
  raw_ref: string;
  context: { device: string; app: "content-hoarder" };
  ch_item_id: string;
  ch_origin_ref: string;
  ch_captured_at: string;
}

export interface PromoteResult {
  status: "replay" | "promoted" | "failed";
  promoted: boolean;
  response: string;
  receipt: PromotionReceipt;
  error?: string;
}

function idSlug(fullname: string): string {
  return createHash("sha1").update(fullname, "utf8").digest("hex").slice(0, 10);
}

function iso(timestamp: number): string {
  return new Date(timestamp * 1000).toISOString().replace(".000Z", "Z");
}

function summary(item: Item): string {
  const metadata = parseMetadata(item.metadata);

  for (const key of ["summary", "description", "selftext", "text"] as const) {
    const value = z.string().catch("").parse(metadata[key]);

    if (value.trim()) return value.trim();
  }

  return item.body.trim();
}

export function buildCapture(item: Item, device = "desktop"): CaptureEnvelope {
  const fullname = item.fullname;
  const title = item.title.trim();
  const url = item.url.trim();
  const text = [title, summary(item), url].filter(Boolean).join("\n\n");
  const captured = Math.trunc(item.first_seen_utc || item.saved_utc || Date.now() / 1000);

  return {
    text,
    source_account_id: `acct_content_hoarder_${item.source || "unknown"}`,
    raw_ref: url || `content-hoarder:fullname:${fullname}`,
    context: { device, app: "content-hoarder" },
    ch_item_id: `ext_ch_${idSlug(fullname)}`,
    ch_origin_ref: `content-hoarder:fullname:${fullname}`,
    ch_captured_at: iso(captured),
  };
}

export function isConfigured(): boolean {
  return Boolean(config.get("PKMS_CAPTURE_URL") && config.get("PKMS_CAPTURE_TOKEN"));
}

export async function deliver(envelope: CaptureEnvelope): Promise<string> {
  const base = config.get("PKMS_CAPTURE_URL").replace(/\/+$/, "");

  const [, , raw] = await request(`${base}/capture?source=content-hoarder`, {
    method: "POST",
    data: JSON.stringify(envelope),
    timeout: 15,
    headers: {
      "X-Capture-Token": config.get("PKMS_CAPTURE_TOKEN"),
      "Content-Type": "application/json",
      "User-Agent": config.get("USER_AGENT"),
    },
  });

  return new TextDecoder().decode(raw).trim();
}

function noteName(response: string): string {
  return response.includes("✓") ? (response.split("✓", 2)[1]?.trim() ?? "") : "";
}

function makeReceipt(
  fullname: string,
  status: "promoted" | "failed",
  attemptedAt: number,
  response: string,
): PromotionReceipt {
  const delivered = noteName(response);

  return {
    id: `receipt_ch_${idSlug(fullname)}_promote`,
    result: status === "promoted" ? "executed" : "failed",
    occurred_at: iso(attemptedAt),
    human_summary:
      status === "promoted"
        ? `Promoted to PKMS vault/inbox${delivered ? ` (${delivered})` : ""}.`
        : "Promote failed; no PKMS write.",
  };
}

function persistReceipt(
  database: Database,
  item: Item,
  status: "promoted" | "failed",
  attemptedAt: number,
  opts: { response?: string; error?: string } = {},
): PromotionReceipt {
  const metadata: Metadata = { ...parseMetadata(item.metadata) };
  const receipt = makeReceipt(item.fullname, status, attemptedAt, opts.response ?? "");

  const promotion: NonNullable<Metadata["promotion"]> = {
    status,
    attempted_at: attemptedAt,
    transport: "http_post_capture",
    receipt,
  };

  if (opts.response !== undefined) {
    promotion.response = opts.response;
    promotion.delivery_ref = noteName(opts.response);
  }

  if (opts.error !== undefined) promotion.error = opts.error;

  metadata.promotion = promotion;
  database
    .query("UPDATE items SET metadata=? WHERE fullname=?")
    .run(JSON.stringify(metadata), item.fullname);

  return receipt;
}

export async function promote(
  database: Database,
  item: Item,
  opts: { device?: string } = {},
): Promise<PromoteResult> {
  const fullname = item.fullname;
  const metadata = parseMetadata(item.metadata);
  const existing = metadata.promotion;

  if (existing?.status === "promoted") {
    const response = existing.response ?? "";

    const attemptedAt = z
      .number()
      .catch(Math.floor(Date.now() / 1000))
      .parse(existing.attempted_at);

    const receipt = existing.receipt ?? makeReceipt(fullname, "promoted", attemptedAt, response);

    return { status: "replay", promoted: true, response, receipt };
  }

  const attemptedAt = Math.floor(Date.now() / 1000);
  let response: string;

  try {
    response = await deliver(buildCapture(item, opts.device ?? "desktop"));
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    const message = error.message;
    const receipt = persistReceipt(database, item, "failed", attemptedAt, { error: message });

    return { status: "failed", promoted: false, response: "", receipt, error: message };
  }

  if (response.startsWith(SAVED_PREFIX) || response.startsWith(ALREADY_SAVED_PREFIX)) {
    const replay = response.startsWith(ALREADY_SAVED_PREFIX);
    const receipt = persistReceipt(database, item, "promoted", attemptedAt, { response });

    return { status: replay ? "replay" : "promoted", promoted: true, response, receipt };
  }

  const error = `PKMS capture returned an unrecognized response body ${JSON.stringify(response)} (no ✓ confirmation)`;
  const receipt = persistReceipt(database, item, "failed", attemptedAt, { response, error });

  return { status: "failed", promoted: false, response, receipt, error };
}
