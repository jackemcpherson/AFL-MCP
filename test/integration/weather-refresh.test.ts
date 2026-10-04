import { env } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { refreshWeather, WeatherRefreshRequestSchema } from "../../src/admin/weather-refresh";

const evidence = [
  {
    url: "https://example.org/official-fixture",
    sha256: "a".repeat(64),
    explanation: "Captured official fixture corrects the previous weather window",
  },
];
afterEach(() => vi.unstubAllGlobals());

async function seed() {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO seasons(id,competition_id,year,season_key) VALUES(800,1,2026,'2026')",
    ),
    env.DB.prepare(
      "INSERT INTO teams(id,competition_id,name) VALUES(801,1,'Carlton'),(802,1,'Richmond')",
    ),
    env.DB.prepare(
      "INSERT INTO venues(id,name,latitude,longitude) VALUES(803,'Verified ground',-37.8,144.9)",
    ),
    env.DB.prepare(
      "INSERT INTO matches(id,season_id,round,date,local_time,kickoff_at,venue_id,home_team_id,away_team_id,status,home_points,away_points) VALUES(804,800,'R1','2026-03-19','19:30:00','2026-03-19T08:30:00.000Z',803,801,802,'Complete',80,69),(805,800,'R2','2026-03-20','19:30:00','2026-03-20T08:30:00.000Z',803,801,802,'Complete',80,69)",
    ),
    env.DB.prepare(
      "INSERT INTO match_weather(match_id,kind,source,fetched_at,temp_c) VALUES(804,'observed','era5_land+era5','2026-03-21',99),(805,'observed','era5_land+era5','2026-03-21',98)",
    ),
  ]);
}
function stubWeather() {
  const time = Array.from({ length: 72 }, (_, i) =>
    new Date(Date.UTC(2026, 2, 18, i)).toISOString().slice(0, 16),
  );
  const fill = (v: number) => time.map(() => v);
  const fetcher = vi.fn(async () =>
    Response.json({
      hourly: {
        time,
        temperature_2m: fill(15),
        precipitation: fill(0.5),
        relative_humidity_2m: fill(60),
        wind_speed_10m: fill(20),
        wind_gusts_10m: fill(30),
      },
    }),
  );
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
async function preview() {
  const request = WeatherRefreshRequestSchema.parse({
    competition: "AFLM",
    season: 2026,
    matchId: 804,
    evidence,
  });
  const result = await refreshWeather(env, request);
  if (!("manifestDigest" in result) || !result.manifestDigest) throw new Error("Missing preview");
  return { ...request, dryRun: false, manifestDigest: result.manifestDigest };
}

it("recomputes only the reviewed fixture and makes an approved rerun idempotent", async () => {
  await seed();
  const network = stubWeather();
  const request = await preview();
  expect(network).not.toHaveBeenCalled();
  await refreshWeather(env, request);
  expect(network).toHaveBeenCalledTimes(1);
  expect(
    await env.DB.prepare("SELECT temp_c FROM match_weather WHERE match_id=804").first("temp_c"),
  ).toBe(15);
  expect(
    await env.DB.prepare("SELECT temp_c FROM match_weather WHERE match_id=805").first("temp_c"),
  ).toBe(98);
  expect(
    await env.DB.prepare("SELECT in_progress FROM public_input_revision").first("in_progress"),
  ).toBe(0);
  expect(await refreshWeather(env, request)).toMatchObject({ idempotent: true });
  expect(network).toHaveBeenCalledTimes(1);
});

it("rejects changed weather or fixture context before deleting any observation", async () => {
  await seed();
  const network = stubWeather();
  const request = await preview();
  await env.DB.prepare("UPDATE match_weather SET temp_c=97 WHERE match_id=804").run();
  await expect(refreshWeather(env, request)).rejects.toThrow("stale");
  expect(
    await env.DB.prepare("SELECT temp_c FROM match_weather WHERE match_id=804").first("temp_c"),
  ).toBe(97);
  expect(network).not.toHaveBeenCalled();
});

it("retains the checkpoint on a database failure and resumes the same scope", async () => {
  await seed();
  stubWeather();
  const request = await preview();
  await env.DB.prepare(
    "CREATE TRIGGER fail_weather_refresh BEFORE INSERT ON match_weather BEGIN SELECT RAISE(ABORT,'injected weather failure'); END",
  ).run();
  try {
    await expect(refreshWeather(env, request)).rejects.toThrow("injected weather failure");
    expect(
      await env.DB.prepare("SELECT status FROM weather_repair_operations").first("status"),
    ).toBe("pending");
    expect(
      await env.DB.prepare("SELECT in_progress FROM public_input_revision").first("in_progress"),
    ).toBe(1);
    expect(await env.DB.prepare("SELECT holder FROM sync_lease").first("holder")).toBeNull();
  } finally {
    await env.DB.prepare("DROP TRIGGER fail_weather_refresh").run();
  }
  await expect(refreshWeather(env, request)).rejects.toThrow("resume");
  await refreshWeather(env, { ...request, resume: true });
  expect(
    await env.DB.prepare("SELECT temp_c FROM match_weather WHERE match_id=804").first("temp_c"),
  ).toBe(15);
  expect(
    await env.DB.prepare("SELECT in_progress FROM public_input_revision").first("in_progress"),
  ).toBe(0);
});

it("records provider failure as unknown weather with a real daily retry deadline", async () => {
  await seed();
  vi.stubGlobal("fetch", async () => new Response("unavailable", { status: 503 }));
  const request = await preview();
  await refreshWeather(env, request);
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS n FROM match_weather WHERE match_id=804").first("n"),
  ).toBe(0);
  const retry = await env.DB.prepare(
    "SELECT failures,diagnostic,attempted_at,next_retry_at FROM weather_refresh_state WHERE match_id=804",
  ).first<{ failures: number; diagnostic: string; attempted_at: string; next_retry_at: string }>();
  expect(retry?.failures).toBe(1);
  expect(retry?.diagnostic).toContain("503");
  if (!retry) throw new Error("Missing retry checkpoint");
  expect(Date.parse(retry.next_retry_at) - Date.parse(retry.attempted_at)).toBe(86400000);
  expect(
    await env.DB.prepare("SELECT in_progress FROM public_input_revision").first("in_progress"),
  ).toBe(0);
});

it("invalidates cached weather when kickoff or canonical venue context changes", async () => {
  await seed();
  await env.DB.prepare(
    "INSERT INTO weather_refresh_state(match_id,kind,source,attempted_at,failures,diagnostic) VALUES(804,'observed','era5_land+era5','2026-03-21',4,'old context')",
  ).run();
  await env.DB.prepare(
    "UPDATE matches SET kickoff_at='2026-03-19T09:00:00.000Z',local_time='20:00:00' WHERE id=804",
  ).run();
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS n FROM match_weather WHERE match_id=804").first("n"),
  ).toBe(0);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM weather_refresh_state WHERE match_id=804",
    ).first("n"),
  ).toBe(0);
  expect(
    await env.DB.prepare("SELECT temp_c FROM match_weather WHERE match_id=805").first("temp_c"),
  ).toBe(98);
  await env.DB.prepare("UPDATE venues SET latitude=-38 WHERE id=803").run();
  expect(
    await env.DB.prepare("SELECT COUNT(*) AS n FROM match_weather WHERE match_id=805").first("n"),
  ).toBe(0);
});

it("recovers a retained marker when the initial journal batch rolls back", async () => {
  await seed();
  const network = stubWeather();
  const request = await preview();
  await env.DB.prepare(
    "CREATE TRIGGER fail_weather_journal BEFORE INSERT ON weather_repair_operations BEGIN SELECT RAISE(ABORT,'injected journal failure'); END",
  ).run();
  try {
    await expect(refreshWeather(env, request)).rejects.toThrow("injected journal failure");
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM weather_repair_operations").first("n"),
    ).toBe(0);
    expect(
      await env.DB.prepare("SELECT temp_c FROM match_weather WHERE match_id=804").first("temp_c"),
    ).toBe(99);
    expect(
      await env.DB.prepare("SELECT in_progress FROM public_input_revision").first("in_progress"),
    ).toBe(1);
    expect(network).not.toHaveBeenCalled();
  } finally {
    await env.DB.prepare("DROP TRIGGER fail_weather_journal").run();
  }
  await expect(refreshWeather(env, request)).rejects.toThrow("recovered public marker");
  await refreshWeather(env, { ...request, resume: true });
  expect(
    await env.DB.prepare("SELECT temp_c FROM match_weather WHERE match_id=804").first("temp_c"),
  ).toBe(15);
  expect(
    await env.DB.prepare("SELECT in_progress FROM public_input_revision").first("in_progress"),
  ).toBe(0);
  expect(await refreshWeather(env, request)).toMatchObject({ idempotent: true });
  expect(network).toHaveBeenCalledTimes(1);
});
