import * as db from "../../db.ts";
import { connection } from "../state.ts";
import { htmlResponse } from "../static.ts";
import { renderHome } from "../views/home.ts";
import { renderPage } from "../views/page.ts";
import { ROUND_SIZES } from "../views/today.ts";

const DEFAULT_GOAL = 8;

const DEFAULT_ROUND = 10;

function cookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");

    if (key === name) return decodeURIComponent(rest.join("="));
  }

  return null;
}

export function homePage(request: Request): Response {
  const database = connection();
  const now = new Date();
  const pulse = db.pulse(database);
  const monthStart = Math.floor(new Date(now.getFullYear(), now.getMonth(), 1).getTime() / 1000);
  const goal = Number.parseInt(cookie(request, "ch_goal") ?? "", 10);
  const size = ROUND_SIZES.find((n) => String(n) === cookie(request, "ch_round_size"));

  const body = renderHome({
    now,
    clearedToday: pulse.cleared_today + pulse.swept_today,
    clearedTotal: pulse.cleared_total,
    kept: db.keptTotal(database),
    goal: Number.isInteger(goal) && goal > 0 ? Math.min(goal, 50) : DEFAULT_GOAL,
    roundSize: size ?? DEFAULT_ROUND,
    showedUp: new Set(db.decisionDays(database, monthStart)),
  });

  return htmlResponse(renderPage({ title: "Home", tab: "home", body }));
}
