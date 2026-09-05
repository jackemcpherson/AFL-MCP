import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  ensureCompetition,
  ensureSeason,
  ensureTeams,
  ensureVenues,
  upsertMatches,
} from "../../src/sync/upserts";
import { makeMatch } from "./_fixtures";

describe("canonical kickoff and prediction invalidation", () => {
  it("stores source UTC instant, invalidates changed fixture projections, and clears unknown instants", async () => {
    const competition = await ensureCompetition(env, "AFLM");
    const seasonId = await ensureSeason(env, competition, 2026);
    const match = makeMatch({ date: new Date("2026-03-19T08:30:00Z") });
    const teamMap = await ensureTeams(env, competition, "AFLM", [match]),
      venueMap = await ensureVenues(env, [match]);
    const ctx = { seasonId, teamMap, venueMap };
    await upsertMatches(env, [match], ctx);
    const row = await env.DB.prepare("SELECT id,kickoff_at FROM matches").first<{
      id: number;
      kickoff_at: string;
    }>();
    expect(row?.kickoff_at).toBe("2026-03-19T08:30:00.000Z");
    await env.DB.prepare(
      "INSERT INTO match_predictions(match_id,home_win_prob,predicted_margin,model_version,generated_at) VALUES(?,.6,10,'legacy','2026-03-01')",
    )
      .bind(row?.id)
      .run();
    await upsertMatches(env, [{ ...match, date: new Date("2026-03-20T08:30:00Z") }], ctx);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM match_predictions").first()).toEqual({
      n: 0,
    });
    await upsertMatches(env, [{ ...match, date: new Date(Number.NaN) }], ctx);
    expect(await env.DB.prepare("SELECT kickoff_at FROM matches").first()).toEqual({
      kickoff_at: null,
    });
  });
});
