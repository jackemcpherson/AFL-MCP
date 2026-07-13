import { describe, expect, it } from "vitest";
import { aggregateWeatherWindow, extractHourlySeries } from "../src/weather/aggregate";

/**
 * Build a two-day hourly series (48 points) with constant values,
 * mirroring the shape returned by extractHourlySeries.
 */
function makeSeries(
  startDate: string,
  days: number,
  values: {
    temp?: number | null;
    precip?: number | null;
    humidity?: number | null;
    windSpeed?: number | null;
    windGust?: number | null;
  } = {},
) {
  const hours = days * 24;
  const time: string[] = [];
  const [y = 0, m = 1, d = 1] = startDate.split("-").map(Number);
  for (let i = 0; i < hours; i++) {
    const t = new Date(Date.UTC(y, m - 1, d, i));
    time.push(`${t.toISOString().slice(0, 13)}:00`);
  }
  const fill = (v: number | null | undefined) =>
    new Array<number | null>(hours).fill(v === undefined ? 0 : v);
  return {
    time,
    temperatureC: fill(values.temp),
    precipitationMm: fill(values.precip),
    humidityPct: fill(values.humidity),
    windSpeedKmh: fill(values.windSpeed),
    windGustKmh: fill(values.windGust),
  };
}

describe("aggregateWeatherWindow", () => {
  it("computes the six metrics over a 3h window from the scheduled start", () => {
    const series = makeSeries("2026-07-17", 2, {
      temp: 15,
      precip: 0.5,
      humidity: 60,
      windSpeed: 20,
      windGust: 35,
    });
    const metrics = aggregateWeatherWindow(series, "2026-07-18T19:40:00");
    expect(metrics).toEqual({
      tempC: 15,
      precipMm: 1.5, // 3 hours x 0.5mm
      precip24hPriorMm: 12, // 24 hours x 0.5mm
      windSpeedKmh: 20,
      windGustKmh: 35,
      humidityPct: 60,
    });
  });

  it("averages temperature/humidity, sums precipitation, and takes wind maxima", () => {
    const series = makeSeries("2026-07-17", 2);
    // Match window for a 14:10 start is 14:00, 15:00, 16:00 on day two.
    const at = (hour: number) => 24 + hour;
    const temps = series.temperatureC as (number | null)[];
    temps[at(14)] = 12;
    temps[at(15)] = 14;
    temps[at(16)] = 13;
    const wind = series.windSpeedKmh as (number | null)[];
    wind[at(14)] = 10;
    wind[at(15)] = 30;
    wind[at(16)] = 20;
    const precip = series.precipitationMm as (number | null)[];
    precip[at(14)] = 1.2;
    precip[at(15)] = 0;
    precip[at(16)] = 0.4;

    const metrics = aggregateWeatherWindow(series, "2026-07-18T14:10:00");
    expect(metrics.tempC).toBe(13);
    expect(metrics.windSpeedKmh).toBe(30);
    expect(metrics.precipMm).toBe(1.6);
  });

  it("handles a night game whose window crosses midnight", () => {
    const series = makeSeries("2026-07-17", 3, { temp: 10, precip: 0.1 });
    // 23:20 start on the middle day: window hours 23:00, 00:00, 01:00.
    const metrics = aggregateWeatherWindow(series, "2026-07-18T23:20:00");
    expect(metrics.tempC).toBe(10);
    expect(metrics.precipMm).toBeCloseTo(0.3, 5);
    expect(metrics.precip24hPriorMm).toBeCloseTo(2.4, 5);
  });

  it("skips null hours and aggregates the hours that are present", () => {
    const series = makeSeries("2026-07-17", 2, { temp: null });
    const temps = series.temperatureC as (number | null)[];
    temps[24 + 19] = 8; // only one non-null hour in the window
    const metrics = aggregateWeatherWindow(series, "2026-07-18T19:40:00");
    expect(metrics.tempC).toBe(8);
  });

  it("returns null metrics when every hour in the window is null or missing", () => {
    const series = makeSeries("2026-07-17", 2, {
      temp: null,
      precip: null,
      humidity: null,
      windSpeed: null,
      windGust: null,
    });
    const metrics = aggregateWeatherWindow(series, "2026-07-18T19:40:00");
    expect(metrics).toEqual({
      tempC: null,
      precipMm: null,
      precip24hPriorMm: null,
      windSpeedKmh: null,
      windGustKmh: null,
      humidityPct: null,
    });
  });

  it("returns null metrics when the window falls entirely outside the series", () => {
    const series = makeSeries("2026-07-17", 1, { temp: 15 });
    const metrics = aggregateWeatherWindow(series, "2026-09-01T14:00:00");
    expect(metrics.tempC).toBeNull();
    expect(metrics.precip24hPriorMm).toBeNull();
  });

  it("spans the previous day for the prior-24h precipitation window", () => {
    const series = makeSeries("2026-07-17", 2, { precip: 0 });
    const precip = series.precipitationMm as (number | null)[];
    precip[16] = 5; // 16:00 on the prior day — inside [start-24h, start)
    precip[24 + 13] = 2; // 13:00 on match day — inside the prior window for a 14:00 start
    precip[24 + 14] = 1; // 14:00 — match window, not prior
    const metrics = aggregateWeatherWindow(series, "2026-07-18T14:00:00");
    expect(metrics.precip24hPriorMm).toBe(7);
    expect(metrics.precipMm).toBe(1);
  });

  it("accepts a space-separated scheduled start (D1 date + local_time)", () => {
    const series = makeSeries("2026-07-17", 2, { temp: 21 });
    const metrics = aggregateWeatherWindow(series, "2026-07-18 13:15:00");
    expect(metrics.tempC).toBe(21);
  });
});

describe("extractHourlySeries", () => {
  const time = ["2026-07-18T00:00", "2026-07-18T01:00"];

  it("reads plain single-model variable arrays (forecast APIs)", () => {
    const series = extractHourlySeries({
      hourly: {
        time,
        temperature_2m: [11.5, 12],
        precipitation: [0, 0.2],
        relative_humidity_2m: [70, 72],
        wind_speed_10m: [15, 18],
        wind_gusts_10m: [30, 33],
      },
    });
    expect(series.time).toEqual(time);
    expect(series.temperatureC).toEqual([11.5, 12]);
    expect(series.precipitationMm).toEqual([0, 0.2]);
    expect(series.humidityPct).toEqual([70, 72]);
    expect(series.windSpeedKmh).toEqual([15, 18]);
    expect(series.windGustKmh).toEqual([30, 33]);
  });

  it("prefers ERA5-Land for temp/humidity/wind and ERA5 for precipitation on dual-model archive responses", () => {
    const series = extractHourlySeries({
      hourly: {
        time,
        temperature_2m_era5_land: [9.1, 9.4],
        temperature_2m_era5: [8, 8],
        precipitation_era5_land: [null, null], // ERA5-Land serves no precip (#130)
        precipitation_era5: [0.6, 0],
        relative_humidity_2m_era5_land: [80, 81],
        relative_humidity_2m_era5: [70, 70],
        wind_speed_10m_era5_land: [22, 24],
        wind_speed_10m_era5: [10, 10],
        wind_gusts_10m_era5_land: [null, null],
        wind_gusts_10m_era5: [40, 42],
      },
    });
    expect(series.temperatureC).toEqual([9.1, 9.4]);
    expect(series.precipitationMm).toEqual([0.6, 0]);
    expect(series.humidityPct).toEqual([80, 81]);
    expect(series.windSpeedKmh).toEqual([22, 24]);
    // ERA5-Land gusts are all null, so the ERA5 series is used instead.
    expect(series.windGustKmh).toEqual([40, 42]);
  });

  it("fills a missing variable with nulls so partial responses pass through", () => {
    const series = extractHourlySeries({
      hourly: { time, temperature_2m: [10, 11] },
    });
    expect(series.temperatureC).toEqual([10, 11]);
    expect(series.precipitationMm).toEqual([null, null]);
    expect(series.windGustKmh).toEqual([null, null]);
  });

  it("throws on a payload without an hourly time axis", () => {
    expect(() => extractHourlySeries({ error: true, reason: "out of range" })).toThrow();
  });
});
