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

async function counts() {
  return env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM tipper_reconstruction_batches) AS batches,
      (SELECT COUNT(*) FROM tipper_reconstructions) AS predictions`,
  ).first();
}

describe("separate historical reconstruction storage", () => {
  it("finalizes complete batches and preserves issued precision and full-precision winners", async () => {
    const { first, second } = await seedFixtures();
    await env.DB.batch([
      batch(2),
      prediction(first, 0, "home", 0.5),
      prediction(second, -0.04, "away", 0.49),
      finalize(),
    ]);
    expect(await counts()).toEqual({ batches: 1, predictions: 2 });
    expect(
      await env.DB.prepare("SELECT completed_at FROM tipper_reconstruction_batches").first(),
    ).toEqual({ completed_at: "2026-09-06T00:01:00.000Z" });
    expect(
      (
        await env.DB.prepare(
          "SELECT margin,winner,issued_margin FROM tipper_reconstructions ORDER BY match_id",
        ).all()
      ).results,
    ).toEqual([
      { margin: 0, winner: "home", issued_margin: 0 },
      { margin: -0.04, winner: "away", issued_margin: 0 },
    ]);
  });

  it("rolls back the batch and staged predictions when finalization finds missing matches", async () => {
    const { first } = await seedFixtures();
    await expect(env.DB.batch([batch(2), prediction(first), finalize()])).rejects.toThrow(
      "incomplete reconstruction batch",
    );
    expect(await counts()).toEqual({ batches: 0, predictions: 0 });
  });

  it.each([
    { margin: -1, winner: "home", probability: 0.6 },
    { margin: 0, winner: "away", probability: 0.5 },
    { margin: 1, winner: "home", probability: 1 },
    { margin: -1, winner: "away", probability: 0 },
  ])("rolls back invalid output $margin/$winner/$probability", async (output) => {
    const { first } = await seedFixtures();
    await expect(
      env.DB.batch([
        batch(),
        prediction(first, output.margin, output.winner, output.probability),
        finalize(),
      ]),
    ).rejects.toThrow("CHECK constraint failed");
    expect(await counts()).toEqual({ batches: 0, predictions: 0 });
  });

  it("rejects duplicate predictions and preserves the original staged evidence", async () => {
    const { first } = await seedFixtures();
    await env.DB.batch([batch(), prediction(first)]);
    await expect(prediction(first, -2, "away", 0.4).run()).rejects.toThrow(
      "UNIQUE constraint failed",
    );
    expect(await counts()).toEqual({ batches: 1, predictions: 1 });
    expect(await env.DB.prepare("SELECT margin FROM tipper_reconstructions").first()).toEqual({
      margin: 1.04,
    });
  });

  it("rejects additional matches after a batch completes", async () => {
    const { first, second } = await seedFixtures();
    await env.DB.batch([batch(), prediction(first), finalize()]);
    await expect(prediction(second).run()).rejects.toThrow(
      "reconstruction batch already completed",
    );
    expect(await counts()).toEqual({ batches: 1, predictions: 1 });
  });

  it("keeps staged reconstructions out of current and prospectively captured tips", async () => {
    const { first } = await seedFixtures();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO tipper_runs
          (id,competition,season,round,started_at,source_revision,model_version,published_at,published_count)
          VALUES (1,'AFLM',2026,1,'2026-03-19T08:00:00.000Z',?,'issued',
          '2026-03-19T08:00:01.000Z',1)`,
      ).bind("b".repeat(40)),
      env.DB.prepare(
        `INSERT INTO tipper_predictions
          (run_id,match_id,season_id,round_number,home_team_id,away_team_id,kickoff_at,margin,
          home_probability,winner,issued_margin,issued_probability,provisional,evidence,observed_at,published_at)
          VALUES (1,?,?,1,?,?,'2026-03-19T08:30:00.000Z',10,.6,'home',10,.6,1,'{}',
          '2026-03-19T08:00:00.000Z','2026-03-19T08:00:01.000Z')`,
      ).bind(first.id, first.season_id, first.home_team_id, first.away_team_id),
      env.DB.prepare(
        `INSERT INTO match_predictions
          (match_id,home_win_prob,predicted_margin,model_version,generated_at,tipper_run_id)
          VALUES (?,.6,10,'issued','2026-03-19T08:00:01.000Z',1)`,
      ).bind(first.id),
    ]);
    const before = await env.DB.batch([
      env.DB.prepare("SELECT * FROM match_predictions"),
      env.DB.prepare("SELECT * FROM tipper_predictions"),
    ]);
    await env.DB.batch([batch(), prediction(first, -2, "away", 0.4)]);
    const after = await env.DB.batch([
      env.DB.prepare("SELECT * FROM match_predictions"),
      env.DB.prepare("SELECT * FROM tipper_predictions"),
    ]);
    expect(after.map((result) => result.results)).toEqual(before.map((result) => result.results));
    expect(
      await env.DB.prepare("SELECT completed_at FROM tipper_reconstruction_batches").first(),
    ).toEqual({ completed_at: null });
  });
});
