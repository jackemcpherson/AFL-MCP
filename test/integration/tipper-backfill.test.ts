import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getSchemaInfo } from "../../src/mcp/tools/schema";
import {
  ensureCompetition,
  ensureSeason,
  ensureTeams,
  ensureVenues,
  upsertMatches,
} from "../../src/sync/upserts";
import { makeMatch } from "./_fixtures";

interface Fixture {
  id: number;
  season_id: number;
  home_team_id: number;
  away_team_id: number;
}

async function seedFixtures() {
  const competition = await ensureCompetition(env, "AFLM");
  const seasonId = await ensureSeason(env, competition, 2026);
  const matches = [
    makeMatch(),
    makeMatch({ matchId: "M-2", homeTeam: "Geelong", awayTeam: "Collingwood" }),
  ];
  const teamMap = await ensureTeams(env, competition, "AFLM", matches);
  const venueMap = await ensureVenues(env, matches);
  await upsertMatches(env, matches, { seasonId, teamMap, venueMap });
  const { results } = await env.DB.prepare(
    "SELECT id,season_id,home_team_id,away_team_id FROM matches ORDER BY id",
  ).all<Fixture>();
  const [first, second] = results;
  if (!first || !second) throw new Error("Missing fixture seeds");
  return { first, second };
}

function batch(expectedCount = 1) {
  return env.DB.prepare(
    `INSERT INTO tipper_reconstruction_batches
      (id,season,model_version,source_revision,policy,extracted_at,created_at,expected_count,manifest)
      VALUES ('replay',2026,'elo-pav-normal-v1',?,'prior-day-results-final-lineup-proxy',?,?,?,?)`,
  ).bind(
    "a".repeat(40),
    "2026-09-06T00:00:00.000Z",
    "2026-09-06T00:00:01.000Z",
    expectedCount,
    JSON.stringify({ classification: "reconstructed" }),
  );
}

function prediction(fixture: Fixture, margin = 1.04, winner = "home", probability = 0.6) {
  return env.DB.prepare(
    `INSERT INTO tipper_reconstructions
      (batch_id,match_id,competition,round_number,cutoff_at,kickoff_at,home_team_id,away_team_id,
       margin,home_probability,winner,issued_margin,issued_probability,provisional,evidence)
      VALUES ('replay',?,'AFLM',1,'2026-03-19T08:29:59.999Z','2026-03-19T08:30:00.000Z',
       ?,?,?,?,?,?,?,0,?)`,
  ).bind(
    fixture.id,
    fixture.home_team_id,
    fixture.away_team_id,
    margin,
    probability,
    winner,
    Math.round(margin * 10) / 10,
    probability,
    JSON.stringify({ lineupAvailability: "assumed", completedMatchIds: [] }),
  );
}

function finalize() {
  return env.DB.prepare(
    "UPDATE tipper_reconstruction_batches SET completed_at='2026-09-06T00:01:00.000Z' WHERE id='replay'",
  );
}

describe("historical prediction backfill", () => {
  it("consolidates staging without overwriting an existing prediction and removes staging tables", async () => {
    const { first, second } = await seedFixtures();
    const create = env.TEST_MIGRATIONS.find((m) => m.name.startsWith("0022"));
    const cleanup = env.TEST_MIGRATIONS.find((m) => m.name.startsWith("0023"));
    if (!create || !cleanup) throw new Error("Missing migration");
    await env.DB.batch(create.queries.map((sql) => env.DB.prepare(sql)));
    try {
      await env.DB.batch([
        batch(2),
        prediction(first),
        prediction(second, -0.04, "away", 0.49),
        finalize(),
      ]);
      await env.DB.prepare(
        "INSERT INTO match_predictions(match_id,home_win_prob,predicted_margin,model_version,generated_at) VALUES(?,.7,15,'existing','2026-03-01')",
      )
        .bind(first.id)
        .run();
      await env.DB.batch(cleanup.queries.map((sql) => env.DB.prepare(sql)));
      const rows = await env.DB.prepare(
        "SELECT match_id,home_win_prob,predicted_margin,model_version,tipper_run_id FROM match_predictions ORDER BY match_id",
      ).all();
      expect(rows.results).toEqual([
        {
          match_id: first.id,
          home_win_prob: 0.7,
          predicted_margin: 15,
          model_version: "existing",
          tipper_run_id: null,
        },
        {
          match_id: second.id,
          home_win_prob: 0.49,
          predicted_margin: 0,
          model_version: "elo-pav-normal-v1",
          tipper_run_id: null,
        },
      ]);
      expect(
        await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('tipper_reconstructions','tipper_reconstruction_batches','tipper_reconstruction_finalize','tipper_reconstruction_closed')",
        ).first("n"),
      ).toBe(0);
    } finally {
      await env.DB.prepare("DROP TABLE IF EXISTS tipper_reconstructions").run();
      await env.DB.prepare("DROP TABLE IF EXISTS tipper_reconstruction_batches").run();
    }
  });

  it("scores ordinary stored predictions with draws, missing coverage and rounded-zero away tips", async () => {
    const { first, second } = await seedFixtures();
    const schema = await getSchemaInfo();
    const sql = schema.database.common_joins.tipping_performance;
    await env.DB.prepare("UPDATE matches SET home_points=69,away_points=80 WHERE id=?")
      .bind(first.id)
      .run();
    await env.DB.prepare(
      "INSERT INTO match_predictions(match_id,home_win_prob,predicted_margin,model_version,generated_at) VALUES(?,.49,0,'backfill','2026-09-06')",
    )
      .bind(first.id)
      .run();
    expect(await env.DB.prepare(sql).bind("AFLM", 2026).first()).toMatchObject({
      completed_matches: 2,
      predictions: 1,
      missing_predictions: 1,
      correct_winners: 1,
      decisive_matches: 1,
      draws: 0,
      accuracy_pct: 100,
      margin_mae: 11,
    });
    await env.DB.prepare("UPDATE matches SET home_points=80,away_points=80 WHERE id=?")
      .bind(second.id)
      .run();
    await env.DB.prepare(
      "INSERT INTO match_predictions(match_id,home_win_prob,predicted_margin,model_version,generated_at) VALUES(?,.6,5,'live','2026-03-19')",
    )
      .bind(second.id)
      .run();
    expect(await env.DB.prepare(sql).bind("AFLM", 2026).first()).toMatchObject({
      completed_matches: 2,
      predictions: 2,
      missing_predictions: 0,
      correct_winners: 1,
      decisive_matches: 1,
      draws: 1,
      accuracy_pct: 100,
      margin_mae: 8,
    });
    await env.DB.prepare("UPDATE matches SET status='Live' WHERE id=?").bind(second.id).run();
    expect(await env.DB.prepare(sql).bind("AFLM", 2026).first()).toMatchObject({
      completed_matches: 1,
      predictions: 1,
      draws: 0,
    });
    expect(await env.DB.prepare(sql).bind("AFLW", 2026).first()).toBeNull();
  });
});
