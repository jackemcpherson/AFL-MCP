import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import { retryWeather, WeatherRetryRequestSchema } from "../../src/admin/weather-retry";

it("retries only the reviewed match and rejects a stale diagnostic preview", async () => {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO seasons(id,competition_id,year,season_key) VALUES(1,1,2026,'2026'),(2,1,2025,'2025')",
    ),
    env.DB.prepare(
      "INSERT INTO teams(id,name,competition_id) VALUES(1,'Carlton',1),(2,'Richmond',1)",
    ),
    env.DB.prepare(
      "INSERT INTO matches(id,season_id,date,round,home_team_id,away_team_id) VALUES(1,1,'2026-06-01','R1',1,2),(2,2,'2025-06-01','R1',1,2)",
    ),
    env.DB.prepare(
      "INSERT INTO weather_refresh_state(match_id,kind,source,attempted_at,failures,diagnostic) VALUES(1,'observed','era5_land+era5','2026-09-01',4,'partial'),(2,'observed','era5_land+era5','2026-09-01',4,'partial')",
    ),
  ]);
  const scope = { competition: "AFLM", season: 2026, matchId: 1 };
  const preview = await retryWeather(env, WeatherRetryRequestSchema.parse(scope));
  if (!("manifestDigest" in preview)) throw new Error("Expected preview");
  await env.DB.prepare(
    "UPDATE weather_refresh_state SET diagnostic='corrected diagnostic' WHERE match_id=1",
  ).run();
  await expect(
    retryWeather(
      env,
      WeatherRetryRequestSchema.parse({
        ...scope,
        dryRun: false,
        manifestDigest: preview.manifestDigest,
      }),
    ),
  ).rejects.toThrow("stale");
  const fresh = await retryWeather(env, WeatherRetryRequestSchema.parse(scope));
  if (!("manifestDigest" in fresh)) throw new Error("Expected preview");
  expect(
    await retryWeather(
      env,
      WeatherRetryRequestSchema.parse({
        ...scope,
        dryRun: false,
        manifestDigest: fresh.manifestDigest,
      }),
    ),
  ).toMatchObject({ queued: 1 });
  expect(
    (
      await env.DB.prepare(
        "SELECT match_id,failures,diagnostic,next_retry_at FROM weather_refresh_state ORDER BY match_id",
      ).all()
    ).results,
  ).toEqual([
    {
      match_id: 1,
      failures: 0,
      diagnostic: "corrected diagnostic",
      next_retry_at: expect.any(String),
    },
    { match_id: 2, failures: 4, diagnostic: "partial", next_retry_at: null },
  ]);
});
