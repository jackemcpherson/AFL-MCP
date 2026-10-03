import { applyD1Migrations, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

function venueSeed() {
  const migration = env.TEST_MIGRATIONS.find(
    (entry) => entry.name === "0025_venue_reference_seed.sql",
  );
  if (!migration) throw new Error("Venue seed migration is missing");
  return migration;
}

describe("coaching release migration paths", () => {
  it("seeds a fresh D1 with canonical venue coordinates and aliases", async () => {
    await env.DB.batch(venueSeed().queries.map((sql) => env.DB.prepare(sql)));
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM venues").first()).toEqual({ n: 106 });
    expect(await env.DB.prepare("PRAGMA foreign_key_check").all()).toMatchObject({ results: [] });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM venues v JOIN venues c ON c.id=v.canonical_venue_id WHERE v.id!=c.id",
      ).first(),
    ).toEqual({ n: 13 });
    const snapshot = await env.DB.prepare(
      "SELECT name,latitude,longitude,canonical_venue_id FROM venues ORDER BY name",
    ).all();
    await env.DB.batch(venueSeed().queries.map((sql) => env.DB.prepare(sql)));
    expect(
      await env.DB.prepare(
        "SELECT name,latitude,longitude,canonical_venue_id FROM venues ORDER BY name",
      ).all(),
    ).toMatchObject({ results: snapshot.results });
  });

  it("upgrades the previous Worker schema while preserving match and venue identities", async () => {
    const previous = env.TEST_MIGRATIONS.filter((entry) => entry.name < "0024");
    const additions = env.TEST_MIGRATIONS.filter((entry) => entry.name >= "0024");
    await applyD1Migrations(env.UPGRADE_DB, previous);
    await env.UPGRADE_DB.batch([
      env.UPGRADE_DB.prepare("INSERT INTO seasons(id,competition_id,year) VALUES(901,1,2024)"),
      env.UPGRADE_DB.prepare(
        "INSERT INTO teams(id,name,competition_id) VALUES(902,'Carlton',1),(903,'Richmond',1)",
      ),
      env.UPGRADE_DB.prepare("INSERT INTO venues(id,name) VALUES(905,'MCG')"),
      env.UPGRADE_DB.prepare(
        "INSERT INTO matches(id,season_id,round,date,home_team_id,away_team_id,venue_id) VALUES(904,901,'Round 1','2024-03-16',902,903,905)",
      ),
    ]);
    const before = await env.UPGRADE_DB.prepare(
      "SELECT id,season_id,home_team_id,away_team_id,venue_id FROM matches",
    ).all();
    await applyD1Migrations(env.UPGRADE_DB, additions);
    expect(
      await env.UPGRADE_DB.prepare(
        "SELECT id,season_id,home_team_id,away_team_id,venue_id FROM matches",
      ).all(),
    ).toMatchObject({ results: before.results });
    expect(
      await env.UPGRADE_DB.prepare(
        "SELECT id,latitude,longitude FROM venues WHERE name='MCG'",
      ).first(),
    ).toEqual({ id: 905, latitude: -37.82, longitude: 144.9834 });
    expect(await env.UPGRADE_DB.prepare("PRAGMA foreign_key_check").all()).toMatchObject({
      results: [],
    });
    // The old Worker's named-column write still works after the additive schema.
    await env.UPGRADE_DB.prepare(
      "UPDATE matches SET status='Complete',home_points=81,away_points=74 WHERE id=904",
    ).run();
    expect(
      await env.UPGRADE_DB.prepare("SELECT revision FROM public_input_revision WHERE id=1").first(),
    ).toEqual({ revision: 1 });
  });
});
