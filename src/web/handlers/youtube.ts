import type { Database } from "bun:sqlite";
import { z } from "zod";
import * as db from "../../db.ts";
import { pullYoutube } from "../../hosted_pull.ts";
import { json } from "../http.ts";
import { YoutubeImportBody } from "../schemas.ts";
import {
  libraryConnection,
  restoreYoutubeChoice,
  startPull,
  takeYoutubeChoice,
  youtubeChoice,
  youtubeChoiceExpired,
} from "../state.ts";
import type { YoutubeChoiceView } from "../views/add.ts";

const IMPORTED_SETTING = "youtube_imported_playlists";

const ImportedPlaylists = z.array(z.string());

function importedPlaylists(library: Database): Set<string> {
  let value: unknown;

  try {
    value = JSON.parse(db.getSetting(library, IMPORTED_SETTING, "[]") ?? "[]");
  } catch {
    return new Set();
  }

  const parsed = ImportedPlaylists.safeParse(value);

  return new Set(parsed.success ? parsed.data : []);
}

function recordImported(library: Database, id: string): void {
  const stored = importedPlaylists(library);

  stored.add(id);
  db.setSetting(library, IMPORTED_SETTING, JSON.stringify([...stored].sort()));
}

export function youtubeImported(sub: string): boolean {
  return importedPlaylists(libraryConnection(sub)).size > 0;
}

export function youtubeChoiceView(sub: string): YoutubeChoiceView {
  const choice = youtubeChoice(sub);

  if (!choice) return { state: youtubeChoiceExpired(sub) ? "expired" : "none" };

  const imported = importedPlaylists(libraryConnection(sub));

  return {
    state: "choose",
    generation: choice.generation,
    playlists: choice.playlists.map((playlist) => ({
      ...playlist,
      imported: imported.has(playlist.id),
    })),
    expiresIn: Math.max(0, Math.ceil((choice.expiresAt - Date.now()) / 1000)),
  };
}

function choiceJson(sub: string): Response {
  const view = youtubeChoiceView(sub);

  if (view.state !== "choose") return json({ state: view.state });

  return json({
    state: "choose",
    generation: view.generation,
    playlists: view.playlists,
    expires_in: view.expiresIn,
  });
}

export async function youtubeImport(request: Request, sub: string): Promise<Response> {
  const body = YoutubeImportBody.safeParse(await request.json().catch(() => null));

  if (!body.success) return json({ error: "invalid import request" }, 400);

  const choice = takeYoutubeChoice(sub);

  if (!choice || choice.generation !== body.data.generation) {
    if (choice) restoreYoutubeChoice(sub, choice);

    return json({ state: "stale" }, 409);
  }

  const offered = new Set(choice.playlists.map((playlist) => playlist.id));
  const ids = [...new Set(body.data.ids)];

  if (!ids.every((id) => offered.has(id))) {
    restoreYoutubeChoice(sub, choice);

    return json({ error: "unknown playlist" }, 400);
  }

  const library = libraryConnection(sub);

  const started = startPull(library, "youtube", () =>
    pullYoutube(library, choice.token, ids, choice.expiresAt, (id) => recordImported(library, id)),
  );

  if (started === "busy") {
    restoreYoutubeChoice(sub, choice);

    return json({ state: "busy" }, 409);
  }

  return json({ started: true });
}

export async function youtubeRoute(
  request: Request,
  sub: string,
  method: string,
  path: string,
): Promise<Response | null> {
  if (method === "GET" && path === "/youtube/playlists") return choiceJson(sub);

  if (method === "POST" && path === "/youtube/import") return youtubeImport(request, sub);

  return null;
}
