import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shouldRunNow } from "../../src/sync/sync";

async function seedMatchOnDate(dateYmd: string): Promise<void> {
  const competition = await env.DB.prepare(
    "SELECT id FROM competitions WHERE code = 'AFLM'",
  ).first<{
    id: number;
  }>();
  const competitionId = competition?.id;
  if (!competitionId) throw new Error("AFLM seed missing");

  await env.DB.prepare("INSERT OR IGNORE INTO seasons (competition_id, year) VALUES (?, ?)")
    .bind(competitionId, 2026)
    .run();
  const season = await env.DB.prepare(
    "SELECT id FROM seasons WHERE competition_id = ? AND year = ?",
  )
    .bind(competitionId, 2026)
    .first<{ id: number }>();

  for (const name of ["Carlton", "Richmond"]) {
    await env.DB.prepare("INSERT OR IGNORE INTO teams (name, competition_id) VALUES (?, ?)")
      .bind(name, competitionId)
      .run();
  }
  const teams = await env.DB.prepare("SELECT id, name FROM teams WHERE competition_id = ?")
    .bind(competitionId)
    .all<{ id: number; name: string }>();
  const home = teams.results.find((t) => t.name === "Carlton")?.id;
  const away = teams.results.find((t) => t.name === "Richmond")?.id;

  await env.DB.prepare(
    "INSERT INTO matches (season_id, round, round_number, date, home_team_id, away_team_id) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(season?.id, "R1", 1, dateYmd, home, away)
    .run();
}

describe("shouldRunNow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns true at the top of the hour regardless of fixture state", async () => {
    vi.setSystemTime(new Date("2026-05-09T12:00:00Z"));
    expect(await shouldRunNow(new Date(), env)).toBe(true);
  });

  it("returns false off-hour when no matches are nearby", async () => {
    vi.setSystemTime(new Date("2026-05-09T12:05:00Z"));
    expect(await shouldRunNow(new Date(), env)).toBe(false);
  });

  it("returns true off-hour when a match is scheduled within the forward window", async () => {
    vi.setSystemTime(new Date("2026-05-09T12:05:00Z"));
    // Match scheduled 2 days from now — inside the 3-day forward window.
    await seedMatchOnDate("2026-05-11");
    expect(await shouldRunNow(new Date(), env)).toBe(true);
  });

  it("returns true off-hour when a match was played yesterday", async () => {
    vi.setSystemTime(new Date("2026-05-09T12:05:00Z"));
    await seedMatchOnDate("2026-05-08");
    expect(await shouldRunNow(new Date(), env)).toBe(true);
  });

  it("returns false off-hour when matches are far outside the window", async () => {
    vi.setSystemTime(new Date("2026-05-09T12:05:00Z"));
    await seedMatchOnDate("2026-06-15"); // > 1 month away
    expect(await shouldRunNow(new Date(), env)).toBe(false);
  });

  it("does not depend on day-of-week or AEST/AEDT (a Tuesday match opens the window)", async () => {
    vi.setSystemTime(new Date("2026-05-09T12:05:00Z"));
    // Tuesday match (e.g. King's Birthday Eve) — the old isMatchWindow's
    // Thu-Sun gate would have rejected this; the new rule accepts it.
    await seedMatchOnDate("2026-05-12"); // a Tuesday
    expect(await shouldRunNow(new Date(), env)).toBe(true);
  });
});
