import { describe, expect, it } from "vitest";
import {
  ARCHIVE_API,
  FORECAST_API,
  MATCH_WEATHER_UPSERT,
  matchWeatherUpsertSql,
  openMeteoUrl,
  weatherMetricValues,
} from "../src/weather/openmeteo";

const COLUMNS = [
  "match_id",
  "kind",
  "temp_c",
  "precip_mm",
  "precip_24h_prior_mm",
  "wind_speed_kmh",
  "wind_gust_kmh",
  "humidity_pct",
  "source",
  "fetched_at",
] as const;

describe("match_weather upsert manifest", () => {
  it("lists every column in insert order and conflicts on (match_id, kind)", () => {
    const sql = matchWeatherUpsertSql("VALUES-TUPLE");
    expect(sql).toContain(`INSERT INTO match_weather (${COLUMNS.join(", ")})`);
    expect(sql).toContain("VALUES (VALUES-TUPLE)");
    expect(sql).toContain("ON CONFLICT (match_id, kind) DO UPDATE SET");
  });

  it("updates every non-key column and neither key column", () => {
    const setClause = matchWeatherUpsertSql("x").split("DO UPDATE SET")[1] ?? "";
    for (const column of COLUMNS.slice(2)) {
      expect(setClause).toContain(`${column} = excluded.${column}`);
    }
    expect(setClause).not.toContain("match_id = excluded.match_id");
    expect(setClause).not.toContain("kind = excluded.kind");
  });

  it("provides one placeholder per column in the bind variant", () => {
    const values = MATCH_WEATHER_UPSERT.match(/VALUES \(([^)]*)\)/)?.[1] ?? "";
    expect(values.split(",").map((v) => v.trim())).toEqual(COLUMNS.map(() => "?"));
  });

  it("orders metric values to match the manifest's metric columns", () => {
    expect(
      weatherMetricValues({
        tempC: 1,
        precipMm: 2,
        precip24hPriorMm: 3,
        windSpeedKmh: 4,
        windGustKmh: 5,
        humidityPct: 6,
      }),
      // temp_c, precip_mm, precip_24h_prior_mm, wind_speed_kmh, wind_gust_kmh, humidity_pct
    ).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe("openMeteoUrl", () => {
  const request = { latitude: -37.82, longitude: 144.9834, date: "2026-07-18" };

  it("requests a three-day Melbourne-local window around the match date", () => {
    const url = new URL(openMeteoUrl(FORECAST_API, request, false));
    expect(url.origin + url.pathname).toBe(FORECAST_API);
    expect(url.searchParams.get("start_date")).toBe("2026-07-17");
    expect(url.searchParams.get("end_date")).toBe("2026-07-19");
    expect(url.searchParams.get("timezone")).toBe("Australia/Melbourne");
    expect(url.searchParams.get("models")).toBeNull();
  });

  it("adds the dual-model selector for archive requests", () => {
    const url = new URL(openMeteoUrl(ARCHIVE_API, request, true));
    expect(url.searchParams.get("models")).toBe("era5_land,era5");
  });
});
