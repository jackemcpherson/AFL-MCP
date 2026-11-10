import { applyD1Migrations, env } from "cloudflare:test";
import { expect, it } from "vitest";

it("completes seasons held open by cancelled matches and ends fetched historical requests", async () => {
  const before = env.TEST_MIGRATIONS.filter((m) => m.name < "0046");
  const fix = env.TEST_MIGRATIONS.filter((m) => m.name.startsWith("0046"));
  await applyD1Migrations(env.GUARD_DB, before);
  const match = (id: number, season: number, date: string, status: string, points: number | null) =>
    env.GUARD_DB.prepare(
      "INSERT INTO matches(id,season_id,date,round,home_team_id,away_team_id,status,home_points) VALUES(?1,?2,?3,'R1',702,703,?4,?5)",
    ).bind(id, season, date, status, points);
  const refresh = (id: number, origin: string, succeededAt: string | null) =>
    env.GUARD_DB.prepare(
      "INSERT INTO match_stats_refresh(match_id,completed_observed_at,next_retry_at,succeeded_at,origin) VALUES(?1,'2026-10-04T00:00:00Z','2026-10-04T01:00:00Z',?2,?3)",
    ).bind(id, succeededAt, origin);
  await env.GUARD_DB.batch([
    env.GUARD_DB.prepare(
      "INSERT INTO seasons(id,competition_id,year,season_key,is_complete) VALUES(711,1,2015,'2015',0),(712,1,2026,'2026',1),(713,1,2014,'2014',0)",
    ),
    env.GUARD_DB.prepare(
      "INSERT INTO teams(id,competition_id,name) VALUES(702,1,'Carlton'),(703,1,'Richmond')",
    ),
    match(721, 711, "2015-07-01", "Complete", 80),
    match(722, 711, "2015-07-05", "Cancelled", null),
    match(723, 712, "2026-09-20", "Complete", 80),
    match(724, 712, "2026-09-27", "Live", 30),
    refresh(721, "operator", "2026-10-04T00:30:00Z"),
    refresh(722, "operator", null),
    refresh(723, "scheduled", "2026-10-04T00:30:00Z"),
  ]);
  await applyD1Migrations(env.GUARD_DB, fix);
  expect(
    (
      await env.GUARD_DB.prepare(
        "SELECT id,is_complete FROM seasons WHERE id>=711 ORDER BY id",
      ).all()
    ).results,
  ).toEqual([
    { id: 711, is_complete: 1 },
    { id: 712, is_complete: 0 },
    { id: 713, is_complete: 0 },
  ]);
  expect(
    (
      await env.GUARD_DB.prepare(
        "SELECT match_id,next_retry_at IS NULL AS done FROM match_stats_refresh ORDER BY match_id",
      ).all()
    ).results,
  ).toEqual([
    { match_id: 721, done: 1 },
    { match_id: 722, done: 0 },
    { match_id: 723, done: 0 },
  ]);
});
