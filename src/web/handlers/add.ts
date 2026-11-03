import { aiConfigured, aiConsent } from "../../assist/consent.ts";
import { hostedOrigin, sessionSub } from "../../hosted.ts";
import { connection, mainConnection, takePull } from "../state.ts";
import { htmlResponse } from "../static.ts";
import { renderPage } from "../views/page.ts";
import {
  renderAdd,
  renderPull,
  type AiSettingsView,
  type YoutubeChoiceView,
} from "../views/add.ts";
import { youtubeChoiceView } from "./youtube.ts";

function aiSettings(): AiSettingsView | undefined {
  if (!aiConfigured()) return undefined;

  return { on: aiConsent(connection()) === "on" };
}

function youtubeSection(request: Request, url: URL): YoutubeChoiceView | undefined {
  if (!hostedOrigin()) return undefined;

  const sub = sessionSub(mainConnection(), request);
  const choice = sub ? youtubeChoiceView(sub) : null;

  if (!choice) return undefined;

  if (choice.state === "choose") return choice;

  return url.searchParams.has("youtube") ? choice : undefined;
}

export function addPage(request: Request, url: URL): Response {
  return htmlResponse(
    renderPage({
      title: "Add",
      tab: "add",
      body: renderAdd(takePull(connection()), aiSettings(), youtubeSection(request, url)),
    }),
  );
}

export function pullStatus(): Response {
  return htmlResponse(String(renderPull(takePull(connection()))));
}
