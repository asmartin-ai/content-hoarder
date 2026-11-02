import * as db from "../../db.ts";
import { cookieValue } from "../../hosted.ts";
import { connection } from "../state.ts";
import { htmlResponse } from "../static.ts";
import { renderHome } from "../views/home.ts";
import { renderPage } from "../views/page.ts";
import { ROUND_SIZES } from "../views/today.ts";

const DEFAULT_ROUND = 10;

const RHYTHM_DAYS = 14;

function isoDay(d: Date): string {
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");

  return `${d.getFullYear()}-${month}-${day}`;
}

function daysBack(now: Date, n: number): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - n);
}

export function homePage(request: Request): Response {
  const database = connection();
  const now = new Date();
  const weekStart = Math.floor(daysBack(now, 6).getTime() / 1000);
  const rhythmStart = daysBack(now, RHYTHM_DAYS - 1);

  const showedUp = new Set(
    db
      .decisionTimes(database, Math.floor(rhythmStart.getTime() / 1000))
      .map((t) => isoDay(new Date(t * 1000))),
  );

  const today = isoDay(now);

  const rhythm = Array.from({ length: RHYTHM_DAYS }, (_, i) => {
    const day = isoDay(daysBack(now, RHYTHM_DAYS - 1 - i));

    return { day, on: showedUp.has(day), today: day === today };
  });

  const size = ROUND_SIZES.find((n) => String(n) === cookieValue(request, "ch_round_size"));

  const body = renderHome({
    now,
    roundSize: size ?? DEFAULT_ROUND,
    flow: db.weekFlow(database, weekStart),
    resurfaced: db.oldestWaiting(database),
    rhythm,
  });

  return htmlResponse(renderPage({ title: "Home", tab: "home", body }));
}
