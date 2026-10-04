import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { auditNextSeason } from "../../src/sync/audit";

describe("bounded season audit", () => {
  it("rotates seasons and records exact missing provider identities without changing public data", async () => {
    await env.DB.prepare(
      "INSERT INTO seasons(id,competition_id,year,season_key) VALUES (90001,1,1991,'1991'),(90002,1,1992,'1992')",
    ).run();
    await env.DB.prepare(
      "INSERT INTO season_provider_inventory(season_id,provider,observed_at,matches_json) VALUES (90001,'afl-api','2026-10-04T00:00:00Z',?1)",
    )
      .bind(JSON.stringify([{ matchId: "CD_MISSING_REVIEW" }]))
      .run();
    const before = await env.DB.prepare(
      "SELECT revision FROM public_input_revision WHERE id=1",
    ).first("revision");
    await auditNextSeason(env, new Date("2026-10-04T01:00:00Z"));
    await auditNextSeason(env, new Date("2026-10-04T02:00:00Z"));
    const logs = await env.DB.prepare(
      "SELECT type,error FROM sync_log WHERE type LIKE 'audit:season:%' ORDER BY id",
    ).all<{ type: string; error: string | null }>();
    expect(logs.results.map((row) => row.type)).toEqual([
      "audit:season:90001",
      "audit:season:90002",
    ]);
    expect(JSON.parse(logs.results[0]?.error ?? "{}")).toMatchObject({
      competition: "AFLM",
      season: "1991",
      findings: [{ issue: "provider-match-not-linked", record_id: "CD_MISSING_REVIEW" }],
      truncated: false,
    });
    expect(
      await env.DB.prepare("SELECT revision FROM public_input_revision WHERE id=1").first(
        "revision",
      ),
    ).toBe(before);
  });

  it("does not publish an observation through an unfinished marker", async () => {
    await env.DB.prepare(
      "INSERT INTO seasons(id,competition_id,year,season_key) VALUES (90001,1,1991,'1991')",
    ).run();
    await env.DB.prepare("UPDATE public_input_revision SET in_progress=1 WHERE id=1").run();
    await auditNextSeason(env);
    expect(
      await env.DB.prepare("SELECT COUNT(*) FROM sync_log WHERE type LIKE 'audit:season:%'").first(
        "COUNT(*)",
      ),
    ).toBe(0);
  });
});
