import { env } from "cloudflare:test";
import type { Match } from "fitzroy";
import { expect, it } from "vitest";
import { isHourlyTick } from "../../src/sync/sync";
import {
  ensureCompetition,
  ensureSeason,
  ensureTeams,
  ensureVenues,
  updateSeasonCompleteness,
  upsertMatches,
} from "../../src/sync/upserts";
import { makeMatch } from "#test/factories";

async function completenessOf(matches: readonly Match[]): Promise<unknown> {
  const competitionId = await ensureCompetition(env, "AFLM");
  const seasonId = await ensureSeason(env, competitionId, 2026);
  const teamMap = await ensureTeams(env, competitionId, "AFLM", matches);
  const venueMap = await ensureVenues(env, matches);
  await upsertMatches(env, matches, { seasonId, teamMap, venueMap });
  await updateSeasonCompleteness(env, seasonId);
  return env.DB.prepare("SELECT is_complete FROM seasons WHERE id=?1")
    .bind(seasonId)
    .first("is_complete");
}

const played = makeMatch({ matchId: "M-1", date: new Date("2026-03-20T08:00:00Z") });
const unscored = { homePoints: null, awayPoints: null, margin: null };

it("is not complete without matches", async () => {
  expect(await completenessOf([])).toBe(0);
});

it("is complete when every match is played", async () => {
  expect(await completenessOf([played])).toBe(1);
});

it("is complete when the only unplayed match was cancelled", async () => {
  const cancelled = makeMatch({
    ...unscored,
    matchId: "M-2",
    date: new Date("2026-03-27T08:00:00Z"),
    status: "Cancelled",
  });
  expect(await completenessOf([played, cancelled])).toBe(1);
});

it("stays open while a match is upcoming", async () => {
  const upcoming = makeMatch({
    ...unscored,
    matchId: "M-2",
    date: new Date("2026-03-27T08:00:00Z"),
    status: "Upcoming",
  });
  expect(await completenessOf([played, upcoming])).toBe(0);
});

it("stays open while the last match is live with a partial score", async () => {
  const live = makeMatch({
    matchId: "M-2",
    date: new Date("2026-03-27T08:00:00Z"),
    status: "Live",
  });
  expect(await completenessOf([played, live])).toBe(0);
});

it("runs the hourly stages for the hour a tick was scheduled in", () => {
  expect(isHourlyTick(new Date("2026-07-13T02:00:00Z"))).toBe(true);
  expect(isHourlyTick(new Date("2026-07-13T02:00:59Z"))).toBe(true);
  expect(isHourlyTick(new Date("2026-07-13T02:05:00Z"))).toBe(false);
});
