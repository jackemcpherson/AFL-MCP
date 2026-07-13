import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { runWeatherStage } from "../../src/weather/stage";

/**
 * Integration tests for the sync weather stage: external behaviour only —
 * rows in D1 and calls made to the stubbed Open-Meteo fetch, driven by an
 * injected clock. Fixed "now": 2026-07-13T02:00:00Z = Monday 12:00
 * Melbourne (AEST, UTC+10).
 */
const NOW = new Date("2026-07-13T02:00:00Z");
const TODAY_MELB = "2026-07-13";

const MCG = { id: 18, lat: -37.82, lon: 144.9834 };

async function seedSeason(): Promise<number> {
  const competition = await env.DB.prepare(
    "SELECT id FROM competitions WHERE code = 'AFLM'",
  ).first<{ id: number }>();
  if (!competition) throw new Error("AFLM seed missing");
  await env.DB.prepare("INSERT INTO seasons (competition_id, year) VALUES (?, 2026)")
    .bind(competition.id)
    .run();
  const season = await env.DB.prepare(
    "SELECT id FROM seasons WHERE competition_id = ? AND year = 2026",
  )
    .bind(competition.id)
    .first<{ id: number }>();
  if (!season) throw new Error("season seed failed");
  for (const name of ["Carlton", "Richmond"]) {
    await env.DB.prepare("INSERT INTO teams (name, competition_id) VALUES (?, ?)")
      .bind(name, competition.id)
      .run();
  }
  return season.id;
}

async function seedVenue(venue: {
  id: number;
  name?: string;
  lat?: number | null;
  lon?: number | null;
  roof?: string | null;
  canonicalId?: number | null;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO venues (id, name, latitude, longitude, timezone, roof, canonical_venue_id)
     VALUES (?, ?, ?, ?, 'Australia/Melbourne', ?, ?)`,
  )
    .bind(
      venue.id,
      venue.name ?? `Venue ${venue.id}`,
      venue.lat ?? null,
      venue.lon ?? null,
      venue.roof ?? "none",
      venue.canonicalId ?? venue.id,
    )
    .run();
}

let nextMatchNumber = 1;

async function seedMatch(match: {
  seasonId: number;
  date: string;
  localTime?: string;
  venueId?: number;
  status?: string | null;
  homePoints?: number | null;
}): Promise<number> {
  const teams = await env.DB.prepare("SELECT id FROM teams ORDER BY id").all<{ id: number }>();
  const n = nextMatchNumber++;
  // Alternate home/away so two same-day fixtures don't collide on the
  // (date, home_team_id, away_team_id) unique constraint.
  const home = teams.results[n % 2];
  const away = teams.results[(n + 1) % 2];
  if (!home || !away) throw new Error("team seed missing");
  const result = await env.DB.prepare(
    `INSERT INTO matches (season_id, round, round_number, date, local_time, venue_id,
       home_team_id, away_team_id, status, home_points, away_points, external_afl_id)
     VALUES (?, 'Round 1', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      match.seasonId,
      match.date,
      match.localTime ?? "19:40:00",
      match.venueId ?? MCG.id,
      home.id,
      away.id,
      match.status === undefined ? "Upcoming" : match.status,
      match.homePoints ?? null,
      match.homePoints ?? null,
      `W-${n}`,
    )
    .run();
  return Number(result.meta.last_row_id);
}

async function seedWeatherRow(row: {
  matchId: number;
  kind: "observed" | "forecast";
  source: string;
  fetchedAt: string;
  tempC?: number | null;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO match_weather (match_id, kind, temp_c, source, fetched_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(row.matchId, row.kind, row.tempC ?? 99, row.source, row.fetchedAt)
    .run();
}

interface WeatherRow {
  match_id: number;
  kind: string;
  temp_c: number | null;
  precip_mm: number | null;
  precip_24h_prior_mm: number | null;
  wind_speed_kmh: number | null;
  wind_gust_kmh: number | null;
  humidity_pct: number | null;
  source: string;
  fetched_at: string;
}

async function weatherRows(matchId: number): Promise<WeatherRow[]> {
  const rows = await env.DB.prepare("SELECT * FROM match_weather WHERE match_id = ? ORDER BY kind")
    .bind(matchId)
    .all<WeatherRow>();
  return rows.results;
}

/** Canned Open-Meteo payload: constant hourly values spanning the requested days. */
function cannedPayload(
  startDate: string,
  days: number,
  options: { modelSuffixes?: boolean; temp?: number },
) {
  const hours = days * 24;
  const time: string[] = [];
  const [y = 0, m = 1, d = 1] = startDate.split("-").map(Number);
  for (let i = 0; i < hours; i++) {
    time.push(`${new Date(Date.UTC(y, m - 1, d, i)).toISOString().slice(0, 13)}:00`);
  }
  const fill = (v: number | null) => new Array<number | null>(hours).fill(v);
  const temp = options.temp ?? 15;
  const hourly: Record<string, unknown> = options.modelSuffixes
    ? {
        time,
        temperature_2m_era5_land: fill(temp),
        temperature_2m_era5: fill(temp - 2),
        precipitation_era5_land: fill(null),
        precipitation_era5: fill(0.5),
        relative_humidity_2m_era5_land: fill(60),
        relative_humidity_2m_era5: fill(50),
        wind_speed_10m_era5_land: fill(20),
        wind_speed_10m_era5: fill(10),
        wind_gusts_10m_era5_land: fill(35),
        wind_gusts_10m_era5: fill(25),
      }
    : {
        time,
        temperature_2m: fill(temp),
        precipitation: fill(0.5),
        relative_humidity_2m: fill(60),
        wind_speed_10m: fill(20),
        wind_gusts_10m: fill(35),
      };
  return { hourly };
}

/**
 * Stub fetch recording every requested URL. Responds with a canned payload
 * whose hourly time axis spans exactly the start_date..end_date range of
 * the request, mirroring the real API.
 */
function stubFetch(options: { modelSuffixes?: boolean; temp?: number; status?: number } = {}) {
  const calls: URL[] = [];
  const impl = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    calls.push(url);
    if (options.status !== undefined && options.status !== 200) {
      return new Response("upstream error", { status: options.status });
    }
    const startDate = url.searchParams.get("start_date") ?? "2026-07-12";
    const endDate = url.searchParams.get("end_date") ?? startDate;
    const dayMs = 24 * 60 * 60 * 1000;
    const days = Math.round((Date.parse(endDate) - Date.parse(startDate)) / dayMs) + 1;
    return Response.json(cannedPayload(startDate, days, options));
  }) as typeof fetch;
  return { impl, calls };
}

async function syncLogRows(): Promise<{ type: string; error: string | null }[]> {
  const rows = await env.DB.prepare("SELECT type, error FROM sync_log").all<{
    type: string;
    error: string | null;
  }>();
  return rows.results;
}

describe("runWeatherStage — forecasts", () => {
  it("creates a forecast for a match within 7 days, but not beyond", async () => {
    const seasonId = await seedSeason();
    await seedVenue({ id: MCG.id, name: "MCG", lat: MCG.lat, lon: MCG.lon });
    const near = await seedMatch({ seasonId, date: "2026-07-18" }); // 5 days out
    const far = await seedMatch({ seasonId, date: "2026-07-23" }); // 10 days out

    const { impl, calls } = stubFetch();
    await runWeatherStage(env, impl, NOW);

    const nearRows = await weatherRows(near);
    expect(nearRows).toHaveLength(1);
    expect(nearRows[0]).toMatchObject({
      kind: "forecast",
      source: "best_match",
      temp_c: 15,
      precip_mm: 1.5,
      precip_24h_prior_mm: 12,
      wind_speed_kmh: 20,
      wind_gust_kmh: 35,
      humidity_pct: 60,
      fetched_at: NOW.toISOString(),
    });
    expect(await weatherRows(far)).toHaveLength(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.host).toBe("api.open-meteo.com");
    expect(calls[0]?.searchParams.get("timezone")).toBe("Australia/Melbourne");
    expect(calls[0]?.searchParams.get("start_date")).toBe("2026-07-17");
    expect(calls[0]?.searchParams.get("end_date")).toBe("2026-07-19");
  });

  it("aggregates all 3 hours of a night game whose window crosses midnight", async () => {
    const seasonId = await seedSeason();
    await seedVenue({ id: MCG.id, lat: MCG.lat, lon: MCG.lon });
    // 22:40 start: window hours 22:00, 23:00 on match day and 00:00 the day
    // after — the request must extend past the match date to cover them.
    const match = await seedMatch({ seasonId, date: "2026-07-16", localTime: "22:40:00" });

    const { impl, calls } = stubFetch();
    await runWeatherStage(env, impl, NOW);

    expect(calls[0]?.searchParams.get("end_date")).toBe("2026-07-17");
    const rows = await weatherRows(match);
    // 3 hours x 0.5mm — a truncated window would only total 1.0.
    expect(rows[0]).toMatchObject({ precip_mm: 1.5, temp_c: 15 });
  });

  it("refreshes daily before match day: refetches yesterday's forecast, keeps today's", async () => {
    const seasonId = await seedSeason();
    await seedVenue({ id: MCG.id, lat: MCG.lat, lon: MCG.lon });
    const fresh = await seedMatch({ seasonId, date: "2026-07-16" });
    const stale = await seedMatch({ seasonId, date: "2026-07-17" });
    // Fetched earlier today (Melbourne): 2026-07-13 10:00 AEST.
    await seedWeatherRow({
      matchId: fresh,
      kind: "forecast",
      source: "best_match",
      fetchedAt: "2026-07-13T00:00:00.000Z",
    });
    // Fetched yesterday (Melbourne): 2026-07-12 20:00 AEST.
    await seedWeatherRow({
      matchId: stale,
      kind: "forecast",
      source: "best_match",
      fetchedAt: "2026-07-12T10:00:00.000Z",
    });

    const { impl, calls } = stubFetch();
    await runWeatherStage(env, impl, NOW);

    expect(calls).toHaveLength(1);
    expect((await weatherRows(stale))[0]?.fetched_at).toBe(NOW.toISOString());
    expect((await weatherRows(fresh))[0]?.fetched_at).toBe("2026-07-13T00:00:00.000Z");
  });

  it("refreshes hourly on match day: refetches last hour's forecast, keeps this hour's", async () => {
    const seasonId = await seedSeason();
    await seedVenue({ id: MCG.id, lat: MCG.lat, lon: MCG.lon });
    const stale = await seedMatch({ seasonId, date: TODAY_MELB, localTime: "19:40:00" });
    const fresh = await seedMatch({ seasonId, date: TODAY_MELB, localTime: "20:10:00" });
    await seedWeatherRow({
      matchId: stale,
      kind: "forecast",
      source: "best_match",
      fetchedAt: "2026-07-13T01:00:00.000Z", // previous hour
    });
    await seedWeatherRow({
      matchId: fresh,
      kind: "forecast",
      source: "best_match",
      fetchedAt: NOW.toISOString(), // this hour
    });

    const { impl, calls } = stubFetch();
    await runWeatherStage(env, impl, NOW);

    expect(calls).toHaveLength(1);
    expect((await weatherRows(stale))[0]?.fetched_at).toBe(NOW.toISOString());
  });

  it("overwrites the forecast row in place — still exactly one forecast row", async () => {
    const seasonId = await seedSeason();
    await seedVenue({ id: MCG.id, lat: MCG.lat, lon: MCG.lon });
    const match = await seedMatch({ seasonId, date: "2026-07-17" });
    await seedWeatherRow({
      matchId: match,
      kind: "forecast",
      source: "best_match",
      fetchedAt: "2026-07-12T10:00:00.000Z",
      tempC: 3,
    });

    const { impl } = stubFetch({ temp: 18 });
    await runWeatherStage(env, impl, NOW);

    const rows = await weatherRows(match);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "forecast", temp_c: 18, fetched_at: NOW.toISOString() });
  });

  it("still fetches ambient weather for a roofed venue", async () => {
    const seasonId = await seedSeason();
    await seedVenue({
      id: 22,
      name: "Marvel Stadium",
      lat: -37.8165,
      lon: 144.9475,
      roof: "retractable",
    });
    const match = await seedMatch({ seasonId, date: "2026-07-16", venueId: 22 });

    const { impl, calls } = stubFetch();
    await runWeatherStage(env, impl, NOW);

    expect(calls).toHaveLength(1);
    expect(await weatherRows(match)).toHaveLength(1);
  });

  it("resolves coordinates through canonical_venue_id for alias venues", async () => {
    const seasonId = await seedSeason();
    await seedVenue({ id: 166, name: "Ninja Stadium", lat: -42.8772, lon: 147.3736 });
    await seedVenue({ id: 2, name: "Blundstone Arena", lat: null, lon: null, canonicalId: 166 });
    const match = await seedMatch({ seasonId, date: "2026-07-16", venueId: 2 });

    const { impl, calls } = stubFetch();
    await runWeatherStage(env, impl, NOW);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.searchParams.get("latitude")).toBe("-42.8772");
    expect(calls[0]?.searchParams.get("longitude")).toBe("147.3736");
    expect(await weatherRows(match)).toHaveLength(1);
  });

  it("skips matches at the placeholder venue (no coordinates)", async () => {
    const seasonId = await seedSeason();
    await seedVenue({ id: 17748, name: "To Be Confirmed", lat: null, lon: null });
    const match = await seedMatch({ seasonId, date: "2026-07-16", venueId: 17748 });

    const { impl, calls } = stubFetch();
    await runWeatherStage(env, impl, NOW);

    expect(calls).toHaveLength(0);
    expect(await weatherRows(match)).toHaveLength(0);
  });
});

describe("runWeatherStage — observed", () => {
  it("fast-writes observed from the historical forecast API after completion", async () => {
    const seasonId = await seedSeason();
    await seedVenue({ id: MCG.id, lat: MCG.lat, lon: MCG.lon });
    const match = await seedMatch({
      seasonId,
      date: "2026-07-11", // completed 2 days ago — inside the ERA5 lag window
      status: "Complete",
      homePoints: 80,
    });

    const { impl, calls } = stubFetch();
    await runWeatherStage(env, impl, NOW);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.host).toBe("historical-forecast-api.open-meteo.com");
    const rows = await weatherRows(match);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "observed",
      source: "historical_forecast",
      temp_c: 15,
    });
  });

  it("keeps the forecast row when the observed row lands", async () => {
    const seasonId = await seedSeason();
    await seedVenue({ id: MCG.id, lat: MCG.lat, lon: MCG.lon });
    const match = await seedMatch({
      seasonId,
      date: "2026-07-12",
      status: "Complete",
      homePoints: 71,
    });
    await seedWeatherRow({
      matchId: match,
      kind: "forecast",
      source: "best_match",
      fetchedAt: "2026-07-12T05:00:00.000Z",
      tempC: 11,
    });

    const { impl } = stubFetch();
    await runWeatherStage(env, impl, NOW);

    const rows = await weatherRows(match);
    expect(rows.map((r) => r.kind).sort()).toEqual(["forecast", "observed"]);
    expect(rows.find((r) => r.kind === "forecast")?.temp_c).toBe(11);
  });

  it("upgrades historical_forecast rows to era5_land+era5 once the match is older than 6 days", async () => {
    const seasonId = await seedSeason();
    await seedVenue({ id: MCG.id, lat: MCG.lat, lon: MCG.lon });
    const old = await seedMatch({
      seasonId,
      date: "2026-07-01",
      status: "Complete",
      homePoints: 95,
    });
    const recent = await seedMatch({
      seasonId,
      date: "2026-07-11",
      status: "Complete",
      homePoints: 60,
    });
    await seedWeatherRow({
      matchId: old,
      kind: "observed",
      source: "historical_forecast",
      fetchedAt: "2026-07-02T02:00:00.000Z",
      tempC: 9,
    });
    await seedWeatherRow({
      matchId: recent,
      kind: "observed",
      source: "historical_forecast",
      fetchedAt: "2026-07-12T02:00:00.000Z",
      tempC: 12,
    });

    const { impl, calls } = stubFetch({ modelSuffixes: true, temp: 10 });
    await runWeatherStage(env, impl, NOW);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.host).toBe("archive-api.open-meteo.com");
    expect(calls[0]?.searchParams.get("models")).toBe("era5_land,era5");
    const upgraded = await weatherRows(old);
    expect(upgraded).toHaveLength(1);
    expect(upgraded[0]).toMatchObject({
      kind: "observed",
      source: "era5_land+era5",
      temp_c: 10, // ERA5-Land series preferred over ERA5's temp-2
      precip_mm: 1.5, // precip taken from the ERA5 series
    });
    // The recent row stays on historical_forecast until it ages past 6 days.
    expect((await weatherRows(recent))[0]?.source).toBe("historical_forecast");
  });

  it("applies the >6-days-old upgrade boundary exactly", async () => {
    const seasonId = await seedSeason();
    await seedVenue({ id: MCG.id, lat: MCG.lat, lon: MCG.lon });
    // Today (Melbourne) is 2026-07-13: a 2026-07-07 match is exactly 6 days
    // old (not yet >6), a 2026-07-06 match is 7 days old (due its upgrade).
    const sixDaysOld = await seedMatch({
      seasonId,
      date: "2026-07-07",
      status: "Complete",
      homePoints: 88,
    });
    const sevenDaysOld = await seedMatch({
      seasonId,
      date: "2026-07-06",
      status: "Complete",
      homePoints: 44,
    });
    for (const matchId of [sixDaysOld, sevenDaysOld]) {
      await seedWeatherRow({
        matchId,
        kind: "observed",
        source: "historical_forecast",
        fetchedAt: "2026-07-08T02:00:00.000Z",
      });
    }

    const { impl, calls } = stubFetch({ modelSuffixes: true });
    await runWeatherStage(env, impl, NOW);

    expect(calls).toHaveLength(1);
    expect((await weatherRows(sixDaysOld))[0]?.source).toBe("historical_forecast");
    expect((await weatherRows(sevenDaysOld))[0]?.source).toBe("era5_land+era5");
  });

  it("writes an observed row from the archive for an old completed match that missed the fast pass", async () => {
    const seasonId = await seedSeason();
    await seedVenue({ id: MCG.id, lat: MCG.lat, lon: MCG.lon });
    const match = await seedMatch({
      seasonId,
      date: "2026-06-20",
      status: "Complete",
      homePoints: 55,
    });

    const { impl, calls } = stubFetch({ modelSuffixes: true });
    await runWeatherStage(env, impl, NOW);

    expect(calls[0]?.host).toBe("archive-api.open-meteo.com");
    expect((await weatherRows(match))[0]?.source).toBe("era5_land+era5");
  });
});

describe("runWeatherStage — failure and hygiene", () => {
  it("fails soft on an API error: no throw, sync_log row, and success on the next pass", async () => {
    const seasonId = await seedSeason();
    await seedVenue({ id: MCG.id, lat: MCG.lat, lon: MCG.lon });
    const match = await seedMatch({ seasonId, date: "2026-07-16" });

    const broken = stubFetch({ status: 500 });
    await expect(runWeatherStage(env, broken.impl, NOW)).resolves.toBeUndefined();

    expect(await weatherRows(match)).toHaveLength(0);
    const log = await syncLogRows();
    expect(log.some((r) => r.type === "sync:weather" && r.error !== null)).toBe(true);

    // Next hourly pass: the needs-work query self-heals, no retry state.
    const working = stubFetch();
    await runWeatherStage(env, working.impl, new Date("2026-07-13T03:00:00Z"));
    expect(await weatherRows(match)).toHaveLength(1);
  });

  it("deletes stray weather rows for cancelled matches and fetches nothing for them", async () => {
    const seasonId = await seedSeason();
    await seedVenue({ id: MCG.id, lat: MCG.lat, lon: MCG.lon });
    const cancelled = await seedMatch({ seasonId, date: "2026-07-15", status: "Cancelled" });
    await seedWeatherRow({
      matchId: cancelled,
      kind: "forecast",
      source: "best_match",
      fetchedAt: "2026-07-10T00:00:00.000Z",
    });
    await seedWeatherRow({
      matchId: cancelled,
      kind: "observed",
      source: "historical_forecast",
      fetchedAt: "2026-07-10T00:00:00.000Z",
    });

    const { impl, calls } = stubFetch();
    await runWeatherStage(env, impl, NOW);

    expect(await weatherRows(cancelled)).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });
});
