import type { Database } from "bun:sqlite";
import { aiConfigured, aiConsent } from "../../assist/consent.ts";
import * as db from "../../db.ts";
import { hostedOrigin, sessionSub } from "../../hosted.ts";
import { requestZone } from "../http.ts";
import { connection, mainConnection, takePull } from "../state.ts";
import { htmlResponse } from "../static.ts";
import { renderPage } from "../views/page.ts";
import {
  renderAdd,
  renderPull,
  type AiSettingsView,
  type OnboardingView,
  type YoutubeChoiceView,
} from "../views/add.ts";
import { youtubeChoiceView, youtubeImported } from "./youtube.ts";

const ONBOARDING_DONE = "onboarding_done_seen";

const CLEAR_ROUND = 10;

function aiSettings(): AiSettingsView | undefined {
  if (!aiConfigured()) return undefined;

  return { on: aiConsent(connection()) === "on" };
}

function onboarding(request: Request, library: Database): OnboardingView {
  const seen = db.getSetting(library, ONBOARDING_DONE) === "1";
  const presence = db.libraryPresence(library);
  const progress = db.dailyProgress(library, { zone: requestZone(request) });

  const step = presence.empty
    ? 1
    : !presence.inbox || progress.cleared + progress.swept >= CLEAR_ROUND
      ? 3
      : 2;

  return { step, collapsed: seen };
}

export function onboardingSeen(library: Database): Response {
  db.setSetting(library, ONBOARDING_DONE, "1");

  return new Response(null, { status: 204 });
}

function youtubeSection(request: Request, url: URL): YoutubeChoiceView | undefined {
  if (!hostedOrigin()) return undefined;

  const sub = sessionSub(mainConnection(), request);

  if (!sub) return undefined;

  if (url.searchParams.get("youtube") === "denied") return { state: "denied" };

  const choice = youtubeChoiceView(sub);

  if (!choice) return undefined;

  if (choice.state === "choose") return choice;

  return url.searchParams.has("youtube") ? choice : undefined;
}

export function addPage(request: Request, url: URL): Response {
  const library = connection();
  const hosted = Boolean(hostedOrigin());
  const sub = hosted ? sessionSub(mainConnection(), request) : null;

  return htmlResponse(
    renderPage({
      title: "Add",
      tab: "add",
      body: renderAdd(
        takePull(library),
        aiSettings(),
        youtubeSection(request, url),
        hosted ? onboarding(request, library) : undefined,
        sub ? youtubeImported(sub) : false,
      ),
    }),
  );
}

export function pullStatus(): Response {
  return htmlResponse(String(renderPull(takePull(connection()))));
}
