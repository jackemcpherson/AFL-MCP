import type { Match } from "fitzroy";
import { fetchMatches, fetchPlayerStats } from "fitzroy";
import { COMPETITION_CODE } from "../lib/constants";
import { normaliseTeam, normaliseVenue } from "../lib/normalise";
import { toMelbourneTime } from "../lib/time";
import type { Env } from "../types";
import { logSync } from "./log";
import { getPlayerIdMap, syncPlayers } from "./sync-players";
import { syncStats } from "./sync-stats";

function mapRoundType(roundType: string): string {
  if (roundType === "HomeAndAway") return "Regular";
  if (roundType === "Finals") return "Finals";
  return roundType;
}

export async function syncNewData(env: Env): Promise<void> {
  const currentYear = new Date().getFullYear();

  try {
    const matchResult = await fetchMatches({
      source: "afl-api",
      season: currentYear,
      competition: COMPETITION_CODE,
      status: "Complete",
    });

    if (!matchResult.success) {
      const detail =
        matchResult.error instanceof Error ? matchResult.error.message : String(matchResult.error);
      await logSync(env, "sync_matches", 0, `fetchMatches failed: ${detail}`);
      return;
    }

    const matches = matchResult.data;

    await env.DB.prepare("INSERT OR IGNORE INTO competitions (code, name) VALUES (?, ?)")
      .bind(COMPETITION_CODE, "AFL Men's")
      .run();

    const competition = await env.DB.prepare("SELECT id FROM competitions WHERE code = ?")
      .bind(COMPETITION_CODE)
      .first<{ id: number }>();

    if (!competition) {
      await logSync(env, "sync_matches", 0, "Competition not found after insert");
      return;
    }

    await env.DB.prepare("INSERT OR IGNORE INTO seasons (competition_id, year) VALUES (?, ?)")
      .bind(competition.id, currentYear)
      .run();

    const season = await env.DB.prepare(
      "SELECT id FROM seasons WHERE competition_id = ? AND year = ?",
    )
      .bind(competition.id, currentYear)
      .first<{ id: number }>();

    if (!season) {
      await logSync(env, "sync_matches", 0, "Season not found after insert");
      return;
    }

    const teamNames = new Set<string>();
    const venueNames = new Set<string>();

    for (const m of matches) {
      teamNames.add(normaliseTeam(m.homeTeam));
      teamNames.add(normaliseTeam(m.awayTeam));
      venueNames.add(normaliseVenue(m.venue));
    }

    if (teamNames.size > 0) {
      const teamStmts = Array.from(teamNames).map((name) =>
        env.DB.prepare("INSERT OR IGNORE INTO teams (name, competition_id) VALUES (?, ?)").bind(
          name,
          competition.id,
        ),
      );
      await env.DB.batch(teamStmts);
    }

    if (venueNames.size > 0) {
      const venueStmts = Array.from(venueNames).map((name) =>
        env.DB.prepare("INSERT OR IGNORE INTO venues (name) VALUES (?)").bind(name),
      );
      await env.DB.batch(venueStmts);
    }

    const teamIdMap = await buildLookupMap(env, "teams");
    const venueIdMap = await buildLookupMap(env, "venues");

    let matchesAffected = 0;
    for (let i = 0; i < matches.length; i += 500) {
      const chunk = matches.slice(i, i + 500);
      const stmts = chunk.map((m) => buildMatchUpsert(env, m, season.id, teamIdMap, venueIdMap));
      const results = await env.DB.batch(stmts);
      matchesAffected += results.filter((r) => r.success).length;
    }

    await logSync(env, "sync_matches", matchesAffected);

    const statsResult = await fetchPlayerStats({
      source: "afl-api",
      season: currentYear,
      competition: COMPETITION_CODE,
    });

    if (!statsResult.success) {
      const detail =
        statsResult.error instanceof Error ? statsResult.error.message : String(statsResult.error);
      await logSync(env, "sync_stats", 0, `fetchPlayerStats failed: ${detail}`);
      return;
    }

    const playerStats = statsResult.data;

    const playersAffected = await syncPlayers(env, playerStats);
    await logSync(env, "sync_players", playersAffected);

    const playerIdMap = await getPlayerIdMap(env);

    const statsAffected = await syncStats(env, playerStats, teamIdMap, playerIdMap);
    await logSync(env, "sync_stats", statsAffected);
  } catch (err) {
    await logSync(env, "sync_matches", 0, err instanceof Error ? err.message : String(err));
  }
}

export async function buildLookupMap(env: Env, table: string): Promise<Map<string, number>> {
  const { results } = await env.DB.prepare(`SELECT id, name FROM ${table}`).all<{
    id: number;
    name: string;
  }>();

  const map = new Map<string, number>();
  for (const r of results) {
    map.set(r.name, r.id);
  }
  return map;
}

function buildMatchUpsert(
  env: Env,
  m: Match,
  seasonId: number,
  teamIdMap: Map<string, number>,
  venueIdMap: Map<string, number>,
): D1PreparedStatement {
  const homeTeam = normaliseTeam(m.homeTeam);
  const awayTeam = normaliseTeam(m.awayTeam);
  const venue = normaliseVenue(m.venue);

  const homeTeamId = teamIdMap.get(homeTeam) ?? null;
  const awayTeamId = teamIdMap.get(awayTeam) ?? null;
  const venueId = venueIdMap.get(venue) ?? null;
  const dateStr = m.date.toISOString().slice(0, 10);
  const localTime = toMelbourneTime(m.date);

  return env.DB.prepare(
    `INSERT INTO matches (
      external_afl_id, season_id, round_number, round_type, round,
      date, local_time, venue_id, home_team_id, away_team_id,
      home_goals, home_behinds, home_points,
      away_goals, away_behinds, away_points,
      margin, attendance,
      home_rushed_behinds, away_rushed_behinds,
      home_minutes_in_front, away_minutes_in_front,
      home_q1_goals, home_q1_behinds,
      home_q2_goals, home_q2_behinds,
      home_q3_goals, home_q3_behinds,
      home_q4_goals, home_q4_behinds,
      away_q1_goals, away_q1_behinds,
      away_q2_goals, away_q2_behinds,
      away_q3_goals, away_q3_behinds,
      away_q4_goals, away_q4_behinds,
      weather_temp_c, weather_type
    ) VALUES (
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?,
      ?, ?,
      ?, ?,
      ?, ?,
      ?, ?,
      ?, ?,
      ?, ?,
      ?, ?,
      ?, ?,
      ?, ?,
      ?, ?,
      ?, ?,
      ?, ?
    )
    ON CONFLICT (date, home_team_id, away_team_id) DO UPDATE SET
      external_afl_id = excluded.external_afl_id,
      round_number = excluded.round_number,
      round_type = excluded.round_type,
      round = excluded.round,
      local_time = excluded.local_time,
      venue_id = excluded.venue_id,
      home_goals = excluded.home_goals,
      home_behinds = excluded.home_behinds,
      home_points = excluded.home_points,
      away_goals = excluded.away_goals,
      away_behinds = excluded.away_behinds,
      away_points = excluded.away_points,
      margin = excluded.margin,
      attendance = excluded.attendance,
      home_rushed_behinds = excluded.home_rushed_behinds,
      away_rushed_behinds = excluded.away_rushed_behinds,
      home_minutes_in_front = excluded.home_minutes_in_front,
      away_minutes_in_front = excluded.away_minutes_in_front,
      home_q1_goals = excluded.home_q1_goals,
      home_q1_behinds = excluded.home_q1_behinds,
      home_q2_goals = excluded.home_q2_goals,
      home_q2_behinds = excluded.home_q2_behinds,
      home_q3_goals = excluded.home_q3_goals,
      home_q3_behinds = excluded.home_q3_behinds,
      home_q4_goals = excluded.home_q4_goals,
      home_q4_behinds = excluded.home_q4_behinds,
      away_q1_goals = excluded.away_q1_goals,
      away_q1_behinds = excluded.away_q1_behinds,
      away_q2_goals = excluded.away_q2_goals,
      away_q2_behinds = excluded.away_q2_behinds,
      away_q3_goals = excluded.away_q3_goals,
      away_q3_behinds = excluded.away_q3_behinds,
      away_q4_goals = excluded.away_q4_goals,
      away_q4_behinds = excluded.away_q4_behinds,
      weather_temp_c = COALESCE(excluded.weather_temp_c, matches.weather_temp_c),
      weather_type = COALESCE(excluded.weather_type, matches.weather_type)`,
  ).bind(
    m.matchId,
    seasonId,
    m.roundNumber,
    mapRoundType(m.roundType),
    m.roundCode ?? m.roundName,
    dateStr,
    localTime,
    venueId,
    homeTeamId,
    awayTeamId,
    m.homeGoals,
    m.homeBehinds,
    m.homePoints,
    m.awayGoals,
    m.awayBehinds,
    m.awayPoints,
    m.margin,
    m.attendance,
    m.homeRushedBehinds,
    m.awayRushedBehinds,
    m.homeMinutesInFront,
    m.awayMinutesInFront,
    m.q1Home?.goals ?? null,
    m.q1Home?.behinds ?? null,
    m.q2Home?.goals ?? null,
    m.q2Home?.behinds ?? null,
    m.q3Home?.goals ?? null,
    m.q3Home?.behinds ?? null,
    m.q4Home?.goals ?? null,
    m.q4Home?.behinds ?? null,
    m.q1Away?.goals ?? null,
    m.q1Away?.behinds ?? null,
    m.q2Away?.goals ?? null,
    m.q2Away?.behinds ?? null,
    m.q3Away?.goals ?? null,
    m.q3Away?.behinds ?? null,
    m.q4Away?.goals ?? null,
    m.q4Away?.behinds ?? null,
    m.weatherTempCelsius ?? null,
    m.weatherType ?? null,
  );
}
