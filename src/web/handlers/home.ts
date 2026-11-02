import * as db from "../../db.ts";
import { cookieValue } from "../../hosted.ts";
import { isoDay, localMidnight } from "../../zone.ts";
import { requestZone } from "../http.ts";
import { connection } from "../state.ts";
import { htmlResponse } from "../static.ts";
import { renderHome } from "../views/home.ts";
import { renderPage } from "../views/page.ts";
import { ROUND_SIZES } from "../views/today.ts";

const DEFAULT_ROUND = 10;

const RHYTHM_DAYS = 14;

export function homePage(request: Request): Response {
  const database = connection();
  const zone = requestZone(request);
  const now = new Date();
  const ms = now.getTime();
  const weekStart = Math.floor(localMidnight(ms, zone, 6) / 1000);
  const rhythmStart = Math.floor(localMidnight(ms, zone, RHYTHM_DAYS - 1) / 1000);

  const showedUp = new Set(
    db.decisionTimes(database, rhythmStart).map((t) => isoDay(t * 1000, zone)),
  );

  const today = isoDay(ms, zone);

  const rhythm = Array.from({ length: RHYTHM_DAYS }, (_, i) => {
    const day = isoDay(localMidnight(ms, zone, RHYTHM_DAYS - 1 - i), zone);

    return { day, on: showedUp.has(day), today: day === today };
  });

  const size = ROUND_SIZES.find((n) => String(n) === cookieValue(request, "ch_round_size"));

  const body = renderHome({
    now,
    zone,
    roundSize: size ?? DEFAULT_ROUND,
    flow: db.weekFlow(database, weekStart),
    resurfaced: db.oldestWaiting(database),
    rhythm,
  });

  return htmlResponse(renderPage({ title: "Home", tab: "home", body }));
}
