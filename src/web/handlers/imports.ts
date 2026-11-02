import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { type BaseConnector, dispatch, get } from "../../connectors/registry.ts";
import * as firefoxTabs from "../../firefox_tabs.ts";
import { importPath } from "../../pipeline.ts";
import { resolveYouTubeUrl } from "../../youtube.ts";
import { json } from "../http.ts";
import {
  PREPARED_TTL_SECONDS,
  cleanPrepared,
  connection,
  stageImport,
  takeImport,
} from "../state.ts";
import { CommitImportBody, ExistingCountSchema, PrepareImportBody } from "../schemas.ts";

const UNSUPPORTED =
  "Khaos can't read that file yet. Try a bookmarks export, a list of links, or a Reddit file.";

function pickConnector(path: string, source: string | undefined): BaseConnector | null {
  try {
    return source ? get(source) : dispatch(path);
  } catch {
    return null;
  }
}

export async function importFirefoxTabs(request: Request): Promise<Response> {
  const raw = z.json().safeParse(await request.json().catch(() => null));

  if (!raw.success) return json({ error: "invalid payload" }, 400);
  const validation = firefoxTabs.validatePayload(raw.data);

  if (validation.error || !validation.payload)
    return json({ error: validation.error ?? "invalid payload" }, 400);
  const database = connection();

  if (!firefoxTabs.tokenConfigured(database))
    return json({ error: "firefox ingest token is not configured" }, 503);
  const authorization = request.headers.get("authorization") ?? "";

  const token = authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice(7).trim()
    : (request.headers.get("x-content-hoarder-token")?.trim() ?? "");

  if (!token) return json({ error: "missing token" }, 401);

  if (!firefoxTabs.verifyToken(database, token)) return json({ error: "invalid token" }, 403);

  return json(firefoxTabs.ingestSnapshot(database, validation.payload));
}

export async function importUpload(request: Request): Promise<Response> {
  const form = await request.formData();
  const file = form.get("file");

  if (!(file instanceof File) || !file.size) return json({ error: "no file uploaded" }, 400);

  const path = join(
    tmpdir(),
    `content-hoarder-${randomBytes(12).toString("hex")}${extname(file.name) || ".dat"}`,
  );

  await Bun.write(path, file);
  const rawSource = z.string().safeParse(form.get("source"));

  try {
    const result = await importPath(connection(), path, {
      source: rawSource.success ? rawSource.data : undefined,
    });

    return json({
      imported: result.imported,
      skipped: result.skipped,
      errors: result.errors.slice(0, 20),
    });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 400);
  } finally {
    try {
      unlinkSync(path);
    } catch {}
  }
}

export async function prepareImport(request: Request): Promise<Response> {
  cleanPrepared();
  let stagedPath = "";
  let source: string | undefined;
  let url = "";

  if (request.headers.get("content-type")?.includes("multipart/form-data")) {
    const form = await request.formData();
    const file = form.get("file");
    const rawSource = z.string().safeParse(form.get("source"));
    source = rawSource.success ? rawSource.data : undefined;

    if (file instanceof File && file.size) {
      stagedPath = join(
        tmpdir(),
        `content-hoarder-${randomBytes(12).toString("hex")}${extname(file.name) || ".dat"}`,
      );
      await Bun.write(stagedPath, file);
    }

    const rawUrl = z.string().safeParse(form.get("url"));
    url = rawUrl.success ? rawUrl.data.trim() : "";
  } else {
    const body = PrepareImportBody.parse(await request.json().catch(() => ({})));
    url = body.url?.trim() ?? "";
    source = body.source;
  }

  if (!stagedPath && url) {
    if (!/^https?:\/\/(?:[\w.-]*\.)?(?:youtube\.com|youtu\.be)\//i.test(url))
      return json({ error: "Only YouTube playlist or video URLs are supported here." }, 400);

    try {
      const youtubeImport = await resolveYouTubeUrl(url);
      stagedPath = join(tmpdir(), `content-hoarder-${randomBytes(12).toString("hex")}.json`);
      await Bun.write(stagedPath, JSON.stringify(youtubeImport));
      source = "youtube";
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  }

  if (!stagedPath) return json({ error: "Provide a file or a YouTube URL." }, 400);

  try {
    const connector = pickConnector(stagedPath, source);

    if (!connector) {
      unlinkSync(stagedPath);

      return json({ error: UNSUPPORTED }, 400);
    }

    const items = connector.importFile(stagedPath);

    if (!items.length) {
      unlinkSync(stagedPath);

      return json({ error: "No importable items found in that input." }, 400);
    }

    const names = [...new Set(items.map((item) => item.fullname))];
    const database = connection();
    let existing = 0;

    for (let offset = 0; offset < names.length; offset += 500) {
      const chunk = names.slice(offset, offset + 500);
      const placeholders = chunk.map(() => "?").join(",");

      const countRow = ExistingCountSchema.safeParse(
        database
          .query(`SELECT COUNT(*) AS count FROM items WHERE fullname IN (${placeholders})`)
          .get(...chunk),
      );

      existing += countRow.success ? countRow.data.count : 0;
    }

    const token = stageImport(stagedPath, connector.id, PREPARED_TTL_SECONDS);

    const sample = items.slice(0, 5).map((item) => ({
      title: (item.title || item.url || item.fullname).slice(0, 120),
      source: item.source,
    }));

    return json({
      token,
      count: names.length,
      new: Math.max(names.length - existing, 0),
      source: connector.id,
      label: connector.label,
      sample,
    });
  } catch (error) {
    try {
      unlinkSync(stagedPath);
    } catch {}

    return json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
}

export async function commitImport(request: Request): Promise<Response> {
  cleanPrepared();
  const body = CommitImportBody.parse(await request.json().catch(() => ({})));
  const token = body.token?.trim() ?? "";
  const staged = takeImport(token);

  if (!staged) return json({ error: "this import preview expired — please preview again" }, 400);

  try {
    const result = await importPath(connection(), staged.path, { source: staged.source });

    return json({
      imported: result.imported,
      skipped: result.skipped,
      errors: result.errors.slice(0, 20),
    });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 400);
  } finally {
    try {
      unlinkSync(staged.path);
    } catch {}
  }
}
