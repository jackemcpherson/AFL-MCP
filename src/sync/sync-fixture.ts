import type { Fixture } from "fitzroy";
import { fetchFixture } from "fitzroy";
import { COMPETITION_CODE } from "../lib/constants";
import { normaliseTeam, normaliseVenue } from "../lib/normalise";
import { toMelbourneTime } from "../lib/time";
import type { Env } from "../types";
import { logSync } from "./log";
import { buildLookupMap } from "./sync-matches";

function fixtureRoundCode(f: Fixture): string {
  if (f.roundNumber === 0) return "Opening Round";
  if (f.roundType === "Finals") return `F${f.roundNumber}`;
  return `R${f.roundNumber}`;
}

function fixtureRoundType(f: Fixture): string {
  if (f.roundType === "HomeAndAway") return "Regular";
  if (f.roundType === "Finals") return "Finals";
  return f.roundType;
}

export async function syncFixture(env: Env): Promise<void> {
  const currentYear = new Date().getFullYear();

  try {
    const result = await fetchFixture({
      source: "afl-api",
      season: currentYear,
      competition: COMPETITION_CODE,
    });

    if (!result.success) {
      const detail = result.error instanceof Error ? result.error.message : String(result.error);
      await logSync(env, "sync_fixture", 0, `fetchFixture failed: ${detail}`);
      return;
    }

    const fixtures = result.data;
    if (fixtures.length === 0) return;

    const competition = await env.DB.prepare("SELECT id FROM competitions WHERE code = ?")
      .bind(COMPETITION_CODE)
      .first<{ id: number }>();

    if (!competition) return;

    const season = await env.DB.prepare(
      "SELECT id FROM seasons WHERE competition_id = ? AND year = ?",
    )
      .bind(competition.id, currentYear)
      .first<{ id: number }>();

    if (!season) return;

    const teamNames = new Set<string>();
    const venueNames = new Set<string>();
    for (const f of fixtures) {
      teamNames.add(normaliseTeam(f.homeTeam));
      teamNames.add(normaliseTeam(f.awayTeam));
      venueNames.add(normaliseVenue(f.venue));
    }

    if (teamNames.size > 0) {
      const stmts = Array.from(teamNames).map((name) =>
        env.DB.prepare("INSERT OR IGNORE INTO teams (name, competition_id) VALUES (?, ?)").bind(
          name,
          competition.id,
        ),
      );
      await env.DB.batch(stmts);
    }

    if (venueNames.size > 0) {
      const stmts = Array.from(venueNames).map((name) =>
        env.DB.prepare("INSERT OR IGNORE INTO venues (name) VALUES (?)").bind(name),
      );
      await env.DB.batch(stmts);
    }

    const teamIdMap = await buildLookupMap(env, "teams");
    const venueIdMap = await buildLookupMap(env, "venues");

    let totalAffected = 0;
    for (let i = 0; i < fixtures.length; i += 500) {
      const chunk = fixtures.slice(i, i + 500);
      const stmts = chunk.map((f) => buildFixtureUpsert(env, f, season.id, teamIdMap, venueIdMap));
      const results = await env.DB.batch(stmts);
      totalAffected += results.filter((r) => r.success).length;
    }

    await logSync(env, "sync_fixture", totalAffected);
  } catch (err) {
    await logSync(env, "sync_fixture", 0, err instanceof Error ? err.message : String(err));
  }
}

function buildFixtureUpsert(
  env: Env,
  f: Fixture,
  seasonId: number,
  teamIdMap: Map<string, number>,
  venueIdMap: Map<string, number>,
): D1PreparedStatement {
  const homeTeam = normaliseTeam(f.homeTeam);
  const awayTeam = normaliseTeam(f.awayTeam);
  const venue = normaliseVenue(f.venue);

  const homeTeamId = teamIdMap.get(homeTeam) ?? null;
  const awayTeamId = teamIdMap.get(awayTeam) ?? null;
  const venueId = venueIdMap.get(venue) ?? null;
  const dateStr = f.date.toISOString().slice(0, 10);
  const localTime = toMelbourneTime(f.date);

  return env.DB.prepare(
    `INSERT INTO matches (
      external_afl_id, season_id, round_number, round_type, round,
      date, local_time, venue_id, home_team_id, away_team_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (date, home_team_id, away_team_id) DO UPDATE SET
      external_afl_id = COALESCE(excluded.external_afl_id, matches.external_afl_id),
      round_number = excluded.round_number,
      round_type = excluded.round_type,
      round = excluded.round,
      local_time = excluded.local_time,
      venue_id = excluded.venue_id`,
  ).bind(
    f.matchId,
    seasonId,
    f.roundNumber,
    fixtureRoundType(f),
    fixtureRoundCode(f),
    dateStr,
    localTime,
    venueId,
    homeTeamId,
    awayTeamId,
  );
}
