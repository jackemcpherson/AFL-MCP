import { applyD1Migrations, env } from "cloudflare:test";
import { expect, it } from "vitest";
import { ensureCompetition, ensureSeason } from "../../src/sync/upserts";

it("upgrades the expanded schema without losing season IDs, dependencies or pending work", async () => {
  const competition = await ensureCompetition(env, "AFLW");
  const six = await ensureSeason(env, competition, "2022-S6");
  await env.DB.batch([
    env.DB.prepare("INSERT INTO season_provider_ids VALUES(?1,'afl-api','41')").bind(six),
    env.DB.prepare("INSERT INTO pav_rebuild_queue VALUES(?1,'interrupted-test-repair')").bind(six),
    env.DB.prepare(
      "INSERT INTO stats_refresh_operations VALUES('preserved',?1,NULL,'approved','2026-10-04')",
    ).bind(six),
    env.DB.prepare("INSERT INTO public_input_revision(id) VALUES(1) ON CONFLICT(id) DO NOTHING"),
  ]);
  await expect(ensureSeason(env, competition, "2022-S7")).rejects.toThrow();
  const migrationCount = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM d1_migrations",
  ).first<number>("n");
  await applyD1Migrations(env.DB, env.TEST_CONTRACT_MIGRATIONS);
  const seven = await ensureSeason(env, competition, "2022-S7");
  expect(seven).toBeGreaterThan(six);
  expect(await ensureSeason(env, competition, "2022-S6")).toBe(six);
  expect(
    await env.DB.prepare(
      "SELECT season_id FROM season_provider_ids WHERE provider_season_id='41'",
    ).first("season_id"),
  ).toBe(six);
  expect(
    await env.DB.prepare("SELECT reason FROM pav_rebuild_queue WHERE season_id=?1")
      .bind(six)
      .first("reason"),
  ).toBe("interrupted-test-repair");
  expect(
    await env.DB.prepare(
      "SELECT season_id FROM stats_refresh_operations WHERE id='preserved'",
    ).first("season_id"),
  ).toBe(six);
  expect((await env.DB.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM d1_migrations").first("n")).toBe(
    (migrationCount ?? 0) + 1,
  );
  await expect(
    env.DB.prepare("INSERT INTO seasons(competition_id,year,season_key) VALUES(?1,2022,'2022')")
      .bind(competition)
      .run(),
  ).rejects.toThrow("Ambiguous");
  await expect(
    env.DB.prepare("INSERT INTO seasons(competition_id,year,season_key) VALUES(?1,2022,'2022-S7')")
      .bind(competition)
      .run(),
  ).rejects.toThrow("UNIQUE");
  const men = await ensureCompetition(env, "AFLM");
  await expect(
    env.DB.prepare("INSERT INTO seasons(competition_id,year,season_key) VALUES(?1,2022,'2022-S6')")
      .bind(men)
      .run(),
  ).rejects.toThrow("invalid");
});
