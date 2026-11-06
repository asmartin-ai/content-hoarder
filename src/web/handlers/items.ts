import { z } from "zod";
import * as db from "../../db.ts";
import * as categorize from "../../categorize.ts";
import * as redditUnsave from "../../reddit_unsave.ts";
import * as redditHydrate from "../../reddit_hydrate.ts";
import * as archival from "../../archival/service.ts";
import { defaultMediaProviders } from "../../archival/providers.ts";
import * as llm from "../../assist/llm.ts";
import { aiActive } from "../../assist/consent.ts";
import * as triageScore from "../../triage_score.ts";
import * as pkms from "../../bridge/pkms.ts";
import { track } from "../../demo_analytics.ts";
import { json, objectBody, numberValue } from "../http.ts";
import { connection, noteUnsaveEnqueue } from "../state.ts";
import {
  BodyTextRequest,
  CategoryBody,
  FolderBody,
  HydrateResponseSchema,
  ItemStatusBody,
  PriorStatusSchema,
  QueueStateSchema,
  RecoveryBody,
  SnoozeBody,
  TagBody,
} from "../schemas.ts";

export interface ItemRoute {
  fullname: string;
  action: string | null;
}

const HintOutcomeMatchSchema = z.object({ matched: z.boolean() });

const BulkStatusBody = z.object({ fullnames: z.array(z.string()), status: z.string() });

const _AUTO_LEARN_STATUSES = ["keep", "archived", "done"] as const;

export async function handleBulkStatus(request: Request): Promise<Response> {
  const body = BulkStatusBody.parse(await request.json().catch(() => ({})));

  try {
    const database = connection();
    const updated = db.bulkSetStatus(database, body.fullnames, body.status);

    if (updated > 0 && _AUTO_LEARN_STATUSES.some((status) => status === body.status))
      triageScore.noteDecision(database, updated);

    return json({ updated });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
}

export async function handleItemAction(
  request: Request,
  path: string,
  itemRoute: ItemRoute,
): Promise<Response> {
  const action = itemRoute.action;
  const fullname = itemRoute.fullname;
  const database = connection();

  if (action === "undo" && path.startsWith("/reddit/items/")) {
    if (!db.getItem(database, fullname)) return json({ error: "not found" }, 404);

    const queued = QueueStateSchema.safeParse(
      database.query("SELECT state FROM reddit_unsave WHERE fullname=?").get(fullname),
    );

    if (queued.success && queued.data.state === "done")
      return json({ undone: await redditUnsave.resave(database, fullname), method: "resave" });
    db.dequeueUnsave(database, fullname);
    database.query("UPDATE items SET is_saved=1 WHERE fullname=?").run(fullname);

    return json({ undone: true, method: "dequeued", is_saved: 1 });
  }

  if (action === "status") {
    const body = await objectBody(request, ItemStatusBody);

    try {
      const status = body.status.trim();
      const prior = db.getItem(database, fullname)?.status ?? null;
      const item = db.setStatus(database, fullname, status, { hint: body.hint });

      if (!item) return json({ error: "not found" }, 404);

      if (prior !== status && (status === "keep" || status === "archived" || status === "done"))
        triageScore.noteDecision(database);

      if (
        status === "done" &&
        fullname.startsWith("reddit:") &&
        db.getSetting(database, "reddit_unsave_on_done", "0") === "1"
      )
        noteUnsaveEnqueue();

      const outcome =
        prior === status ? null : HintOutcomeMatchSchema.safeParse(item.metadata.hint_outcome);

      track(database, "srv_status", {
        fullname,
        data: {
          status,
          prior,
          hint: body.hint?.verdict,
          matched: outcome?.success ? outcome.data.matched : undefined,
        },
      });

      return json(item);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  }

  if (action === "undo") {
    const prior = PriorStatusSchema.safeParse(
      database
        .query(
          "SELECT i.status, q.state FROM items i LEFT JOIN reddit_unsave q ON q.fullname=i.fullname WHERE i.fullname=?",
        )
        .get(fullname),
    );

    let item = db.undoStatus(database, fullname);

    if (!item) return json({ error: "not found" }, 404);

    track(database, "srv_undo", { fullname });

    if (
      prior.success &&
      prior.data.status === "done" &&
      prior.data.state === "done" &&
      item.status !== "done"
    ) {
      const saved = await redditUnsave.resave(database, fullname);
      item = db.getPublicItem(database, fullname) ?? item;

      if (!saved)
        return json({
          ...item,
          warning:
            "restored locally, but still unsaved on Reddit (re-save failed — check the session cookie)",
        });
    }

    return json(item);
  }

  if (action === "snooze") {
    const body = await objectBody(request, SnoozeBody);
    const now = Math.floor(Date.now() / 1000);
    const days = numberValue(body.window_days, 7) || 7;

    if (days < 1) return json({ error: "window_days must be >= 1" }, 400);
    let until = numberValue(body.until_utc, 0) || now + days * 86400;

    if (until < now) return json({ error: "until_utc must be in the future" }, 400);
    until = Math.min(until, now + 10 * 365 * 86400);

    try {
      return json(
        db.snooze(database, {
          fullnames: [fullname],
          untilUtc: until,
          windowDays: days,
          escalateAfter: numberValue(body.escalate_after, 3) || 3,
          apply: true,
        }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      return json({ error: message }, message.startsWith("unknown item") ? 404 : 400);
    }
  }

  if (action === "body") {
    const body = await objectBody(request, BodyTextRequest);
    const item = db.setBody(database, fullname, body.body);

    return item ? json(item) : json({ error: "not found" }, 404);
  }

  if (action === "category") {
    const body = await objectBody(request, CategoryBody);

    const category = z
      .enum(categorize.VALID_CATEGORIES)
      .safeParse(body.category.trim().toLowerCase());

    if (!category.success) return json({ error: "invalid category" }, 400);

    if (!db.getItem(database, fullname)) return json({ error: "not found" }, 404);
    db.setCategory(database, fullname, category.data);

    return json({ fullname, category: category.data });
  }

  if (action === "tags") {
    const body = await objectBody(request, TagBody);
    const add = [...(body.add ?? []), ...(body.tag ? [body.tag] : [])];
    const remove = body.remove ?? [];

    if (!add.length && !remove.length) return json({ error: "no tags given" }, 400);
    const tags = db.setTags(database, fullname, { add, remove });

    return tags ? json({ fullname, tags }) : json({ error: "not found" }, 404);
  }

  if (action === "promote") {
    const item = db.getPublicItem(database, fullname);

    if (!item) return json({ error: "not found" }, 404);

    if (!pkms.isConfigured())
      return json(
        { error: "PKMS not configured (set PKMS_CAPTURE_URL + PKMS_CAPTURE_TOKEN)" },
        400,
      );

    const device = /Mobile|Android|iPhone|iPad/.test(request.headers.get("user-agent") ?? "")
      ? "phone"
      : "desktop";

    const result = await pkms.promote(database, item, { device });

    return json(result, result.status === "failed" ? 502 : 200);
  }

  if (action === "suggest") {
    if (!llm.isAvailable()) return json({ error: "LLM not configured" }, 503);

    if (!aiActive(database)) return json({ error: "AI suggestions are off" }, 403);

    const result = await llm.suggestAndStore(database, fullname);

    return result ? json(result) : json({ error: "no suggestion" }, 502);
  }

  if (action === "recover") {
    const body = await objectBody(request, RecoveryBody);
    const mode = body.archive_today ?? "off";
    const metadata = body.metadata ?? true;

    if (body.fullnames || body.bulk) return json({ error: "recover is per-item only" }, 400);

    if (!metadata && mode === "off")
      return json({ error: "recover request has no enabled recovery mode" }, 400);
    const result = metadata ? await archival.recoverOne(database, fullname) : null;

    if (metadata && !result) return json({ error: "not a recoverable reddit item" }, 400);

    if (mode !== "off") {
      if (body.confirm_external_archive_today !== true)
        return json({ error: "archive.today recovery requires explicit confirmation" }, 400);
      const eligibility = archival.archiveTodayMediaEligibility(db.getItem(database, fullname));

      if (!eligibility.eligible)
        return json({ error: "archive.today not eligible", reason: eligibility.reason }, 400);

      const media = await archival.archiveTodayRecoverMedia(database, fullname, {
        providers: defaultMediaProviders(archival.DEFAULT_USER_AGENT, false),
        applyBytes: mode === "apply",
      });

      return json({
        ...result,
        archive_today: media,
        bytes_archived: media.bytes_archived,
        recovered: result?.metadata_recovered || media.result === "hit",
      });
    }

    return json(
      result ?? {
        recovered: false,
        metadata_recovered: false,
        metadata_result: "skipped",
        metadata_reason: "disabled",
        title: null,
        body: null,
        url: null,
        bytes_archived: 0,
      },
    );
  }

  if (action === "hydrate" || action === "hydrate-gallery") {
    const rawResult =
      action === "hydrate"
        ? await redditHydrate.hydrateOne(database, fullname)
        : await redditHydrate.hydrateGallery(database, fullname);

    const result = HydrateResponseSchema.parse(rawResult);

    const success =
      action === "hydrate"
        ? ["hydrated", "archived"].includes(result.status)
        : ["cached", "hydrated", "no_gallery"].includes(result.status);

    const code = success
      ? 200
      : result.status === "not_found"
        ? 404
        : ["no_permalink", "bad_shape"].includes(result.status)
          ? 400
          : ["auth_missing", "auth_expired"].includes(result.status)
            ? 401
            : result.status === "network_error"
              ? 502
              : 500;

    return json(result, code);
  }

  if (action === "folder") {
    const body = await objectBody(request, FolderBody);
    const folder = body.folder ?? null;

    return db.setItemFolder(database, fullname, folder)
      ? json({ fullname, folder })
      : json({ error: "not found" }, 404);
  }

  return json({ error: "not found" }, 404);
}
