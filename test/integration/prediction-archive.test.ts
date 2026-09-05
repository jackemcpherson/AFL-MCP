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

async function createMatch(): Promise<number> {
  const competitionId = await ensureCompetition(env, "AFLM");
  const seasonId = await ensureSeason(env, competitionId, 2027);
  const match = makeMatch({ season: 2027 });
  const teamMap = await ensureTeams(env, competitionId, "AFLM", [match]);
  const venueMap = await ensureVenues(env, [match]);
  await upsertMatches(env, [match], { seasonId, teamMap, venueMap });
  const row = await env.DB.prepare("SELECT id FROM matches WHERE external_afl_id = 'M-1'").first<{
    id: number;
  }>();
  if (!row) throw new Error("Fixture was not inserted");
  return row.id;
}

function capture(matchId: number, model: string, at: string, probability = 0.3, lineups = "[]") {
  return env.DB.prepare(`
    INSERT INTO prediction_archive (
      match_id, model_version, captured_at, competition, season_year, round_number,
      round_first_kickoff, match_kickoff, is_primary, home_win_prob, predicted_margin,
      lineups_json, inputs_json, field_json, field_captured_at
    ) VALUES (?, ?, ?, 'AFLM', 2027, 1, '2027-03-18T19:30:00',
      '2027-03-18T19:30:00', 0, ?, -12.3, ?, '{}', NULL, NULL)
  `).bind(matchId, model, at, probability, lineups);
}

describe("prediction archive migration", () => {
  it("retains distinct captures and models without changing published primary rows", async () => {
    const matchId = await createMatch();
    await env.DB.prepare(
      "INSERT INTO match_predictions VALUES (?, 0.7, 12.3, 'primary', '2027-03-17T00:00:00Z')",
    )
      .bind(matchId)
      .run();
    await capture(matchId, "shadow", "2027-03-17T00:00:00Z").run();
    await capture(matchId, "shadow", "2027-03-17T01:00:00Z").run();
    await capture(matchId, "primary", "2027-03-17T00:00:00Z").run();
    await expect(capture(matchId, "shadow", "2027-03-17T00:00:00Z", 0.9).run()).rejects.toThrow(
      /UNIQUE constraint/,
    );
    const archived = await env.DB.prepare(
      "SELECT home_win_prob, predicted_margin, field_json FROM prediction_archive",
    ).all();
    expect(archived.results).toHaveLength(3);
    expect(archived.results[0]).toEqual({
      home_win_prob: 0.3,
      predicted_margin: -12.3,
      field_json: null,
    });
    const primary = await env.DB.prepare(
      "SELECT home_win_prob, predicted_margin FROM match_predictions WHERE match_id = ?",
    )
      .bind(matchId)
      .first();
    expect(primary).toEqual({ home_win_prob: 0.7, predicted_margin: 12.3 });
  });

  it("rejects out-of-range probabilities and malformed captured JSON", async () => {
    const matchId = await createMatch();
    await expect(capture(matchId, "shadow", "2027-03-17T00:00:00Z", 1.1).run()).rejects.toThrow(
      /CHECK constraint/,
    );
    await expect(
      capture(matchId, "shadow", "2027-03-17T00:00:00Z", 0.3, "broken").run(),
    ).rejects.toThrow(/CHECK constraint/);
  });
});
