import { applyD1Migrations, env } from "cloudflare:test";
import { expect, it } from "vitest";

it("corrects interchange flags while preserving genuine substitutes and unverified retirement imports", async () => {
  const before = env.TEST_MIGRATIONS.filter((m) => m.name < "0041");
  const fix = env.TEST_MIGRATIONS.filter((m) => m.name.startsWith("0041"));
  await applyD1Migrations(env.GUARD_DB, before);
  await env.GUARD_DB.batch([
    env.GUARD_DB.prepare(
      "INSERT INTO seasons(id,competition_id,year,season_key) VALUES(601,1,2026,'2026')",
    ),
    env.GUARD_DB.prepare(
      "INSERT INTO teams(id,competition_id,name) VALUES(602,1,'Carlton'),(603,1,'Richmond')",
    ),
    env.GUARD_DB.prepare(
      "INSERT INTO players(id,surname,is_retired) VALUES(604,'Active inference',0),(605,'Retired inference',1)",
    ),
    env.GUARD_DB.prepare(
      "INSERT INTO matches(id,season_id,date,round,home_team_id,away_team_id) VALUES(606,601,'2026-03-19','R1',602,603)",
    ),
    env.GUARD_DB.prepare(
      "INSERT INTO match_lineups(match_id,player_id,team_id,position,is_substitute) VALUES(606,604,602,'INT',1),(606,605,603,'SUB',1)",
    ),
  ]);
  await applyD1Migrations(env.GUARD_DB, fix);
  expect(
    (
      await env.GUARD_DB.prepare(
        "SELECT position,is_substitute FROM match_lineups ORDER BY player_id",
      ).all()
    ).results,
  ).toEqual([
    { position: "INT", is_substitute: 0 },
    { position: "SUB", is_substitute: 1 },
  ]);
  expect(
    (
      await env.GUARD_DB.prepare(
        "SELECT legacy_is_retired,is_retired FROM players ORDER BY id",
      ).all()
    ).results,
  ).toEqual([
    { legacy_is_retired: 0, is_retired: null },
    { legacy_is_retired: 1, is_retired: null },
  ]);
  await env.GUARD_DB.prepare(
    "INSERT INTO players(id,surname) VALUES(607,'Unverified new player')",
  ).run();
  expect(
    await env.GUARD_DB.prepare("SELECT is_retired FROM players WHERE id=607").first("is_retired"),
  ).toBeNull();
});
