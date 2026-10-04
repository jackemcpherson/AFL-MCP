import { applyD1Migrations, env } from "cloudflare:test";
import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import { describe, expect, it } from "vitest";

function legacy(prefix: string) {
  const migration = env.TEST_LEGACY_MIGRATIONS.find((entry) => entry.name.startsWith(prefix));
  if (!migration) throw new Error(`Missing immutable migration fixture: ${prefix}`);
  return migration;
}

const nextMigration: D1Migration = {
  name: "0028_test_future_change.sql",
  queries: ["ALTER TABLE coaches ADD COLUMN release_test TEXT"],
};

describe("migration baseline paths", () => {
  it("creates a fresh D1 with reference seeds and accepts later migrations", async () => {
    await applyD1Migrations(env.FRESH_DB, env.TEST_MIGRATIONS);
    expect(await env.FRESH_DB.prepare("SELECT COUNT(*) AS n FROM venues").first()).toEqual({
      n: 106,
    });
    expect(await env.FRESH_DB.prepare("PRAGMA foreign_key_check").all()).toMatchObject({
      results: [],
    });
    expect(
      await env.FRESH_DB.prepare(
        "SELECT COUNT(*) AS n FROM venues v JOIN venues c ON c.id=v.canonical_venue_id WHERE v.id!=c.id",
      ).first(),
    ).toEqual({ n: 13 });
    expect(await env.FRESH_DB.prepare("SELECT holder FROM sync_lease WHERE id=1").first()).toEqual({
      holder: null,
    });
    expect(
      await env.FRESH_DB.prepare(
        "SELECT revision,in_progress FROM public_input_revision WHERE id=1",
      ).first(),
    ).toEqual({ revision: 0, in_progress: 0 });
    await applyD1Migrations(env.FRESH_DB, [nextMigration]);
    expect(await env.FRESH_DB.prepare("SELECT release_test FROM coaches").all()).toMatchObject({
      results: [],
    });
  });

  it("skips the adopted baseline while preserving existing data and accepting later migrations", async () => {
    await applyD1Migrations(env.UPGRADE_DB, [legacy("0000")]);
    await env.UPGRADE_DB.batch([
      env.UPGRADE_DB.prepare("INSERT INTO seasons(id,competition_id,year) VALUES(901,1,2024)"),
      env.UPGRADE_DB.prepare(
        "INSERT INTO teams(id,name,competition_id) VALUES(902,'Carlton',1),(903,'Richmond',1)",
      ),
      env.UPGRADE_DB.prepare(
        "INSERT INTO venues(id,name,latitude,longitude) VALUES(905,'Operator Venue',-37,144)",
      ),
      env.UPGRADE_DB.prepare(
        "INSERT INTO matches(id,season_id,round,date,home_team_id,away_team_id,venue_id) VALUES(904,901,'Round 1','2024-03-16',902,903,905)",
      ),
    ]);
    const before = await env.UPGRADE_DB.prepare(
      "SELECT id,season_id,home_team_id,away_team_id,venue_id FROM matches",
    ).all();
    await applyD1Migrations(env.UPGRADE_DB, [legacy("0026")]);
    // An attempted baseline CREATE would fail against the existing tables.
    await applyD1Migrations(env.UPGRADE_DB, env.TEST_MIGRATIONS);
    expect(
      await env.UPGRADE_DB.prepare(
        "SELECT id,season_id,home_team_id,away_team_id,venue_id FROM matches",
      ).all(),
    ).toMatchObject({ results: before.results });
    expect(
      await env.UPGRADE_DB.prepare("SELECT id,latitude,longitude FROM venues WHERE id=905").first(),
    ).toEqual({ id: 905, latitude: -37, longitude: 144 });
    expect(await env.UPGRADE_DB.prepare("SELECT COUNT(*) AS n FROM venues").first()).toEqual({
      n: 107,
    });
    expect(await env.UPGRADE_DB.prepare("PRAGMA foreign_key_check").all()).toMatchObject({
      results: [],
    });
    await applyD1Migrations(env.UPGRADE_DB, [nextMigration]);
    expect(await env.UPGRADE_DB.prepare("SELECT release_test FROM coaches").all()).toMatchObject({
      results: [],
    });
    await env.UPGRADE_DB.prepare(
      "UPDATE matches SET status='Complete',home_points=81,away_points=74 WHERE id=904",
    ).run();
    expect(
      await env.UPGRADE_DB.prepare("SELECT revision FROM public_input_revision WHERE id=1").first(),
    ).toEqual({ revision: 2 });
  });
});

describe("baseline adoption", () => {
  it("registers the future baseline only after every prerequisite migration", async () => {
    const adoption = legacy("0026");
    await applyD1Migrations(env.GUARD_DB, [legacy("0000")]);
    const prerequisite = "0025_venue_reference_seed.sql";
    await env.GUARD_DB.prepare("DELETE FROM d1_migrations WHERE name=?").bind(prerequisite).run();
    await expect(applyD1Migrations(env.GUARD_DB, [adoption])).rejects.toThrow();
    expect(
      await env.GUARD_DB.prepare(
        "SELECT name FROM d1_migrations WHERE name='0027_baseline.sql'",
      ).first(),
    ).toBeNull();
    expect(
      await env.GUARD_DB.prepare(
        "SELECT name FROM sqlite_master WHERE name='_baseline_adoption_guard'",
      ).first(),
    ).toBeNull();
    await env.GUARD_DB.prepare("INSERT INTO d1_migrations(name) VALUES(?)")
      .bind(prerequisite)
      .run();
    await applyD1Migrations(env.GUARD_DB, [adoption]);
    await env.GUARD_DB.batch(adoption.queries.map((sql) => env.GUARD_DB.prepare(sql)));
    expect(
      await env.GUARD_DB.prepare(
        "SELECT COUNT(*) AS n FROM d1_migrations WHERE name='0027_baseline.sql'",
      ).first(),
    ).toEqual({ n: 1 });
    expect(await env.GUARD_DB.prepare("SELECT COUNT(*) AS n FROM venues").first()).toEqual({
      n: 106,
    });
  });
});
