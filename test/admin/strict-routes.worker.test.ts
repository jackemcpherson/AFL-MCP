import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeMatch } from "#test/factories";
import { testCtx } from "#test/fixtures";
import worker from "../../src/index";
import {
  ensureCompetition,
  ensureSeason,
  ensureTeams,
  ensureVenues,
  upsertMatches,
} from "../../src/sync/upserts";
import type { Env } from "../../src/types";

const ADMIN_TOKEN = "strict-routes-token";
const adminEnv: Env = { ...env, ADMIN_TOKEN };
const ctx = testCtx();
const OPERATION_ID = "6f1c2b0e-3d4a-4c5b-8e9f-0a1b2c3d4e5f";
const SHA = "a".repeat(64);
const evidence = (explanation: string) => ({
  url: "https://example.test/e",
  sha256: SHA,
  explanation,
});

beforeEach(() => {
  // No route under test may reach a real upstream.
  vi.stubGlobal("fetch", async () => new Response("offline", { status: 503 }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

interface Reply {
  status: number;
  body: Record<string, unknown>;
}

async function post(path: string, body: unknown): Promise<Reply> {
  const response = await worker.fetch(
    new Request(`https://afl.test/mcp/admin/${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ADMIN_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }),
    adminEnv,
    ctx,
  );
  return {
    status: response.status,
    body: await response.json<Record<string, unknown>>(),
  };
}

describe("strict admin routes reject undeclared keys", () => {
  // Each body decodes cleanly, so its reply comes from the route's work, not
  // the decoder. Adding one unknown key must turn it into the decoder's 400.
  it.each([
    {
      path: "repair-player-identity",
      body: { playerIds: [1, 2], evidence: [evidence("x".repeat(20))] },
    },
    {
      path: "refresh-statistics",
      body: { competition: "AFLM", season: 2026, operationId: OPERATION_ID },
    },
    {
      path: "refresh-weather",
      body: {
        competition: "AFLM",
        season: 2026,
        matchId: 1,
        evidence: [evidence("x")],
      },
    },
    {
      path: "retry-weather",
      body: { competition: "AFLM", season: 2026, matchId: 1 },
    },
    {
      path: "reconcile-bears",
      body: {},
    },
    {
      path: "recalculate-pav",
      body: { competition: "AFLM", season: 2026 },
    },
    {
      path: "backfill",
      body: { competition: "AFLM", season: 1800 },
    },
    {
      path: "backfill",
      body: { competitions: ["AFLM"], fromYear: 1800, toYear: 1800 },
    },
    {
      path: "backfill-brownlow",
      body: { fromYear: 1800, toYear: 1800 },
    },
    {
      path: "backfill-coaches",
      body: { fromYear: 1800, toYear: 1800 },
    },
  ])("$path $body", async ({ path, body }) => {
    // Every route names the first problem, here the undeclared key.
    const error = 'Expected no excess property at "unexpected"';
    const control = await post(path, body);
    expect(control.body["error"]).not.toBe(error);

    const rejected = await post(path, { ...body, unexpected: 1 });
    expect(rejected).toEqual({ status: 400, body: { error } });
  });
});

it("maps SEASON_NOT_FOUND to 404", async () => {
  const reply = await post("refresh-statistics", {
    competition: "AFLM",
    season: 2026,
    operationId: OPERATION_ID,
  });
  expect(reply.status).toBe(404);
  expect(reply.body).toMatchObject({ code: "SEASON_NOT_FOUND" });
});

describe("reviewed repairs preview unless dryRun is false", () => {
  it("previews a statistics refresh when dryRun is omitted, even with its digest", async () => {
    const competitionId = await ensureCompetition(env, "AFLM");
    const seasonId = await ensureSeason(env, competitionId, 2026);
    const matches = [makeMatch()];
    const teamMap = await ensureTeams(env, competitionId, "AFLM", matches);
    const venueMap = await ensureVenues(env, matches);
    await upsertMatches(env, matches, { seasonId, teamMap, venueMap });
    const request = {
      competition: "AFLM",
      season: 2026,
      operationId: OPERATION_ID,
    };

    const preview = await post("refresh-statistics", { ...request, dryRun: true });
    expect(preview).toMatchObject({ status: 200, body: { dryRun: true } });
    const again = await post("refresh-statistics", {
      ...request,
      manifestDigest: preview.body["manifestDigest"],
    });
    expect(again).toMatchObject({ status: 200, body: { dryRun: true } });
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM stats_refresh_operations").first("n"),
    ).toBe(0);
  });

  it("previews the Bears repair when dryRun is omitted, even with its digest", async () => {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO seasons (id, competition_id, year, season_key) VALUES (920, 1, 1996, '1996')",
      ),
      env.DB.prepare(
        "INSERT INTO teams (id, competition_id, name) VALUES (921, 1, 'Brisbane Lions'), (922, 1, 'Carlton')",
      ),
      env.DB.prepare(
        "INSERT INTO matches (id, season_id, round, date, home_team_id, away_team_id) VALUES (923, 920, 'Round 1', '1996-03-16', 921, 922)",
      ),
    ]);
    const revision = () =>
      env.DB.prepare("SELECT revision FROM public_input_revision WHERE id = 1").first("revision");
    const before = await revision();

    const preview = await post("reconcile-bears", { dryRun: true });
    expect(preview).toMatchObject({
      status: 200,
      body: { affectedMatches: 1 },
    });
    const again = await post("reconcile-bears", {
      manifestDigest: preview.body["manifestDigest"],
    });
    expect(again.status).toBe(200);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM teams WHERE name = 'Brisbane Bears'").first(
        "n",
      ),
    ).toBe(0);
    expect(await revision()).toBe(before);
  });
});

describe("admin contract shapes", () => {
  it("answers every lease-holding route with one busy shape", async () => {
    await env.DB.prepare(
      "UPDATE sync_lease SET holder = 'other', acquired_at = datetime('now') WHERE id = 1",
    ).run();
    try {
      for (const [path, body] of [
        ["refresh-statistics", { competition: "AFLM", season: 2026, operationId: OPERATION_ID }],
        ["reconcile-bears", {}],
        ["backfill-brownlow", { fromYear: 2025, toYear: 2025 }],
        ["backfill-coaches", { fromYear: 2024, toYear: 2024 }],
        ["recalculate-pav", { competition: "AFLM", season: 2026 }],
      ] as const) {
        expect(await post(path, body)).toEqual({
          status: 409,
          body: { error: "operation lease held", code: "OPERATION_BUSY", busy: true },
        });
      }
    } finally {
      await env.DB.prepare(
        "UPDATE sync_lease SET holder = NULL, acquired_at = NULL WHERE id = 1",
      ).run();
    }
  });

  it("rejects an identity group that names one player with 400, not 409", async () => {
    const reply = await post("repair-player-identity", {
      playerIds: [5, 5],
      evidence: [evidence("x".repeat(20))],
    });
    expect(reply).toEqual({
      status: 400,
      body: { error: "At least two distinct player IDs are required", code: "INVALID_REQUEST" },
    });
  });

  it("bounds a 400 body that quotes a caller-supplied key", async () => {
    const reply = await post("refresh-weather", { ["k".repeat(1_000)]: 1 });
    expect(reply.status).toBe(400);
    expect(String(reply.body["error"]).length).toBeLessThanOrEqual(201);
  });

  it("rejects a coaching range wider than one season", async () => {
    expect(await post("backfill-coaches", { fromYear: 2023, toYear: 2024 })).toEqual({
      status: 400,
      body: { error: "fromYear and toYear must be the same year" },
    });
  });
});
