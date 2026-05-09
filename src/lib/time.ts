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
