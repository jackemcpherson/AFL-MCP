import type { CompetitionCode, Match } from "fitzroy";
import { fetchLineup, fetchMatches, fetchPlayerStats } from "fitzroy";
import type { Env } from "../types";
import { logSync } from "./log";
import { recalculatePav } from "./pav";
import {
  buildMatchAflIdMap,
  ensureCompetition,
  ensureSeason,
  ensureTeams,
  ensureVenues,
  selectMaxCompletedDate,
  selectNextRound,
  unionPlayers,
  upsertLineups,
  upsertMatches,
  upsertPlayers,
  upsertStats,
} from "./upserts";

const FORWARD_DAYS = 3;
const BACKWARD_DAYS = 1;
const SOURCE = "afl-api" as const;

/**
 * The single sync entry point. Called from the scheduled() cron handler.
 * Defaults to AFLM only; pass additional competitions to extend coverage
 * (AFLW, VFL, VFLW) without changing any other code.
 */
export async function sync(env: Env, competitions: CompetitionCode[] = ["AFLM"]): Promise<void> {
  const now = new Date();
  if (!(await shouldRunNow(now, env))) return;

  for (const competition of competitions) {
    await syncCompetition(env, competition, now);
  }
}

/**
 * Cadence gate. Always runs at the top of the hour. Otherwise runs only when
 * a match is scheduled within ±a few days (date-granular: ~`BACKWARD_DAYS`
 * past + `FORWARD_DAYS` future). The forward window is wide enough to catch
 * Thursday-evening lineup releases for the upcoming weekend; the backward
 * window keeps polling through games that have just finished.
 */
export async function shouldRunNow(now: Date, env: Env): Promise<boolean> {
  if (now.getUTCMinutes() === 0) return true;
  const dayMs = 24 * 60 * 60 * 1000;
  const from = new Date(now.getTime() - BACKWARD_DAYS * dayMs).toISOString().slice(0, 10);
  const to = new Date(now.getTime() + FORWARD_DAYS * dayMs).toISOString().slice(0, 10);
  const row = await env.DB.prepare("SELECT 1 FROM matches WHERE date BETWEEN ?1 AND ?2 LIMIT 1")
    .bind(from, to)
    .first();
  return row !== null;
}

async function syncCompetition(env: Env, competition: CompetitionCode, now: Date): Promise<void> {
  const season = now.getUTCFullYear();

  try {
    const matchResult = await fetchMatches({ source: SOURCE, season, competition });
    if (!matchResult.success) {
      await logSync(
        env,
        `sync:${competition}`,
        0,
        `fetchMatches failed: ${describeError(matchResult.error)}`,
      );
      return;
    }
    const allMatches = matchResult.data;

    const competitionId = await ensureCompetition(env, competition);
    const seasonId = await ensureSeason(env, competitionId, season);

    const apiMaxCompleted = maxCompletedDate(allMatches);
    const dbMax = await selectMaxCompletedDate(env, seasonId);
    const newCompletedMatches =
      apiMaxCompleted !== null && (dbMax === null || apiMaxCompleted > dbMax);

    const nextRound = await selectNextRound(env, seasonId);
    const lineups =
      nextRound !== null ? await fetchLineupsSafe(env, competition, season, nextRound) : [];

    const stats = newCompletedMatches ? await fetchPlayerStatsSafe(env, competition, season) : [];

    if (allMatches.length === 0 && lineups.length === 0) return;

    const teamMap = await ensureTeams(env, competitionId, allMatches);
    const venueMap = await ensureVenues(env, allMatches);
    const playerMap = await upsertPlayers(env, unionPlayers(stats, lineups));

    const matchesAffected = await upsertMatches(env, allMatches, {
      seasonId,
      teamMap,
      venueMap,
    });
    const matchMap = await buildMatchAflIdMap(env, seasonId);

    let statsAffected = 0;
    let lineupsAffected = 0;
    if (stats.length > 0) {
      statsAffected = await upsertStats(env, stats, matchMap, playerMap, teamMap);
    }
    if (lineups.length > 0) {
      lineupsAffected = await upsertLineups(env, lineups, matchMap, playerMap, teamMap);
    }
    if (stats.length > 0) {
      await recalculatePav(env);
    }

    const didWork = statsAffected > 0 || lineupsAffected > 0;
    if (didWork) {
      await logSync(env, `sync:${competition}`, matchesAffected + statsAffected + lineupsAffected);
    }
  } catch (err) {
    await logSync(env, `sync:${competition}`, 0, describeError(err));
  }
}

function maxCompletedDate(matches: readonly Match[]): string | null {
  let max: string | null = null;
  for (const m of matches) {
    if (m.homePoints === null) continue;
    const d = m.date.toISOString().slice(0, 10);
    if (max === null || d > max) max = d;
  }
  return max;
}

async function fetchLineupsSafe(
  env: Env,
  competition: CompetitionCode,
  season: number,
  round: number,
) {
  const result = await fetchLineup({ source: SOURCE, season, round, competition });
  if (!result.success) {
    await logSync(
      env,
      `sync:${competition}:lineups`,
      0,
      `fetchLineup failed: ${describeError(result.error)}`,
    );
    return [];
  }
  return result.data;
}

async function fetchPlayerStatsSafe(env: Env, competition: CompetitionCode, season: number) {
  const result = await fetchPlayerStats({ source: SOURCE, season, competition });
  if (!result.success) {
    await logSync(
      env,
      `sync:${competition}:stats`,
      0,
      `fetchPlayerStats failed: ${describeError(result.error)}`,
    );
    return [];
  }
  return result.data;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
