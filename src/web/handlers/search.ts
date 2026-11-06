import { z } from "zod";
import * as semantic from "../../semantic.ts";
import { aiProviderLabel } from "../../assist/consent.ts";
import { connection } from "../state.ts";
import { json, objectBody, options } from "../http.ts";
import { htmlResponse } from "../static.ts";
import { html } from "../views/html.ts";

const Action = z.object({ query: z.string().min(1).max(4000), consent: z.boolean().optional() });

export async function searchRoute(request: Request): Promise<Response | null> {
  const url = new URL(request.url),
    path = url.pathname;

  if (path !== "/search" && !path.startsWith("/api/semantic/")) return null;
  const conn = connection();

  try {
    if (request.method === "GET" && path === "/search")
      return htmlResponse(
        html`<!doctype html>
          <html lang="en">
            <head>
              <meta charset="utf-8" />
              <meta name="viewport" content="width=device-width,initial-scale=1" />
              <title>Search · Khaos</title>
              <link rel="stylesheet" href="/static/semantic.css" />
              <script defer src="/static/semantic.js"></script>
            </head>
            <body>
              <main>
                <nav><a href="/library">← Library</a><a href="/privacy">Privacy</a></nav>
                <h1>Search your library</h1>
                <p>
                  Find saved passages by meaning, or ask a question grounded in your sources.
                  Regular Library search stays lexical.
                </p>
                <section aria-labelledby="index-title">
                  <h2 id="index-title">Local semantic index</h2>
                  <p id="index-status" role="status">Loading index status…</p>
                  <button id="index" type="button">Index library</button>
                  <p class="muted">
                    Explicit action only. First use downloads the embedding model; text stays on
                    this server. Offline mode requires a warmed model. Changed sources are excluded
                    until reindexed.
                  </p>
                </section>
                <form id="search-form">
                  <label for="query">Search or question</label
                  ><textarea
                    id="query"
                    name="q"
                    maxlength="4000"
                    required
                    rows="3"
                    placeholder="What did I save about building reliable backups?"
                  ></textarea>
                  <p class="muted">
                    Supports Library query operators, including source:, status:, tag:, exact quotes
                    and -exclusions.
                  </p>
                  <label class="check"><input type="checkbox" id="safe" checked /> Hide NSFW</label>
                  <div class="actions">
                    <button type="submit">Semantic search</button
                    ><button type="button" id="ask">Ask with sources</button>
                  </div>
                  <label class="check consent"
                    ><input type="checkbox" id="consent" /> For this question, I agree to send my
                    question and the full retrieved passages to ${aiProviderLabel()} (the configured
                    AI endpoint). This is separate from AI hint consent.</label
                  >
                </form>
                <p id="status" role="status" aria-live="polite"></p>
                <section id="answer" hidden>
                  <h2>Answer</h2>
                  <p id="answer-text"></p>
                </section>
                <section>
                  <h2>Sources</h2>
                  <div id="sources"><p>No search yet.</p></div>
                </section>
              </main>
            </body>
          </html>`.value,
      );

    if (request.method === "GET" && path === "/api/semantic/status")
      return json(semantic.semanticStatus(conn));

    if (request.method === "POST" && path === "/api/semantic/index")
      return json(await semantic.semanticIndex(conn));

    if (request.method === "POST" && ["/api/semantic/search", "/api/semantic/ask"].includes(path)) {
      const body = await objectBody(request, Action);
      const params = new URLSearchParams(url.search);
      params.set("q", body.query);
      const opts = options(params, { limit: 10, includeConsolidated: false });

      if (path.endsWith("/ask")) {
        if (body.consent !== true)
          return json(
            { error: "Consent to send this question and retrieved passages is required" },
            403,
          );
        semantic.setRagConsent(conn, true);

        return json(await semantic.ask(conn, body.query, opts));
      }

      return json(await semantic.semanticSearch(conn, body.query, opts));
    }

    return json({ error: "not found" }, 404);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Search failed" }, 400);
  }
}
