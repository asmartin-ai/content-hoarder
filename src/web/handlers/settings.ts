import { appendFileSync } from "node:fs";
import { basename } from "node:path";
import * as db from "../../db.ts";
import * as redditUnsave from "../../reddit_unsave.ts";
import {
  aiConfigured,
  aiConsent,
  aiProviderLabel,
  setAiConsent,
  type AiConsent,
} from "../../assist/consent.ts";
import { bool, clamp, json, numberValue, objectBody } from "../http.ts";
import { track } from "../../demo_analytics.ts";
import { hostedOrigin, sessionSub } from "../../hosted.ts";
import { htmlResponse } from "../static.ts";
import { connection, librarySidecar, mainConnection } from "../state.ts";
import { renderPage } from "../views/page.ts";
import { renderSettings } from "../views/settings.ts";
import { sessionEmail } from "./auth.ts";
import {
  DrainBody,
  EnabledBody,
  EnqueueTagBody,
  PurgeBody,
  PurgeVictimSchema,
} from "../schemas.ts";

export async function purgeDone(request: Request): Promise<Response> {
  const body = await objectBody(request, PurgeBody);
  const expectedTotal = numberValue(body.expected_total, -1);
  const expectedCutoff = numberValue(body.expected_cutoff, -1);

  if (expectedTotal < 0 || expectedCutoff < 0)
    return json({ error: "expected_total and expected_cutoff are required" }, 400);
  const database = connection();
  const now = Math.floor(Date.now() / 1000);
  const stored = Number(db.getSetting(database, "done_retention_days", "30") ?? "30");
  const retentionDays = Number.isFinite(stored) && stored >= 1 && stored <= 3650 ? stored : 30;
  const cutoff = Math.floor(expectedCutoff);

  if (cutoff > now - retentionDays * 86400)
    return json(
      {
        error: "purge preview changed; review the updated count before deleting",
        preview: db.purgeDone(database, { now }),
      },
      409,
    );

  const plan = db.purgeDone(database, { cutoff });

  if (plan.total !== expectedTotal)
    return json(
      {
        error: "purge preview changed; review the updated count before deleting",
        preview: db.purgeDone(database, { now }),
      },
      409,
    );

  if (!plan.total)
    return json({ error: "no Done items currently qualify for purge", preview: plan }, 409);

  const victims = database
    .query(
      "SELECT fullname, source, title FROM items WHERE status='done' AND processed_utc IS NOT NULL AND processed_utc < ? ORDER BY processed_utc",
    )
    .all(cutoff)
    .map((row) => PurgeVictimSchema.parse(row));

  const backupPath = librarySidecar(
    `app.backup-pre-purge-done-${new Date().toISOString().replaceAll(":", "-")}.db`,
  );

  await Bun.write(backupPath, database.serialize());
  const purged = db.purgeDone(database, { cutoff, apply: true });
  const preview = db.purgeDone(database, { now });

  const audit = {
    ts: Math.floor(Date.now() / 1000),
    op: "purge_done",
    retention_days: purged.retention_days,
    cutoff: purged.cutoff,
    total: purged.total,
    threads_deleted: purged.threads_deleted,
    backup: backupPath,
    victims: victims.slice(0, 200).map((row) => ({
      fullname: row.fullname,
      source: row.source,
      title: row.title.slice(0, 80),
    })),
  };

  appendFileSync(librarySidecar("delete-audit.jsonl"), `${JSON.stringify(audit)}\n`);

  return json({ purged: { ...purged, backup: basename(backupPath) }, preview });
}

export async function drainUnsave(request: Request): Promise<Response> {
  const body = await objectBody(request, DrainBody);
  const database = connection();
  const limit = clamp(numberValue(body.max ?? body.limit, 50), 1, 500);
  const live = bool(body.live);
  const confirmed = bool(body.confirm) || bool(body.yes);

  if (!live || !confirmed) {
    const result = await redditUnsave.drain(database, { limit, dryRun: true });
    const remaining = Math.max(redditUnsave.countPending(database) - result.selected, 0);

    if (live)
      return json(
        {
          ...result,
          remaining,
          live_required: ["live", "confirm"],
          ok: false,
          error: "live drain requires confirm=true or yes=true",
        },
        409,
      );

    return json({ ...result, remaining, live_required: ["live", "confirm"] });
  }

  const [audit] = redditUnsave.auditAppender(librarySidecar(redditUnsave.AUDIT_FILE));

  return json(await redditUnsave.drain(database, { limit, dryRun: false, audit }));
}

export async function enqueueUnsaveByTag(request: Request): Promise<Response> {
  const body = await objectBody(request, EnqueueTagBody);
  const tag = body.tag.trim();

  if (!tag) return json({ error: "tag required" }, 400);
  const requested = bool(body.apply) || bool(body.confirm);
  const apply = requested && bool(body.yes);
  const result = db.enqueueUnsaveByTag(connection(), tag, { dryRun: !apply });

  const common = {
    ...result,
    confirmed: apply,
    confirmation_required: ["apply", "yes"],
    message:
      "This only queues local unsaves. Reddit is not contacted until the existing explicit drain action runs.",
  };

  return requested && !apply
    ? json({ ...common, ok: false, error: "local by-tag enqueue requires yes=true" }, 409)
    : json(common);
}

interface AiState {
  configured: boolean;
  consent: AiConsent;
  provider: string;
}

function aiState(): AiState {
  return {
    configured: aiConfigured(),
    consent: aiConsent(connection()),
    provider: aiProviderLabel(),
  };
}

export function aiSettings(): Response {
  return json(aiState());
}

export function settingsPage(request: Request): Response {
  const database = connection();
  const now = Math.floor(Date.now() / 1000);
  const stored = Number(db.getSetting(database, "done_retention_days", "30") ?? "30");
  const retentionDays = Number.isFinite(stored) && stored >= 1 && stored <= 3650 ? stored : 30;

  if (retentionDays !== stored) db.setSetting(database, "done_retention_days", "30");

  const preview = db.purgeDone(database, { now });
  const auth = redditUnsave.getAuth(database);
  const sub = hostedOrigin() ? sessionSub(mainConnection(), request) : null;

  const body = renderSettings({
    hosted: Boolean(hostedOrigin()),
    account: sub ? { email: sessionEmail(sub) } : null,
    ai: aiConfigured() ? { on: aiConsent(database) === "on", provider: aiProviderLabel() } : null,
    retention: { days: retentionDays, total: preview.total, cutoff: preview.cutoff },
    unsave: hostedOrigin()
      ? null
      : {
          enabled: db.unsaveEnabled(database),
          username: auth?.username ?? null,
          pending: redditUnsave.countPending(database),
          failed: redditUnsave.countFailed(database),
        },
  });

  return htmlResponse(renderPage({ title: "Settings", tab: "settings", body }));
}

export async function updateAiSettings(request: Request): Promise<Response> {
  const body = await objectBody(request, EnabledBody);
  const database = connection();

  setAiConsent(database, body.enabled);
  track(database, "srv_consent", { data: { on: body.enabled } });

  return json(aiState());
}
