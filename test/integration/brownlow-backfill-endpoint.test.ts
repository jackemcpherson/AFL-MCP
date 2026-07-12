import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makePlayerStats } from "./_fixtures";

vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));

import { applyBrownlowUpdates, type BrownlowVoteUpdate } from "../../src/admin/brownlow";
import worker from "../../src/index";
import { acquireOperationLease, releaseOperationLease } from "../../src/sync/lease";
import type { Env } from "../../src/types";

const ADMIN_TOKEN = "brownlow-admin-token";
const authedEnv: Env = { ...(env as Env), ADMIN_TOKEN };
const stubCtx = createExecutionContext();
const fetchRoutes = new Map<string, { body: string; status: number }[]>();
let fetchSpy: ReturnType<typeof vi.spyOn>;

interface SeededSeason {
  readonly matchId: number;
  readonly playerIds: readonly number[];
  readonly stats: readonly ReturnType<typeof makePlayerStats>[];
}

function request(body: unknown, token: string | null = ADMIN_TOKEN): Request {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (token !== null) headers.set("Authorization", `Bearer ${token}`);
  return new Request("https://afl.test/mcp/admin/backfill-brownlow", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function mockAflTablesSeason(
  year: number,
  stats: readonly ReturnType<typeof makePlayerStats>[],
  options: { readonly gameStatus?: number; readonly times?: number } = {},
): void {
  const compactDate = /\d{8}$/.exec(stats[0]?.matchId ?? "")?.[0] ?? `${year}0319`;
  const gamePath = `/afl/stats/games/${year}/${compactDate}.html`;
  const seasonHtml = `<table><tr></tr><tr><td></td><td></td><td></td><td><a href="..${gamePath.slice(4)}">Game</a></td></tr></table>`;
  const rows = stats
    .map((stat) => {
      const cells = Array.from({ length: 25 }, () => "0");
      cells[0] = "1";
      cells[1] = `${stat.surname}, ${stat.givenName}`;
      cells[16] = String(stat.brownlowVotes ?? "");
      return `<tr>${cells.map((cell) => `<td>${cell}</td>`).join("")}</tr>`;
    })
    .join("");
  const gameHtml = `<table class="sortable"><thead><tr><th>Carlton Match Statistics</th></tr></thead><tbody>${rows}</tbody></table>`;
  addFetchRoute(`https://afltables.com/afl/seas/${year}.html`, 200, seasonHtml, options.times);
  addFetchRoute(
    `https://afltables.com${gamePath}`,
    options.gameStatus ?? 200,
    gameHtml,
    options.times,
  );
}

function addFetchRoute(url: string, status: number, body: string, times = 1): void {
  const routes = fetchRoutes.get(url) ?? [];
  for (let i = 0; i < times; i++) routes.push({ status, body });
  fetchRoutes.set(url, routes);
}

async function seedSeason(year: number, date: string): Promise<SeededSeason> {
  const competition = await authedEnv.DB.prepare(
    "SELECT id FROM competitions WHERE code = 'AFLM'",
  ).first<{ id: number }>();
  if (!competition) throw new Error("AFLM fixture competition missing");
  await authedEnv.DB.prepare("INSERT INTO seasons (competition_id, year) VALUES (?1, ?2)")
    .bind(competition.id, year)
    .run();
  const season = await authedEnv.DB.prepare(
    "SELECT id FROM seasons WHERE competition_id = ?1 AND year = ?2",
  )
    .bind(competition.id, year)
    .first<{ id: number }>();
  if (!season) throw new Error("season fixture missing");
  await authedEnv.DB.batch([
    authedEnv.DB.prepare(
      "INSERT OR IGNORE INTO teams (name, competition_id) VALUES ('Carlton', ?1)",
    ).bind(competition.id),
    authedEnv.DB.prepare(
      "INSERT OR IGNORE INTO teams (name, competition_id) VALUES ('Richmond', ?1)",
    ).bind(competition.id),
  ]);
  const teams = await authedEnv.DB.prepare(
    "SELECT id, name FROM teams WHERE competition_id = ?1 ORDER BY name",
  )
    .bind(competition.id)
    .all<{ id: number; name: string }>();
  const teamIds = new Map(teams.results.map((team) => [team.name, team.id]));
  const carltonId = teamIds.get("Carlton");
  const richmondId = teamIds.get("Richmond");
  if (carltonId === undefined || richmondId === undefined) throw new Error("team fixture missing");
  await authedEnv.DB.prepare(
    `INSERT INTO matches
       (season_id, round, round_number, round_type, date, home_team_id, away_team_id,
        home_points, away_points)
     VALUES (?1, 'Opening Round', 0, 'Regular', ?2, ?3, ?4, 80, 70)`,
  )
    .bind(season.id, date, carltonId, richmondId)
    .run();
  const match = await authedEnv.DB.prepare(
    "SELECT id FROM matches WHERE season_id = ?1 AND date = ?2",
  )
    .bind(season.id, date)
    .first<{ id: number }>();
  if (!match) throw new Error("match fixture missing");

  const names = [
    ["Patrick", "Cripps"],
    ["Sam", "Walsh"],
    ["George", "Hewett"],
  ] as const;
  const playerIds: number[] = [];
  for (const [givenName, surname] of names) {
    await authedEnv.DB.prepare("INSERT INTO players (first_name, surname) VALUES (?1, ?2)")
      .bind(givenName, surname)
      .run();
    const player = await authedEnv.DB.prepare(
      "SELECT id FROM players WHERE first_name = ?1 AND surname = ?2 ORDER BY id DESC LIMIT 1",
    )
      .bind(givenName, surname)
      .first<{ id: number }>();
    if (!player) throw new Error("player fixture missing");
    playerIds.push(player.id);
    await authedEnv.DB.prepare(
      "INSERT INTO player_match_stats (match_id, player_id, team_id) VALUES (?1, ?2, ?3)",
    )
      .bind(match.id, player.id, carltonId)
      .run();
  }
  const compactDate = date.replaceAll("-", "");
  return {
    matchId: match.id,
    playerIds,
    stats: names.map(([givenName, surname], index) =>
      makePlayerStats({
        matchId: `AT_${compactDate}`,
        season: year,
        roundNumber: 0,
        team: "Carlton",
        givenName,
        surname,
        brownlowVotes: [3, 2, 1][index] ?? 0,
        source: "afl-tables",
      }),
    ),
  };
}

beforeEach(() => {
  fetchRoutes.clear();
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : input.toString();
    const route = fetchRoutes.get(url)?.shift();
    if (!route) throw new Error(`Unexpected outbound request: ${url}`);
    return new Response(route.body, { status: route.status });
  });
});

afterEach(async () => {
  await authedEnv.DB.prepare(
    "UPDATE sync_lease SET holder = NULL, acquired_at = NULL WHERE id = 1",
  ).run();
  vi.restoreAllMocks();
});

describe("shared operation lease", () => {
  it("supports acquisition, contention, stale takeover, and holder-safe release", async () => {
    expect(await acquireOperationLease(authedEnv, "first")).toBe(true);
    expect(await acquireOperationLease(authedEnv, "second")).toBe(false);
    await releaseOperationLease(authedEnv, "wrong");
    expect(await acquireOperationLease(authedEnv, "second")).toBe(false);
    await authedEnv.DB.prepare(
      "UPDATE sync_lease SET acquired_at = datetime('now', '-11 minutes') WHERE id = 1",
    ).run();
    expect(await acquireOperationLease(authedEnv, "second")).toBe(true);
    await releaseOperationLease(authedEnv, "second");
    expect(await acquireOperationLease(authedEnv, "third")).toBe(true);
  });
});

describe("bounded Brownlow writes", () => {
  it("submits more than 200 updates in batches of at most 100 and sums changes", async () => {
    const seeded = await seedSeason(2026, "2026-03-19");
    const team = await authedEnv.DB.prepare(
      "SELECT team_id AS teamId FROM player_match_stats WHERE match_id = ?1 LIMIT 1",
    )
      .bind(seeded.matchId)
      .first<{ teamId: number }>();
    if (!team) throw new Error("team fixture missing");

    const extraPlayerIds = Array.from({ length: 202 }, (_, index) => 10_000 + index);
    for (let i = 0; i < extraPlayerIds.length; i += 100) {
      const ids = extraPlayerIds.slice(i, i + 100);
      await authedEnv.DB.batch(
        ids.map((playerId) =>
          authedEnv.DB.prepare("INSERT INTO players (id, surname) VALUES (?1, ?2)").bind(
            playerId,
            `Batch-${playerId}`,
          ),
        ),
      );
      await authedEnv.DB.batch(
        ids.map((playerId) =>
          authedEnv.DB.prepare(
            "INSERT INTO player_match_stats (match_id, player_id, team_id) VALUES (?1, ?2, ?3)",
          ).bind(seeded.matchId, playerId, team.teamId),
        ),
      );
    }

    const updates: BrownlowVoteUpdate[] = [...seeded.playerIds, ...extraPlayerIds].map(
      (playerId) => ({ matchId: seeded.matchId, playerId, votes: 1 }),
    );
    const batchSizes: number[] = [];
    const recordingDb = new Proxy(authedEnv.DB, {
      get(target, property) {
        if (property === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            batchSizes.push(statements.length);
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    expect(await applyBrownlowUpdates(recordingDb, updates)).toBe(205);
    expect(batchSizes).toEqual([100, 100, 5]);
    expect(batchSizes.every((size) => size <= 100)).toBe(true);
    const written = await authedEnv.DB.prepare(
      "SELECT COUNT(*) AS count FROM player_match_stats WHERE match_id = ?1 AND brownlow_votes = 1",
    )
      .bind(seeded.matchId)
      .first<{ count: number }>();
    expect(written?.count).toBe(205);
  });
});

describe("POST /mcp/admin/backfill-brownlow", () => {
  it("requires admin authentication", async () => {
    expect((await worker.fetch(request({}, null), authedEnv, stubCtx)).status).toBe(401);
    expect((await worker.fetch(request({}, "wrong"), authedEnv, stubCtx)).status).toBe(401);
  });

  it.each([
    ["not-json", "invalid JSON body"],
    [{ fromYear: 2026.5, toYear: 2026 }, "fromYear must be an integer"],
    [{ fromYear: 2026, toYear: 2025 }, "toYear must be >= fromYear"],
    [{ fromYear: 1989, toYear: 1989 }, "years must be between"],
    [{ fromYear: 2024, toYear: 2026 }, "max 2 years"],
  ])("rejects invalid or out-of-range bodies", async (body, error) => {
    const response = await worker.fetch(request(body), authedEnv, stubCtx);
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toContain(error);
  });

  it("dry-runs with the exact sanitized response and zero writes", async () => {
    const seeded = await seedSeason(2026, "2026-03-19");
    mockAflTablesSeason(2026, seeded.stats);
    const response = await worker.fetch(
      request({ fromYear: 2026, toYear: 2026 }),
      authedEnv,
      stubCtx,
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      status: "ok",
      dryRun: true,
      seasons: [
        {
          year: 2026,
          upstreamRows: 3,
          failedMatchCount: 0,
          positiveVoteRows: 3,
          resolution: {
            exact: 3,
            normalized: 0,
            surname: 0,
            seasonFallback: 0,
            unresolvedMatch: 0,
            unresolvedPlayer: 0,
            ambiguous: 0,
          },
          regularMatchTotals: { zero: 0, six: 1, other: 0 },
          eligible: true,
          notPublished: false,
          updated: 0,
        },
      ],
    });
    const row = await authedEnv.DB.prepare(
      "SELECT COUNT(*) AS count FROM player_match_stats WHERE brownlow_votes IS NOT NULL",
    ).first<{ count: number }>();
    expect(row?.count).toBe(0);
  });

  it("writes once, preserves existing values, is idempotent, and never recalculates PAV", async () => {
    const seeded = await seedSeason(2026, "2026-03-19");
    await authedEnv.DB.prepare(
      "UPDATE player_match_stats SET brownlow_votes = 3 WHERE match_id = ?1 AND player_id = ?2",
    )
      .bind(seeded.matchId, seeded.playerIds[0])
      .run();
    mockAflTablesSeason(2026, seeded.stats, { times: 2 });

    const first = await worker.fetch(
      request({ fromYear: 2026, toYear: 2026, dryRun: false }),
      authedEnv,
      stubCtx,
    );
    expect(first.status).toBe(200);
    expect(JSON.stringify(await first.json())).toContain('"updated":2');
    const second = await worker.fetch(
      request({ fromYear: 2026, toYear: 2026, dryRun: false }),
      authedEnv,
      stubCtx,
    );
    expect(second.status).toBe(200);
    expect(JSON.stringify(await second.json())).toContain('"updated":0');
    const votes = await authedEnv.DB.prepare(
      "SELECT brownlow_votes FROM player_match_stats WHERE match_id = ?1 ORDER BY brownlow_votes DESC",
    )
      .bind(seeded.matchId)
      .all<{ brownlow_votes: number }>();
    expect(votes.results.map((row) => row.brownlow_votes)).toEqual([3, 2, 1]);
    expect(
      (
        await authedEnv.DB.prepare("SELECT COUNT(*) AS count FROM player_season_pav").first<{
          count: number;
        }>()
      )?.count,
    ).toBe(0);
  });

  it("blocks every write when one season is incomplete", async () => {
    const first = await seedSeason(2025, "2025-03-20");
    const second = await seedSeason(2026, "2026-03-19");
    mockAflTablesSeason(2025, first.stats);
    mockAflTablesSeason(2026, second.stats.slice(0, 1));
    const response = await worker.fetch(
      request({ fromYear: 2025, toYear: 2026, dryRun: false }),
      authedEnv,
      stubCtx,
    );
    expect(response.status).toBe(409);
    expect(JSON.stringify(await response.json())).toContain('"status":"blocked"');
    const count = await authedEnv.DB.prepare(
      "SELECT COUNT(*) AS count FROM player_match_stats WHERE brownlow_votes IS NOT NULL",
    ).first<{ count: number }>();
    expect(count?.count).toBe(0);
  });

  it("blocks partial fetch envelopes and logs only bounded aggregate codes", async () => {
    const seeded = await seedSeason(2026, "2026-03-19");
    mockAflTablesSeason(2026, seeded.stats, { gameStatus: 404 });
    const response = await worker.fetch(
      request({ fromYear: 2026, toYear: 2026, dryRun: false }),
      authedEnv,
      stubCtx,
    );
    expect(response.status).toBe(409);
    const logs = await authedEnv.DB.prepare(
      "SELECT type, error FROM sync_log WHERE type = 'admin:brownlow-backfill'",
    ).all<{ type: string; error: string }>();
    expect(logs.results).toEqual([
      { type: "admin:brownlow-backfill", error: "blocked:partial-fetch" },
    ]);
    expect(JSON.stringify(logs.results)).not.toContain("AT_20260319");
    expect(JSON.stringify(await response.json())).not.toContain("AT_20260319");
  });

  it("returns the exact lease contention error without fetching upstream", async () => {
    await authedEnv.DB.prepare(
      "UPDATE sync_lease SET holder = 'private-holder', acquired_at = datetime('now') WHERE id = 1",
    ).run();
    const response = await worker.fetch(
      request({ fromYear: 2026, toYear: 2026 }),
      authedEnv,
      stubCtx,
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "operation lease held" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sanitizes upstream failures and releases the lease in finally", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    addFetchRoute(
      "https://afltables.com/afl/seas/2026.html",
      404,
      "player-secret upstream failure",
    );
    const response = await worker.fetch(
      request({ fromYear: 2026, toYear: 2026 }),
      authedEnv,
      stubCtx,
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal error" });
    const lease = await authedEnv.DB.prepare(
      "SELECT holder, acquired_at FROM sync_lease WHERE id = 1",
    ).first<{ holder: string | null; acquired_at: string | null }>();
    expect(lease).toEqual({ holder: null, acquired_at: null });
    const log = await authedEnv.DB.prepare(
      "SELECT error FROM sync_log WHERE type = 'admin:brownlow-backfill' ORDER BY id DESC LIMIT 1",
    ).first<{ error: string }>();
    expect(log?.error).toBe("failed:upstream");
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("player-secret");
  });
});
