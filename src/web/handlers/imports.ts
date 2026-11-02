import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import * as firefoxTabs from "../../firefox_tabs.ts";
import { ImportRefused } from "../../import_jobs.ts";
import { IMPORT_BUSY, importBusy, importOffThread, prepareOffThread } from "../../import_runner.ts";
import { resolveYouTubeUrl } from "../../youtube.ts";
import { json } from "../http.ts";
import {
  PREPARED_TTL_SECONDS,
  cleanPrepared,
  connection,
  stageImport,
  takeImport,
} from "../state.ts";
import { CommitImportBody, PrepareImportBody } from "../schemas.ts";

function failure(error: Error): Response {
  if (error instanceof ImportRefused)
    return json({ error: error.message }, error.message === IMPORT_BUSY ? 409 : 400);

  console.error(`import failed: ${error.message}`);

  return json({ error: "That import didn't work. Try again, or try a different file." }, 400);
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
    return json(
      await importOffThread(connection(), path, rawSource.success ? rawSource.data : undefined),
    );
  } catch (error) {
    return failure(error instanceof Error ? error : new Error(String(error)));
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
    const prepared = await prepareOffThread(connection(), stagedPath, source);
    const token = stageImport(stagedPath, prepared.source, PREPARED_TTL_SECONDS);

    return json({
      token,
      count: prepared.count,
      new: prepared.fresh,
      source: prepared.source,
      label: prepared.label,
      sample: prepared.sample,
    });
  } catch (error) {
    try {
      unlinkSync(stagedPath);
    } catch {}

    return failure(error instanceof Error ? error : new Error(String(error)));
  }
}

export async function commitImport(request: Request): Promise<Response> {
  cleanPrepared();
  const body = CommitImportBody.parse(await request.json().catch(() => ({})));
  const token = body.token?.trim() ?? "";

  if (importBusy(connection())) return json({ error: IMPORT_BUSY }, 409);

  const staged = takeImport(token);

  if (!staged) return json({ error: "this import preview expired — please preview again" }, 400);

  try {
    return json(await importOffThread(connection(), staged.path, staged.source));
  } catch (error) {
    return failure(error instanceof Error ? error : new Error(String(error)));
  } finally {
    try {
      unlinkSync(staged.path);
    } catch {}
  }
}
