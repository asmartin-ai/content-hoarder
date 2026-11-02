import { aiConfigured, aiConsent } from "../../assist/consent.ts";
import { connection, takePull } from "../state.ts";
import { htmlResponse } from "../static.ts";
import { renderPage } from "../views/page.ts";
import { renderAdd, renderPull, type AiSettingsView } from "../views/add.ts";

function aiSettings(): AiSettingsView | undefined {
  if (!aiConfigured()) return undefined;

  return { on: aiConsent(connection()) === "on" };
}

export function addPage(): Response {
  return htmlResponse(
    renderPage({
      title: "Add",
      tab: "add",
      body: renderAdd(takePull(connection()), aiSettings()),
    }),
  );
}

export function pullStatus(): Response {
  return htmlResponse(String(renderPull(takePull(connection()))));
}
