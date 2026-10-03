import { env } from "cloudflare:test";
import type { MatchCoachAssignment, MatchCoachFailure } from "fitzroy";
import { describe, expect, it } from "vitest";
import { reconcileBearsIdentity } from "../../src/admin/club-identities";
import { ingestMatchCoachResult } from "../../src/admin/coaching";
import { beginPublicInputWrite, finishPublicInputWrite } from "../../src/db/public-inputs";
import {
  ensureCompetition,
  ensureSeason,
  ensureTeams,
  ensureVenues,
  upsertMatches,
} from "../../src/sync/upserts";
import type { Env } from "../../src/types";
import { makeMatch } from "./_fixtures";

const dbEnv = env as Env;
const date = "2024-03-16";

function assignment(overrides: Partial<MatchCoachAssignment> = {}): MatchCoachAssignment {
  return {
    competition: "AFLM",
    season: 2024,
    team: "Carlton",
    coachId: "afl-tables:https://afltables.com/afl/stats/coaches/Coach_A.html",
    coachName: "Coach A",
    coachUrl: "https://afltables.com/afl/stats/coaches/Coach_A.html",
    matchId: "afl-tables:https://afltables.com/afl/stats/games/2024/030320240316.html",
    matchUrl: "https://afltables.com/afl/stats/games/2024/030320240316.html",
    date,
    homeTeam: "Carlton",
    awayTeam: "Richmond",
    homePoints: 81,
    awayPoints: 74,
    roundName: "Round 1",
    source: "afl-tables",
    ...overrides,
  };
}

async function seedMatch(matchId = "coach-test-match") {
  const competitionId = await ensureCompetition(dbEnv, "AFLM");
  const seasonId = await ensureSeason(dbEnv, competitionId, 2024);
  const match = makeMatch({
    matchId,
    season: 2024,
    date: new Date(`${date}T08:30:00Z`),
    homeTeam: "Carlton",
    awayTeam: "Richmond",
    homePoints: 81,
    awayPoints: 74,
  });
  const teamMap = await ensureTeams(dbEnv, competitionId, "AFLM", [match]);
  const venueMap = await ensureVenues(dbEnv, [match]);
  await upsertMatches(dbEnv, [match], { seasonId, teamMap, venueMap });
  return dbEnv.DB.prepare("SELECT id FROM matches WHERE date = ?1 AND home_team_id = ?2")
    .bind(date, teamMap.get("Carlton"))
    .first<{ id: number }>();
}

async function revision(): Promise<number> {
  const row = await dbEnv.DB.prepare(
    "SELECT revision FROM public_input_revision WHERE id = 1",
  ).first<{ revision: number }>();
  return row?.revision ?? -1;
}

describe("coaching ingestion on local D1", () => {
  it("marks multi-statement input writes without changing the meaningful revision", async () => {
    const initialRevision = await revision();
    await beginPublicInputWrite(dbEnv, new Date("2026-10-03T00:00:00Z"));
    const active = await dbEnv.DB.prepare(
      "SELECT revision, in_progress, write_started_at FROM public_input_revision WHERE id = 1",
    ).first<{ revision: number; in_progress: number; write_started_at: string | null }>();
    expect(active).toEqual({
      revision: initialRevision,
      in_progress: 1,
      write_started_at: "2026-10-03T00:00:00.000Z",
    });
    await finishPublicInputWrite(dbEnv);
    expect(await revision()).toBe(initialRevision);
  });

  it("resolves both participant teams, is idempotent, isolates secondary evidence, and preserves facts on partial failure", async () => {
    const match = await seedMatch();
    expect(match).not.toBeNull();
    const rows = [
      assignment({ team: "Carlton" }),
      assignment({
        team: "Richmond",
        coachId: "afl-tables:https://afltables.com/afl/stats/coaches/Coach_B.html",
        coachName: "Coach B",
        coachUrl: "https://afltables.com/afl/stats/coaches/Coach_B.html",
      }),
    ];
    const complete = { assignments: rows, completeness: { complete: true, failures: [] } };
    const first = await ingestMatchCoachResult(
      dbEnv,
      2024,
      "afl-tables",
      complete,
      false,
      "2026-10-03T00:00:00Z",
    );
    expect(first.resolved).toBe(2);
    expect(first.changed).toBe(2);
    const initialRevision = await revision();

    const again = await ingestMatchCoachResult(
      dbEnv,
      2024,
      "afl-tables",
      complete,
      false,
      "2026-10-04T00:00:00Z",
    );
    expect(again.changed).toBe(0);
    expect(await revision()).toBe(initialRevision);

    const secondary = rows.map((row) => ({
      ...row,
      source: "footywire" as const,
      coachId: row.coachId.replace("afl-tables:", "footywire:"),
      coachUrl: row.coachUrl.replace("afltables.com", "footywire.com"),
      matchId: row.matchId.replace("afl-tables:", "footywire:"),
      matchUrl: "https://www.footywire.com/afl/ft_match_statistics?mid=1",
    }));
    const preview = await ingestMatchCoachResult(
      dbEnv,
      2024,
      "footywire",
      { assignments: secondary, completeness: { complete: true, failures: [] } },
      true,
    );
    expect(preview).toMatchObject({ resolved: 2, conflicts: 2, changed: 0 });
    expect(await revision()).toBe(initialRevision);
    expect(await dbEnv.DB.prepare("SELECT COUNT(*) AS n FROM coach_observations").first()).toEqual({
      n: 2,
    });
    await ingestMatchCoachResult(
      dbEnv,
      2024,
      "footywire",
      { assignments: secondary, completeness: { complete: true, failures: [] } },
      false,
      "2026-10-05T00:00:00Z",
    );
    expect(await revision()).toBe(initialRevision);
    const observationCount = await dbEnv.DB.prepare(
      "SELECT COUNT(*) AS n FROM coach_observations",
    ).first<{ n: number }>();
    expect(observationCount?.n).toBe(4);

    const correctedCoach = assignment({
      coachId: "afl-tables:https://afltables.com/afl/stats/coaches/Coach_A_Corrected.html",
      coachName: "Corrected Coach A",
      coachUrl: "https://afltables.com/afl/stats/coaches/Coach_A_Corrected.html",
    });
    const secondCoach = rows[1];
    if (!secondCoach) throw new Error("missing second fixture coach");
    const correction = await ingestMatchCoachResult(
      dbEnv,
      2024,
      "afl-tables",
      {
        assignments: [correctedCoach, secondCoach],
        completeness: { complete: true, failures: [] },
      },
      false,
      "2026-10-05T12:00:00Z",
    );
    expect(correction.changed).toBe(1);
    expect(await revision()).toBe(initialRevision + 1);

    const failure: MatchCoachFailure = {
      url: "https://afltables.com/afl/stats/coaches/broken.html",
      reason: "fixture failure",
      scope: "coach:Coach B",
    };
    const partial = await ingestMatchCoachResult(
      dbEnv,
      2024,
      "afl-tables",
      { assignments: [correctedCoach], completeness: { complete: false, failures: [failure] } },
      false,
      "2026-10-06T00:00:00Z",
    );
    expect(partial.complete).toBe(false);
    const canonical = await dbEnv.DB.prepare(
      "SELECT mc.team_id, c.display_name FROM match_coaches mc JOIN coaches c ON c.id = mc.coach_id WHERE mc.match_id = ?1 ORDER BY mc.team_id",
    )
      .bind(match?.id ?? -1)
      .all<{ team_id: number; display_name: string }>();
    expect(canonical.results.map((row) => row.display_name).sort()).toEqual([
      "Coach B",
      "Corrected Coach A",
    ]);
    const page = await dbEnv.DB.prepare(
      "SELECT status, failure_count FROM coach_import_pages WHERE provider = 'afl-tables' AND season = 2024",
    ).first<{ status: string; failure_count: number }>();
    expect(page).toEqual({ status: "partial", failure_count: 1 });

    const authoritativeRemoval = await ingestMatchCoachResult(
      dbEnv,
      2024,
      "afl-tables",
      { assignments: [correctedCoach], completeness: { complete: true, failures: [] } },
      false,
      "2026-10-07T00:00:00Z",
    );
    expect(authoritativeRemoval.changed).toBe(1);
    const remaining = await dbEnv.DB.prepare(
      "SELECT team_id FROM match_coaches WHERE match_id = ?1",
    )
      .bind(match?.id ?? -1)
      .all<{ team_id: number }>();
    expect(remaining.results).toHaveLength(1);
  });

  it("rejects score conflicts and resolves fallback joins by both participants", async () => {
    const match = await seedMatch();
    const scoreConflict = await ingestMatchCoachResult(
      dbEnv,
      2024,
      "footywire",
      {
        assignments: [assignment({ source: "footywire", homePoints: 88, awayPoints: 74 })],
        completeness: { complete: true, failures: [] },
      },
      false,
    );
    expect(scoreConflict.unresolved).toBe(1);

    const second = makeMatch({
      matchId: "same-date-different-opponent",
      season: 2024,
      date: new Date(`${date}T10:30:00Z`),
      homeTeam: "Carlton",
      awayTeam: "Geelong",
    });
    const competitionId = await ensureCompetition(dbEnv, "AFLM");
    const seasonId = await ensureSeason(dbEnv, competitionId, 2024);
    const teamMap = await ensureTeams(dbEnv, competitionId, "AFLM", [second]);
    const venueMap = await ensureVenues(dbEnv, [second]);
    await upsertMatches(dbEnv, [second], { seasonId, teamMap, venueMap });
    const ambiguous = await ingestMatchCoachResult(
      dbEnv,
      2024,
      "footywire",
      {
        assignments: [
          assignment({
            source: "footywire",
            matchId: "footywire:unknown",
            matchUrl: "https://www.footywire.com/unknown",
          }),
        ],
        completeness: { complete: true, failures: [] },
      },
      false,
    );
    expect(ambiguous.unresolved).toBe(0);
    expect(ambiguous.resolved).toBe(1);
    const assignments = await dbEnv.DB.prepare("SELECT COUNT(*) AS n FROM match_coaches").first<{
      n: number;
    }>();
    expect(assignments?.n).toBe(0);
    expect(match).not.toBeNull();
    await dbEnv.DB.prepare(`INSERT INTO matches (season_id, round, date, home_team_id, away_team_id, home_points, away_points, status)
      SELECT season_id, round, date, away_team_id, home_team_id, away_points, home_points, status FROM matches WHERE id = ?1`)
      .bind(match?.id ?? -1)
      .run();
    const genuinelyAmbiguous = await ingestMatchCoachResult(
      dbEnv,
      2024,
      "footywire",
      {
        assignments: [
          assignment({
            source: "footywire",
            matchId: "footywire:ambiguous",
            matchUrl: "https://www.footywire.com/ambiguous",
          }),
        ],
        completeness: { complete: true, failures: [] },
      },
      false,
    );
    expect(genuinelyAmbiguous.unresolved).toBe(1);
    expect(genuinelyAmbiguous.resolved).toBe(0);
  });

  it("repairs historical Bears references without changing match IDs and is repeat-safe", async () => {
    const competitionId = await ensureCompetition(dbEnv, "AFLM");
    const seasonId = await ensureSeason(dbEnv, competitionId, 1996);
    const oldMatch = makeMatch({
      matchId: "legacy-bears",
      season: 1996,
      date: new Date("1996-04-01T08:00:00Z"),
      homeTeam: "Brisbane Lions",
    });
    const oldTeams = await ensureTeams(dbEnv, competitionId, "AFLM", [oldMatch]);
    const venues = await ensureVenues(dbEnv, [oldMatch]);
    await upsertMatches(dbEnv, [oldMatch], { seasonId, teamMap: oldTeams, venueMap: venues });
    const match = await dbEnv.DB.prepare("SELECT id FROM matches WHERE date = '1996-04-01'").first<{
      id: number;
    }>();

    const modernMatch = makeMatch({
      matchId: "modern-lions",
      season: 1997,
      date: new Date("1997-04-01T08:00:00Z"),
      homeTeam: "Brisbane Lions",
    });
    const modernTeams = await ensureTeams(dbEnv, competitionId, "AFLM", [modernMatch]);
    const lionsId = modernTeams.get("Brisbane Lions");
    const bearsId = oldTeams.get("Brisbane Bears");
    if (!match || !lionsId || !bearsId) throw new Error("team identity fixture setup failed");
    const player = await dbEnv.DB.prepare(
      "INSERT INTO players (surname) VALUES ('Fixture') RETURNING id",
    ).first<{ id: number }>();
    if (!player) throw new Error("player fixture setup failed");
    await dbEnv.DB.batch([
      dbEnv.DB.prepare("UPDATE matches SET home_team_id = ?1 WHERE id = ?2").bind(
        lionsId,
        match.id,
      ),
      dbEnv.DB.prepare(
        "INSERT INTO player_match_stats (match_id, player_id, team_id) VALUES (?1, ?2, ?3)",
      ).bind(match.id, player.id, lionsId),
      dbEnv.DB.prepare(
        "INSERT INTO match_lineups (match_id, player_id, team_id) VALUES (?1, ?2, ?3)",
      ).bind(match.id, player.id, lionsId),
      dbEnv.DB.prepare(
        "INSERT INTO player_season_pav (player_id, season_id, team_id) VALUES (?1, ?2, ?3)",
      ).bind(player.id, seasonId, lionsId),
    ]);

    const beforeRevision = await revision();
    const preview = await reconcileBearsIdentity(dbEnv, true);
    expect(preview.report?.affectedMatches).toBe(1);
    expect(preview.report?.playerStats).toBe(1);
    expect(preview.report?.lineups).toBe(1);
    expect(preview.report?.pavRows).toBe(1);
    expect(await revision()).toBe(beforeRevision);

    const applied = await reconcileBearsIdentity(dbEnv, false);
    expect(applied.report?.matchSides).toBe(1);
    const repaired = await dbEnv.DB.prepare(
      `SELECT m.id, m.home_team_id, pms.team_id AS stat_team_id, ml.team_id AS lineup_team_id, psp.team_id AS pav_team_id
       FROM matches m JOIN player_match_stats pms ON pms.match_id = m.id
       JOIN match_lineups ml ON ml.match_id = m.id
       JOIN player_season_pav psp ON psp.season_id = m.season_id
       WHERE m.id = ?1`,
    )
      .bind(match.id)
      .first<{
        id: number;
        home_team_id: number;
        stat_team_id: number;
        lineup_team_id: number;
        pav_team_id: number;
      }>();
    expect(repaired).toEqual({
      id: match.id,
      home_team_id: bearsId,
      stat_team_id: bearsId,
      lineup_team_id: bearsId,
      pav_team_id: bearsId,
    });
    expect(await revision()).toBeGreaterThan(beforeRevision);
    const repeated = await reconcileBearsIdentity(dbEnv, false);
    expect(repeated.report?.affectedMatches).toBe(0);
  });
});
