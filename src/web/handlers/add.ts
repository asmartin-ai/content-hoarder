import { htmlResponse } from "../static.ts";
import { renderPage } from "../views/page.ts";
import { renderAdd } from "../views/add.ts";

export function addPage(request: Request, url: URL): Response {
  return htmlResponse(renderPage({ title: "Add", tab: "add", body: renderAdd(url) }));
}
