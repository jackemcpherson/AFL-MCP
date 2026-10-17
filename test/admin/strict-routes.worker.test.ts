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
      error: "invalid identity repair request",
    },
    {
      path: "refresh-statistics",
      body: { competition: "AFLM", season: 2026, operationId: OPERATION_ID },
      error: "invalid statistics refresh request",
    },
    {
      path: "refresh-weather",
      body: {
        competition: "AFLM",
        season: 2026,
        matchId: 1,
        evidence: [evidence("x")],
      },
      error: "invalid weather refresh request",
    },
    {
      path: "retry-weather",
      body: { competition: "AFLM", season: 2026, matchId: 1 },
      error: "invalid weather retry request",
    },
    {
      path: "reconcile-bears",
      body: {},
      error: "invalid Bears repair request",
    },
    {
      path: "recalculate-pav",
      body: { competition: "AFLM", season: 2026 },
      error: "PAV requires competition, season and a reviewed preview",
    },
    {
      path: "backfill",
      body: { competition: "AFLM", season: 1800 },
      error: "invalid exact-season backfill request",
    },
    {
      path: "backfill",
      body: { competitions: ["AFLM"], fromYear: 1800, toYear: 1800 },
      error: 'Expected no excess property at "unexpected"',
    },
  ])("$path $body", async ({ path, body, error }) => {
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
