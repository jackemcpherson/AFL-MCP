import type { PlayerStats } from "fitzroy";
import { fetchPlayerStats } from "fitzroy";
import { normaliseTeam } from "../lib/normalise";
import { acquireOperationLease, releaseOperationLease } from "../sync/lease";
import { logSync } from "../sync/log";
import type { Env } from "../types";

const UPDATE_BATCH_SIZE = 100;

/** D1 match fields needed by Brownlow resolution. */
export interface BrownlowMatchRecord {
  readonly matchId: number;
  readonly date: string;
  readonly roundType: string;
  readonly homeTeamId: number;
  readonly homeTeam: string;
  readonly awayTeamId: number;
  readonly awayTeam: string;
}

/** D1 player-match fields needed by Brownlow resolution. */
export interface BrownlowPlayerRecord {
  readonly matchId: number;
  readonly teamId: number;
  readonly playerId: number;
  readonly givenName: string | null;
  readonly surname: string;
}

/** Sanitized resolution counters returned to operators. */
export interface BrownlowResolutionCounts {
  exact: number;
  normalized: number;
  surname: number;
  seasonFallback: number;
  unresolvedMatch: number;
  unresolvedPlayer: number;
  ambiguous: number;
}

/** Sanitized regular-match invariant counters returned to operators. */
export interface BrownlowMatchTotals {
  zero: number;
  six: number;
  other: number;
}

/** Sanitized outcome for one requested season. */
export interface BrownlowSeasonSummary {
  readonly year: number;
  readonly upstreamRows: number;
  readonly failedMatchCount: number;
  readonly positiveVoteRows: number;
  readonly resolution: BrownlowResolutionCounts;
  readonly regularMatchTotals: BrownlowMatchTotals;
  readonly eligible: boolean;
  readonly notPublished: boolean;
  readonly updated: number;
}

/** Parameterized D1 update intent for one resolved player-match vote. */
export interface BrownlowVoteUpdate {
  readonly matchId: number;
  readonly playerId: number;
  readonly votes: number;
}

interface ResolvedSeason {
  readonly summary: BrownlowSeasonSummary;
  readonly writes: readonly BrownlowVoteUpdate[];
}

/** Complete response body for an annual Brownlow operation. */
export interface BrownlowBackfillResponse {
  readonly status: "ok" | "blocked";
  readonly dryRun: boolean;
  readonly seasons: readonly BrownlowSeasonSummary[];
}

/**
 * Resolves an annual Brownlow result without performing I/O.
 *
 * @param year - AFLM season year.
 * @param stats - AFL Tables season stat rows.
 * @param failedMatchCount - Number of upstream match pages that failed.
 * @param matches - D1 AFLM matches for the season.
 * @param players - D1 player-match roster rows for the season.
 * @returns Sanitized invariant summary plus guarded write intents.
 */
export function resolveBrownlowSeason(
  year: number,
  stats: readonly PlayerStats[],
  failedMatchCount: number,
  matches: readonly BrownlowMatchRecord[],
  players: readonly BrownlowPlayerRecord[],
): ResolvedSeason {
  const resolution: BrownlowResolutionCounts = {
    exact: 0,
    normalized: 0,
    surname: 0,
    seasonFallback: 0,
    unresolvedMatch: 0,
    unresolvedPlayer: 0,
    ambiguous: 0,
  };
  const matchIndex = buildMultiMap(matches.flatMap(matchTeamKeys));
  const playersByMatchTeam = buildMultiMap(
    players.map((player) => [`${player.matchId}|${player.teamId}`, player] as const),
  );
  const seasonNames = new Map<string, Set<number>>();
  for (const player of players) {
    const key = exactNameKey(player.givenName ?? "", player.surname);
    const ids = seasonNames.get(key) ?? new Set<number>();
    ids.add(player.playerId);
    seasonNames.set(key, ids);
  }

  const regularTotals = new Map<number, number>();
  for (const match of matches) {
    if (match.roundType === "Regular") regularTotals.set(match.matchId, 0);
  }

  const writes: BrownlowVoteUpdate[] = [];
  let positiveVoteRows = 0;
  let finalsVoteRows = 0;
  for (const stat of stats) {
    const votes = stat.brownlowVotes ?? 0;
    if (votes <= 0) continue;
    positiveVoteRows++;

    const matchDate = extractMatchDate(stat.matchId);
    const matchCandidates =
      matchDate === null ? [] : (matchIndex.get(`${matchDate}|${teamKey(stat.team)}`) ?? []);
    if (matchCandidates.length === 0) {
      resolution.unresolvedMatch++;
      continue;
    }
    if (matchCandidates.length > 1) {
      resolution.ambiguous++;
      continue;
    }
    const match = matchCandidates[0];
    if (!match) continue;
    const teamId =
      teamKey(match.homeTeam) === teamKey(stat.team) ? match.homeTeamId : match.awayTeamId;
    const candidates = playersByMatchTeam.get(`${match.matchId}|${teamId}`) ?? [];
    const playerId = resolvePlayer(stat, candidates, seasonNames, resolution);
    if (playerId === null) continue;

    if (match.roundType !== "Regular") {
      finalsVoteRows++;
    } else {
      regularTotals.set(match.matchId, (regularTotals.get(match.matchId) ?? 0) + votes);
    }
    writes.push({ matchId: match.matchId, playerId, votes });
  }

  const regularMatchTotals: BrownlowMatchTotals = { zero: 0, six: 0, other: 0 };
  for (const total of regularTotals.values()) {
    if (total === 0) regularMatchTotals.zero++;
    else if (total === 6) regularMatchTotals.six++;
    else regularMatchTotals.other++;
  }
  const notPublished = positiveVoteRows === 0;
  const eligible =
    !notPublished &&
    failedMatchCount === 0 &&
    resolution.unresolvedMatch === 0 &&
    resolution.unresolvedPlayer === 0 &&
    resolution.ambiguous === 0 &&
    finalsVoteRows === 0 &&
    regularMatchTotals.six > 0 &&
    regularMatchTotals.zero === 0 &&
    regularMatchTotals.other === 0;

  return {
    summary: {
      year,
      upstreamRows: stats.length,
      failedMatchCount,
      positiveVoteRows,
      resolution,
      regularMatchTotals,
      eligible,
      notPublished,
      updated: 0,
    },
    writes: eligible ? writes : [],
  };
}

/**
 * Fetches, resolves, and optionally writes Brownlow votes for up to two seasons.
 *
 * @param env - Worker bindings.
 * @param fromYear - First AFLM season, inclusive.
 * @param toYear - Final AFLM season, inclusive.
 * @param dryRun - When true, validates without updating D1.
 * @returns HTTP status and exact sanitized response body.
 * @throws When upstream or D1 access fails; callers map this to sanitized 500.
 */
export async function backfillBrownlow(
  env: Env,
  fromYear: number,
  toYear: number,
  dryRun: boolean,
): Promise<{ readonly httpStatus: 200 | 409; readonly body: BrownlowBackfillResponse }> {
  const holder = crypto.randomUUID();
  if (!(await acquireOperationLease(env, holder))) {
    return {
      httpStatus: 409,
      body: { status: "blocked", dryRun, seasons: [] },
    };
  }

  try {
    const resolved: ResolvedSeason[] = [];
    for (let year = fromYear; year <= toYear; year++) {
      const result = await fetchPlayerStats({
        source: "afl-tables",
        season: year,
        competition: "AFLM",
      });
      if (!result.success) {
        await logSync(env, "admin:brownlow-backfill", 0, "failed:upstream");
        throw new Error("Brownlow upstream fetch failed");
      }
      const [matches, players] = await loadSeasonRecords(env, year);
      resolved.push(
        resolveBrownlowSeason(
          year,
          result.data.stats,
          result.data.failedMatchIds.length,
          matches,
          players,
        ),
      );
    }

    if (
      resolved.some(
        ({ summary }) =>
          summary.failedMatchCount > 0 || (!summary.eligible && !summary.notPublished),
      )
    ) {
      for (const { summary } of resolved) {
        await logSync(env, "admin:brownlow-backfill", 0, blockedCode(summary));
      }
      return {
        httpStatus: 409,
        body: { status: "blocked", dryRun, seasons: resolved.map(({ summary }) => summary) },
      };
    }

    if (dryRun) {
      return {
        httpStatus: 200,
        body: { status: "ok", dryRun, seasons: resolved.map(({ summary }) => summary) },
      };
    }

    const summaries: BrownlowSeasonSummary[] = [];
    for (const season of resolved) {
      const updated = await applyBrownlowUpdates(env.DB, season.writes);
      const summary = { ...season.summary, updated };
      summaries.push(summary);
      if (!summary.notPublished) {
        await logSync(env, "admin:brownlow-backfill", updated);
      }
    }
    return { httpStatus: 200, body: { status: "ok", dryRun, seasons: summaries } };
  } finally {
    await releaseOperationLease(env, holder);
  }
}

/**
 * Applies resolved Brownlow vote updates in bounded, parameterized D1 batches.
 *
 * @param db - D1 database binding.
 * @param writes - Fully resolved player-match vote updates.
 * @returns Sum of D1 `meta.changes` across every submitted statement.
 */
export async function applyBrownlowUpdates(
  db: D1Database,
  writes: readonly BrownlowVoteUpdate[],
): Promise<number> {
  let updated = 0;
  for (let i = 0; i < writes.length; i += UPDATE_BATCH_SIZE) {
    const statements = writes.slice(i, i + UPDATE_BATCH_SIZE).map((write) =>
      db
        .prepare(
          `UPDATE player_match_stats SET brownlow_votes = ?1
           WHERE match_id = ?2 AND player_id = ?3
             AND (brownlow_votes IS NULL OR brownlow_votes = 0)`,
        )
        .bind(write.votes, write.matchId, write.playerId),
    );
    const results = await db.batch(statements);
    for (const result of results) updated += result.meta.changes;
  }
  return updated;
}

async function loadSeasonRecords(
  env: Env,
  year: number,
): Promise<[BrownlowMatchRecord[], BrownlowPlayerRecord[]]> {
  return Promise.all([
    env.DB.prepare(
      `SELECT m.id AS matchId, m.date, m.round_type AS roundType,
              ht.id AS homeTeamId, ht.name AS homeTeam,
              at.id AS awayTeamId, at.name AS awayTeam
       FROM matches m
       JOIN seasons s ON s.id = m.season_id
       JOIN competitions c ON c.id = s.competition_id
       JOIN teams ht ON ht.id = m.home_team_id
       JOIN teams at ON at.id = m.away_team_id
       WHERE c.code = 'AFLM' AND s.year = ?1`,
    )
      .bind(year)
      .all<BrownlowMatchRecord>()
      .then(({ results }) => results),
    env.DB.prepare(
      `SELECT pms.match_id AS matchId, pms.team_id AS teamId,
              p.id AS playerId, p.first_name AS givenName, p.surname
       FROM player_match_stats pms
       JOIN players p ON p.id = pms.player_id
       JOIN matches m ON m.id = pms.match_id
       JOIN seasons s ON s.id = m.season_id
       JOIN competitions c ON c.id = s.competition_id
       WHERE c.code = 'AFLM' AND s.year = ?1`,
    )
      .bind(year)
      .all<BrownlowPlayerRecord>()
      .then(({ results }) => results),
  ]);
}

function resolvePlayer(
  stat: PlayerStats,
  candidates: readonly BrownlowPlayerRecord[],
  seasonNames: ReadonlyMap<string, ReadonlySet<number>>,
  counts: BrownlowResolutionCounts,
): number | null {
  const exact = candidates.filter(
    (candidate) =>
      exactNameKey(candidate.givenName ?? "", candidate.surname) ===
      exactNameKey(stat.givenName, stat.surname),
  );
  if (exact.length === 1) {
    counts.exact++;
    return exact[0]?.playerId ?? null;
  }
  if (exact.length > 1) {
    counts.ambiguous++;
    return null;
  }

  const normalized = candidates.filter(
    (candidate) =>
      normalizedName(candidate.givenName ?? "") === normalizedName(stat.givenName) &&
      normalizedName(candidate.surname) === normalizedName(stat.surname),
  );
  if (normalized.length === 1) {
    counts.normalized++;
    return normalized[0]?.playerId ?? null;
  }
  if (normalized.length > 1) {
    counts.ambiguous++;
    return null;
  }

  const surname = candidates.filter(
    (candidate) => normalizedName(candidate.surname) === normalizedName(stat.surname),
  );
  const upstreamGiven = normalizedName(stat.givenName);
  const prefix = surname.filter((candidate) => {
    const candidateGiven = normalizedName(candidate.givenName ?? "");
    return candidateGiven.startsWith(upstreamGiven) || upstreamGiven.startsWith(candidateGiven);
  });
  if (prefix.length === 1) {
    counts.surname++;
    return prefix[0]?.playerId ?? null;
  }
  const stem = surname.filter(
    (candidate) =>
      normalizedName(candidate.givenName ?? "").slice(0, 3) === upstreamGiven.slice(0, 3),
  );
  if (stem.length === 1 && upstreamGiven.length >= 3) {
    counts.surname++;
    return stem[0]?.playerId ?? null;
  }
  if (prefix.length > 1 || stem.length > 1 || surname.length > 1) {
    counts.ambiguous++;
    return null;
  }

  const seasonIds = seasonNames.get(exactNameKey(stat.givenName, stat.surname));
  if (seasonIds?.size === 1) {
    const playerId = seasonIds.values().next().value;
    if (playerId === undefined) {
      counts.unresolvedPlayer++;
      return null;
    }
    counts.seasonFallback++;
    return playerId;
  }
  if (seasonIds && seasonIds.size > 1) counts.ambiguous++;
  else counts.unresolvedPlayer++;
  return null;
}

function matchTeamKeys(
  match: BrownlowMatchRecord,
): readonly (readonly [string, BrownlowMatchRecord])[] {
  return [
    [`${match.date}|${teamKey(match.homeTeam)}`, match],
    [`${match.date}|${teamKey(match.awayTeam)}`, match],
  ];
}

function buildMultiMap<K, V>(entries: readonly (readonly [K, V])[]): Map<K, V[]> {
  const map = new Map<K, V[]>();
  for (const [key, value] of entries) {
    const values = map.get(key) ?? [];
    values.push(value);
    map.set(key, values);
  }
  return map;
}

function teamKey(team: string): string {
  return normaliseTeam(team).toLocaleLowerCase();
}

function exactNameKey(givenName: string, surname: string): string {
  return `${givenName.trim()}|${surname.trim()}`;
}

function normalizedName(name: string): string {
  return name.toLocaleLowerCase().replace(/[^a-z0-9]/g, "");
}

function extractMatchDate(matchId: string): string | null {
  const matched = /(\d{4})(\d{2})(\d{2})$/.exec(matchId);
  return matched ? `${matched[1]}-${matched[2]}-${matched[3]}` : null;
}

function blockedCode(summary: BrownlowSeasonSummary): string {
  if (summary.failedMatchCount > 0) return "blocked:partial-fetch";
  return "blocked:resolution";
}
