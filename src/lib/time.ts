const MELB_TIME = new Intl.DateTimeFormat("en-AU", {
  timeZone: "Australia/Melbourne",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

/** Format a UTC Date as Melbourne local time "HH:MM:SS". */
export function toMelbourneTime(date: Date): string {
  const parts = MELB_TIME.formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "00";
  return `${get("hour")}:${get("minute")}:${get("second")}`;
}

/** Format a Date as an ISO calendar date "YYYY-MM-DD" in UTC. */
export function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

const MELB_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Australia/Melbourne",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Format a UTC Date as its Melbourne-local calendar date "YYYY-MM-DD". */
export function toMelbourneDate(date: Date): string {
  return MELB_DATE.format(date);
}

/**
 * Add whole days to an ISO calendar date string.
 *
 * @param isoDate - Calendar date "YYYY-MM-DD".
 * @param days - Day delta; may be negative.
 * @returns The shifted calendar date "YYYY-MM-DD".
 */
export function addDaysToIsoDate(isoDate: string, days: number): string {
  const [y = 0, m = 1, d = 1] = isoDate.split("-").map(Number);
  return toIsoDate(new Date(Date.UTC(y, m - 1, d + days)));
}
