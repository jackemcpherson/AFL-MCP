import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));

import { type AdminStatusResponse, getAdminStatus } from "../../src/admin/status";
import worker from "../../src/index";
import type { Env } from "../../src/types";

const ADMIN_TOKEN = "status-admin-token";
const authedEnv: Env = { ...(env as Env), ADMIN_TOKEN };
const stubCtx = createExecutionContext();

function request(token: string | null = ADMIN_TOKEN): Request {
  const headers = new Headers();
  if (token !== null) headers.set("Authorization", `Bearer ${token}`);
  return new Request("https://afl.test/mcp/admin/status", { headers });
}

afterEach(async () => {
  await authedEnv.DB.prepare(
    "UPDATE sync_lease SET holder = NULL, acquired_at = NULL WHERE id = 1",
  ).run();
  vi.restoreAllMocks();
});

describe("GET /mcp/admin/status", () => {
  it("requires admin authentication", async () => {
    expect((await worker.fetch(request(null), authedEnv, stubCtx)).status).toBe(401);
    expect((await worker.fetch(request("wrong"), authedEnv, stubCtx)).status).toBe(401);
  });

  it("returns exact keys, stable competition order, and nulls for empty data", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const response = await worker.fetch(request(), authedEnv, stubCtx);
    expect(response.status).toBe(200);
    const body = (await response.json()) as AdminStatusResponse;
    expect(Object.keys(body)).toEqual([
      "status",
      "asOf",
      "lease",
      "competitions",
      "integrity",
      "degradation",
    ]);
    expect(body.status).toBe("ok");
    expect(body.lease).toEqual({ held: false, ageSeconds: null });
    expect(body.competitions.map((row: { code: string }) => row.code)).toEqual([
      "AFLM",
      "AFLW",
      "VFL",
      "VFLW",
    ]);
    expect(body.competitions[0]).toEqual({
      code: "AFLM",
      latestSyncAt: null,
      syncAgeSeconds: null,
      latestSuccessAt: null,
      successAgeSeconds: null,
      latestErrorAt: null,
      errorAgeSeconds: null,
      latestCompletedMatchDate: null,
    });
    expect(body.integrity).toEqual({
      disposals: 0,
      matchPoints: 0,
      quarterScores: 0,
      margin: 0,
      brownlow: 0,
    });
    expect(body.degradation).toEqual({
      windowHours: 24,
      partialLineupEvents: 0,
      partialStatsEvents: 0,
      unmappedTeamEvents: 0,
    });
    expect(JSON.stringify(body).length).toBeLessThan(16 * 1024);
  });

  it("ages whole-sync success and error independently and excludes subtasks", async () => {
    await authedEnv.DB.batch([
      authedEnv.DB.prepare(
        "INSERT INTO sync_log (timestamp, type, rows_affected, error) VALUES (?1, 'sync:AFLM', 1, NULL)",
      ).bind("2026-07-12T05:55:00.000Z"),
      authedEnv.DB.prepare(
        "INSERT INTO sync_log (timestamp, type, rows_affected, error) VALUES (?1, 'sync:AFLM', 0, 'bounded')",
      ).bind("2026-07-12T05:58:00.000Z"),
      authedEnv.DB.prepare(
        "INSERT INTO sync_log (timestamp, type, rows_affected, error) VALUES (?1, 'sync:AFLM:stats', 0, NULL)",
      ).bind("2026-07-12T05:59:00.000Z"),
    ]);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const body = await getAdminStatus(authedEnv, new Date("2026-07-12T06:00:00.000Z"));
    expect(body.competitions[0]).toMatchObject({
      latestSyncAt: "2026-07-12T05:58:00.000Z",
      syncAgeSeconds: 120,
      latestSuccessAt: "2026-07-12T05:55:00.000Z",
      successAgeSeconds: 300,
      latestErrorAt: "2026-07-12T05:58:00.000Z",
      errorAgeSeconds: 120,
    });
  });

  it("maps active and stale leases without exposing holders", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    await authedEnv.DB.prepare(
      "UPDATE sync_lease SET holder = 'holder-secret', acquired_at = ?1 WHERE id = 1",
    )
      .bind("2026-07-12T05:55:00.000Z")
      .run();
    const active = await getAdminStatus(authedEnv, new Date("2026-07-12T06:00:00.000Z"));
    expect(active.lease).toEqual({ held: true, ageSeconds: 300 });
    expect(JSON.stringify(active)).not.toContain("holder-secret");

    await authedEnv.DB.prepare("UPDATE sync_lease SET acquired_at = ?1 WHERE id = 1")
      .bind("2026-07-12T05:49:00.000Z")
      .run();
    const stale = await getAdminStatus(authedEnv, new Date("2026-07-12T06:00:00.000Z"));
    expect(stale.lease).toEqual({ held: false, ageSeconds: null });
  });

  it("reports latest completed match and all five integrity counts", async () => {
    await seedIntegrityViolations();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const body = await getAdminStatus(authedEnv, new Date("2026-07-12T06:00:00.000Z"));
    expect(body.competitions[0]?.latestCompletedMatchDate).toBe("2026-07-11");
    expect(body.integrity).toEqual({
      disposals: 1,
      matchPoints: 1,
      quarterScores: 1,
      margin: 1,
      brownlow: 1,
    });
  });

  it("counts only bounded 24-hour degradation categories and exposes no raw errors", async () => {
    const rows = [
      ["sync:AFLM:lineups", "fetchLineup failed: player-secret"],
      ["sync:AFLW:stats", "fetchPlayerStats failed: match-secret"],
      ["sync:VFL:stats", "partial season stats: raw-secret"],
      ["sync:stats:unmapped-team", "unmapped team raw-secret"],
      ["sync:AFLM:stats", "unrelated raw-secret"],
    ] as const;
    await authedEnv.DB.batch(
      rows.map(([type, error]) =>
        authedEnv.DB.prepare(
          "INSERT INTO sync_log (timestamp, type, rows_affected, error) VALUES (?1, ?2, 0, ?3)",
        ).bind("2026-07-12T05:00:00.000Z", type, error),
      ),
    );
    await authedEnv.DB.prepare(
      "INSERT INTO sync_log (timestamp, type, rows_affected, error) VALUES (?1, 'sync:AFLM:lineups', 0, 'fetchLineup failed: old-secret')",
    )
      .bind("2026-07-10T05:00:00.000Z")
      .run();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const body = await getAdminStatus(authedEnv, new Date("2026-07-12T06:00:00.000Z"));
    expect(body.degradation).toEqual({
      windowHours: 24,
      partialLineupEvents: 1,
      partialStatsEvents: 2,
      unmappedTeamEvents: 1,
    });
    expect(JSON.stringify(body)).not.toContain("secret");
  });

  it("uses exactly nine fixed statements", async () => {
    let statementCount = 0;
    const countingDb = {
      prepare: authedEnv.DB.prepare.bind(authedEnv.DB),
      batch: async (statements: D1PreparedStatement[]) => {
        statementCount = statements.length;
        return authedEnv.DB.batch(statements);
      },
    } as D1Database;
    vi.spyOn(console, "log").mockImplementation(() => {});
    await getAdminStatus({ ...authedEnv, DB: countingDb }, new Date("2026-07-12T06:00:00.000Z"));
    expect(statementCount).toBe(9);
  });

  it("returns a sanitized 500 when a fixed query fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const failingDb = new Proxy(authedEnv.DB, {
      get(target, property) {
        if (property === "batch") {
          return async () => {
            throw new Error("raw-d1-secret");
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const response = await worker.fetch(request(), { ...authedEnv, DB: failingDb }, stubCtx);
    expect(response.status).toBe(500);
    const responseText = await response.text();
    expect(JSON.parse(responseText)).toEqual({ error: "internal error" });
    expect(responseText).not.toContain("raw-d1-secret");
    expect(errorSpy).toHaveBeenCalledOnce();
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("raw-d1-secret");
    expect(JSON.stringify(errorSpy.mock.calls)).toContain("admin_route_error");
  });
});

async function seedIntegrityViolations(): Promise<void> {
  const competition = await authedEnv.DB.prepare(
    "SELECT id FROM competitions WHERE code = 'AFLM'",
  ).first<{ id: number }>();
  if (!competition) throw new Error("AFLM fixture missing");
  await authedEnv.DB.prepare("INSERT INTO seasons (competition_id, year) VALUES (?1, 2026)")
    .bind(competition.id)
    .run();
  const season = await authedEnv.DB.prepare("SELECT id FROM seasons WHERE year = 2026").first<{
    id: number;
  }>();
  if (!season) throw new Error("season fixture missing");
  await authedEnv.DB.batch([
    authedEnv.DB.prepare("INSERT INTO teams (name, competition_id) VALUES ('Carlton', ?1)").bind(
      competition.id,
    ),
    authedEnv.DB.prepare("INSERT INTO teams (name, competition_id) VALUES ('Richmond', ?1)").bind(
      competition.id,
    ),
  ]);
  const teams = await authedEnv.DB.prepare("SELECT id, name FROM teams ORDER BY name").all<{
    id: number;
    name: string;
  }>();
  const ids = new Map(teams.results.map((team) => [team.name, team.id]));
  const home = ids.get("Carlton");
  const away = ids.get("Richmond");
  if (home === undefined || away === undefined) throw new Error("team fixture missing");
  await authedEnv.DB.prepare(
    `INSERT INTO matches
       (season_id, round, round_type, date, home_team_id, away_team_id,
        home_goals, home_behinds, home_points, away_goals, away_behinds, away_points, margin,
        home_q1_goals, home_q1_behinds, home_q2_goals, home_q2_behinds,
        home_q3_goals, home_q3_behinds, home_q4_goals, home_q4_behinds,
        away_q1_goals, away_q1_behinds, away_q2_goals, away_q2_behinds,
        away_q3_goals, away_q3_behinds, away_q4_goals, away_q4_behinds)
     VALUES (?1, 'Round 1', 'Regular', '2026-07-11', ?2, ?3,
       1, 1, 99, 1, 1, 7, 0,
       0, 0, 0, 0, 0, 0, 0, 0,
       0, 0, 0, 0, 0, 0, 0, 0)`,
  )
    .bind(season.id, home, away)
    .run();
  const match = await authedEnv.DB.prepare("SELECT id FROM matches WHERE season_id = ?1")
    .bind(season.id)
    .first<{ id: number }>();
  if (!match) throw new Error("match fixture missing");
  await authedEnv.DB.prepare(
    "INSERT INTO players (first_name, surname) VALUES ('Test', 'Player')",
  ).run();
  const player = await authedEnv.DB.prepare("SELECT id FROM players LIMIT 1").first<{
    id: number;
  }>();
  if (!player) throw new Error("player fixture missing");
  await authedEnv.DB.prepare(
    `INSERT INTO player_match_stats
       (match_id, player_id, team_id, kicks, handballs, disposals, brownlow_votes)
     VALUES (?1, ?2, ?3, 1, 1, 9, 3)`,
  )
    .bind(match.id, player.id, home)
    .run();
}
