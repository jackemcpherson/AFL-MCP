import { applyD1Migrations, env } from "cloudflare:test";
import { expect, it } from "vitest";

it("repairs listed clearance totals, skips changed rows and queues one PAV rebuild", async () => {
  const before = env.TEST_MIGRATIONS.filter((m) => m.name < "0045");
  const fix = env.TEST_MIGRATIONS.filter((m) => m.name.startsWith("0045"));
  await applyD1Migrations(env.GUARD_DB, before);
  await env.GUARD_DB.batch([
    env.GUARD_DB.prepare(
      "INSERT INTO seasons(id,competition_id,year,season_key) VALUES(701,1,2016,'2016')",
    ),
    env.GUARD_DB.prepare(
      "INSERT INTO teams(id,competition_id,name) VALUES(702,1,'Carlton'),(703,1,'Richmond')",
    ),
    env.GUARD_DB.prepare(
      "INSERT INTO players(id,surname) VALUES(4,'Gibbs'),(5,'Untouched'),(9,'Jamison'),(24,'Ellis'),(46,'Changed')",
    ),
    env.GUARD_DB.prepare(
      "INSERT INTO matches(id,season_id,date,round,home_team_id,away_team_id) VALUES(704,701,'2016-03-24','Round 1',703,702)",
    ),
    // Rows 4, 9 and 24 hold their verified production values. Row 5 is not in
    // the repair. Row 46 is in the repair but its components changed since.
    env.GUARD_DB.prepare(
      `INSERT INTO player_match_stats(id,match_id,player_id,team_id,centre_clearances,stoppage_clearances,clearances)
       VALUES(4,704,4,702,2,1,2),(5,704,5,702,1,0,3),(9,704,9,702,0,0,1),(24,704,24,703,1,1,3),(46,704,46,703,1,1,3)`,
    ),
  ]);
  await env.GUARD_DB.prepare("DELETE FROM pav_rebuild_queue").run();
  const revision = await env.GUARD_DB.prepare(
    "SELECT revision FROM public_input_revision WHERE id=1",
  ).first<number>("revision");

  expect(
    (
      await env.GUARD_DB.prepare(
        "SELECT id FROM player_match_stats WHERE clearances != centre_clearances + stoppage_clearances ORDER BY id",
      ).all()
    ).results,
  ).toEqual([{ id: 4 }, { id: 5 }, { id: 9 }, { id: 24 }, { id: 46 }]);
  await applyD1Migrations(env.GUARD_DB, fix);

  expect(
    (
      await env.GUARD_DB.prepare(
        "SELECT id,centre_clearances,stoppage_clearances,clearances FROM player_match_stats ORDER BY id",
      ).all()
    ).results,
  ).toEqual([
    { id: 4, centre_clearances: 2, stoppage_clearances: 1, clearances: 3 },
    { id: 5, centre_clearances: 1, stoppage_clearances: 0, clearances: 3 },
    { id: 9, centre_clearances: 0, stoppage_clearances: 0, clearances: 0 },
    { id: 24, centre_clearances: 1, stoppage_clearances: 1, clearances: 2 },
    { id: 46, centre_clearances: 1, stoppage_clearances: 1, clearances: 3 },
  ]);
  expect(
    (await env.GUARD_DB.prepare("SELECT row_id FROM v_integrity_clearances ORDER BY row_id").all())
      .results,
  ).toEqual([{ row_id: 5 }, { row_id: 46 }]);
  expect(
    (await env.GUARD_DB.prepare("SELECT season_id,reason FROM pav_rebuild_queue").all()).results,
  ).toEqual([{ season_id: 701, reason: "statistics" }]);
  expect(
    await env.GUARD_DB.prepare("SELECT revision FROM public_input_revision WHERE id=1").first(
      "revision",
    ),
  ).toBe((revision ?? 0) + 3);
});
