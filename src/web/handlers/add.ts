import { connection, takePull } from "../state.ts";
import { htmlResponse } from "../static.ts";
import { renderPage } from "../views/page.ts";
import { renderAdd, renderPull } from "../views/add.ts";

export function addPage(): Response {
  return htmlResponse(
    renderPage({ title: "Add", tab: "add", body: renderAdd(takePull(connection())) }),
  );
}

export function pullStatus(): Response {
  return htmlResponse(String(renderPull(takePull(connection()))));
}
