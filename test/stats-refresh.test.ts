import { describe, expect, it } from "vitest";
import { nextStatsRefresh } from "../src/sync/stats-refresh";

const completed = new Date("2026-09-26T07:00:00Z");
const atDay = (day: number) => new Date(completed.getTime() + day * 86400000);

describe("statistics refresh schedule", () => {
  it("refreshes hourly for 48 hours, daily through day 14, and once on day 30", () => {
    expect(nextStatsRefresh(completed, completed, 0)).toBe("2026-09-26T08:00:00.000Z");
    expect(nextStatsRefresh(completed, atDay(2), 0)).toBe(atDay(3).toISOString());
    expect(nextStatsRefresh(completed, atDay(13), 0)).toBe(atDay(14).toISOString());
    expect(nextStatsRefresh(completed, atDay(14), 0)).toBe(atDay(30).toISOString());
    expect(nextStatsRefresh(completed, atDay(30), 0)).toBeNull();
  });
  it("backs off failures, including failed final fetches, with a 24-hour cap", () => {
    expect(nextStatsRefresh(completed, atDay(30), 1)).toBe("2026-10-26T08:00:00.000Z");
    expect(nextStatsRefresh(completed, atDay(30), 99)).toBe(atDay(31).toISOString());
  });
});
