export const ZONE_COOKIE = "ch_tz";

export interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

export function serverZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function formatter(zone: string): Intl.DateTimeFormat | null {
  const known = formatters.get(zone);

  if (known) return known;

  try {
    const made = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });

    formatters.set(zone, made);

    return made;
  } catch {
    return null;
  }
}

export function validZone(zone: string): boolean {
  return zone !== "" && formatter(zone) !== null;
}

export function zoneOr(zone: string): string {
  return validZone(zone) ? zone : serverZone();
}

interface ZonedTime extends WallClock {
  minute: number;
  second: number;
}

function zoned(ms: number, zone: string): ZonedTime {
  const t: ZonedTime = { year: 1970, month: 1, day: 1, hour: 0, minute: 0, second: 0 };

  for (const part of (formatter(zone) ?? formatter(serverZone()))?.formatToParts(ms) ?? []) {
    const value = Number(part.value);

    if (part.type === "year") t.year = value;
    else if (part.type === "month") t.month = value;
    else if (part.type === "day") t.day = value;
    else if (part.type === "hour") t.hour = value;
    else if (part.type === "minute") t.minute = value;
    else if (part.type === "second") t.second = value;
  }

  return t;
}

export function wallClock(ms: number, zone: string): WallClock {
  const { year, month, day, hour } = zoned(ms, zone);

  return { year, month, day, hour };
}

function offsetMs(ms: number, zone: string): number {
  const t = zoned(ms, zone);

  return (
    Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second) - Math.floor(ms / 1000) * 1000
  );
}

export function localMidnight(ms: number, zone: string, daysBack = 0): number {
  const today = wallClock(ms, zone);
  const naive = Date.UTC(today.year, today.month - 1, today.day - daysBack);
  let guess = naive - offsetMs(naive, zone);

  guess = naive - offsetMs(guess, zone);

  return guess;
}

export function isoDay(ms: number, zone: string): string {
  const { year, month, day } = wallClock(ms, zone);

  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
