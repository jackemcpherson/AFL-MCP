import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ensureCompetition, ensureTeams } from "../../src/sync/upserts";
import { makeMatch } from "./_fixtures";

interface SyncLogRow {
  type: string;
  rows_affected: number;
  error: string | null;
}

async function selectNovelTeamLogs(): Promise<SyncLogRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT type, rows_affected, error FROM sync_log
     WHERE type LIKE 'sync:novel-team:%'
     ORDER BY id`,
  ).all<SyncLogRow>();
  return results;
}

describe("ensureTeams novel-team guardrail", () => {
  it("writes no sync:novel-team log when all team names are already known", async () => {
    const competitionId = await ensureCompetition(env, "AFLM");
    const match = makeMatch({ homeTeam: "Carlton", awayTeam: "Richmond" });

    // First call registers Carlton and Richmond (so they are no longer novel).
    await ensureTeams(env, competitionId, "AFLM", [match]);
    const before = await selectNovelTeamLogs();

    // Second call sees the same teams as already-known; should log nothing new.
    await ensureTeams(env, competitionId, "AFLM", [match]);
    const after = await selectNovelTeamLogs();

    expect(after.length).toBe(before.length);
  });

  it("writes a sync:novel-team log AND inserts the team when a novel name appears", async () => {
    const competitionId = await ensureCompetition(env, "AFLM");

    // Seed a known team via a first ensureTeams call so it doesn't count
    // as novel in the assertion below.
    const seed = makeMatch({ homeTeam: "Carlton", awayTeam: "Richmond" });
    await ensureTeams(env, competitionId, "AFLM", [seed]);
    const before = await selectNovelTeamLogs();

    // A match referencing a brand-new SDNR-style indigenous name that
    // bypasses TEAM_NAME_MAP. Pick something obscure unlikely to appear
    // elsewhere in the test suite so the assertion can target it.
    const novelMatch = makeMatch({
      matchId: "M-novel",
      homeTeam: "Carlton",
      awayTeam: "Wirrnanga",
    });
    const teamMap = await ensureTeams(env, competitionId, "AFLM", [novelMatch]);

    // Team row was inserted (guardrail is observational, not blocking).
    expect(teamMap.get("Wirrnanga")).toBeDefined();

    // Exactly one new sync:novel-team:AFLM log row was written, with the
    // novel name in the error payload field and rows_affected=1.
    const after = await selectNovelTeamLogs();
    expect(after.length).toBe(before.length + 1);
    const latest = after[after.length - 1];
    expect(latest?.type).toBe("sync:novel-team:AFLM");
    expect(latest?.rows_affected).toBe(1);
    expect(latest?.error).toBe("Wirrnanga");
  });
});
