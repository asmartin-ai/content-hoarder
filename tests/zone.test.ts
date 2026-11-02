import { expect, test } from "bun:test";
import { dayTitle } from "../src/web/views/today.ts";
import { isoDay, localMidnight } from "../src/zone.ts";

const EVENING_IN_CHICAGO = Date.parse("2026-11-03T03:00:00Z");

test("the greeting follows the reader's time zone, not the server's", () => {
  const now = new Date(EVENING_IN_CHICAGO);

  expect(dayTitle(now, "America/Chicago")).toBe("Monday evening");
  expect(dayTitle(now, "Europe/London")).toBe("Tuesday, late");
  expect(dayTitle(now, "Asia/Tokyo")).toBe("Tuesday afternoon");
});

test("today starts at the reader's midnight, across a DST change", () => {
  expect(new Date(localMidnight(EVENING_IN_CHICAGO, "America/Chicago")).toISOString()).toBe(
    "2026-11-02T06:00:00.000Z",
  );
  expect(new Date(localMidnight(EVENING_IN_CHICAGO, "America/Chicago", 2)).toISOString()).toBe(
    "2026-10-31T05:00:00.000Z",
  );
  expect(new Date(localMidnight(EVENING_IN_CHICAGO, "Europe/London")).toISOString()).toBe(
    "2026-11-03T00:00:00.000Z",
  );
  expect(isoDay(EVENING_IN_CHICAGO, "America/Chicago")).toBe("2026-11-02");
  expect(isoDay(EVENING_IN_CHICAGO, "Asia/Tokyo")).toBe("2026-11-03");
});
