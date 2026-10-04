import { applyD1Migrations, env } from "cloudflare:test";
import { expect, it } from "vitest";
import { ensureCompetition, ensureSeason } from "../../src/sync/upserts";

it("upgrades the expanded schema without losing season IDs, dependencies or pending work", async () => {
  await applyD1Migrations(env.CONTRACT_DB, env.TEST_EXPANSION_MIGRATIONS);
  const contractEnv = { ...env, DB: env.CONTRACT_DB };
  const competition = await ensureCompetition(contractEnv, "AFLW");
  const six = await ensureSeason(contractEnv, competition, "2022-S6");
  await env.CONTRACT_DB.batch([
    env.CONTRACT_DB.prepare("INSERT INTO season_provider_ids VALUES(?1,'afl-api','41')").bind(six),
    env.CONTRACT_DB.prepare(
      "INSERT INTO pav_rebuild_queue VALUES(?1,'interrupted-test-repair')",
    ).bind(six),
    env.CONTRACT_DB.prepare(
      "INSERT INTO stats_refresh_operations VALUES('preserved',?1,NULL,'approved','2026-10-04')",
    ).bind(six),
    env.CONTRACT_DB.prepare(
      "INSERT INTO public_input_revision(id) VALUES(1) ON CONFLICT(id) DO NOTHING",
    ),
  ]);
  await expect(ensureSeason(contractEnv, competition, "2022-S7")).rejects.toThrow();
  const migrationCount = await env.CONTRACT_DB.prepare(
    "SELECT COUNT(*) AS n FROM d1_migrations",
  ).first<number>("n");
  await applyD1Migrations(env.CONTRACT_DB, env.TEST_CONTRACT_MIGRATIONS);
  const seven = await ensureSeason(contractEnv, competition, "2022-S7");
  expect(seven).toBeGreaterThan(six);
  expect(await ensureSeason(contractEnv, competition, "2022-S6")).toBe(six);
  expect(
    await env.CONTRACT_DB.prepare(
      "SELECT season_id FROM season_provider_ids WHERE provider_season_id='41'",
    ).first("season_id"),
  ).toBe(six);
  expect(
    await env.CONTRACT_DB.prepare("SELECT reason FROM pav_rebuild_queue WHERE season_id=?1")
      .bind(six)
      .first("reason"),
  ).toBe("interrupted-test-repair");
  expect(
    await env.CONTRACT_DB.prepare(
      "SELECT season_id FROM stats_refresh_operations WHERE id='preserved'",
    ).first("season_id"),
  ).toBe(six);
  expect((await env.CONTRACT_DB.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  expect(await env.CONTRACT_DB.prepare("SELECT COUNT(*) AS n FROM d1_migrations").first("n")).toBe(
    (migrationCount ?? 0) + 1,
  );
  await expect(
    env.CONTRACT_DB.prepare(
      "INSERT INTO seasons(competition_id,year,season_key) VALUES(?1,2022,'2022')",
    )
      .bind(competition)
      .run(),
  ).rejects.toThrow("Ambiguous");
  await expect(
    env.CONTRACT_DB.prepare(
      "INSERT INTO seasons(competition_id,year,season_key) VALUES(?1,2022,'2022-S7')",
    )
      .bind(competition)
      .run(),
  ).rejects.toThrow("UNIQUE");
  const men = await ensureCompetition(contractEnv, "AFLM");
  await expect(
    env.CONTRACT_DB.prepare(
      "INSERT INTO seasons(competition_id,year,season_key) VALUES(?1,2022,'2022-S6')",
    )
      .bind(men)
      .run(),
  ).rejects.toThrow("invalid");
});
