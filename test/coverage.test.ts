import { describe, expect, it } from "vitest";
import {
  ANALYTICS_COLUMNS,
  COVERAGE_COMPETITIONS,
  COVERAGE_EXPECTATIONS,
  materializeCoverage,
  observeCoverage,
} from "../src/mcp/tools/coverage";
import { getSchemaInfo } from "../src/mcp/tools/schema";
import { SchemaToolRequestSchema } from "../src/mcp/validation";
import type { Env } from "../src/types";

function fakeCache() {
  const entries = new Map<string, Response>();
  return {
    entries,
    cache: {
      async match(request: Request) {
        const response = entries.get(request.url);
        return response?.clone();
      },
      async put(request: Request, response: Response) {
        entries.set(request.url, response.clone());
      },
    } as unknown as Cache,
  };
}

function observationEnv() {
  const calls: { sql: string; bindings: unknown[] }[] = [];
  const rows = [
    { id: 77 },
    { row_count: 2, n0: 2, n1: 1 },
    { row_count: 3, temperature_count: 0, type_count: 1 },
    { row_count: 4 },
    { row_count: 5, match_count: 2 },
    { row_count: 3 },
  ];
  const DB = {
    prepare(sql: string) {
      const call = { sql, bindings: [] as unknown[] };
      calls.push(call);
      return {
        bind(...bindings: unknown[]) {
          call.bindings = bindings;
          return this;
        },
        async first() {
          return rows[calls.indexOf(call)] ?? null;
        },
      };
    },
  } as unknown as D1Database;
  return { env: { DB } as Env, calls };
}

describe("coverage contract", () => {
  it("materializes every declared analytics column for every competition", () => {
    const coverage = materializeCoverage();
    for (const competition of COVERAGE_COMPETITIONS) {
      for (const [table, columns] of Object.entries(ANALYTICS_COLUMNS)) {
        expect(COVERAGE_EXPECTATIONS[competition]).toHaveProperty(table);
        for (const column of columns) {
          const ranges = coverage[competition][table]?.[column];
          expect(Object.keys(ranges ?? {})).toHaveLength(1);
          const leaf = Object.values(ranges ?? {})[0];
          expect(leaf?.observed).toBeNull();
          expect(leaf?.source.length).toBeGreaterThan(0);
          expect(leaf?.as_of).toBe("2026-07-12");
        }
      }
    }
  });

  it("marks measured VFLW counterexample fields best-effort", () => {
    const stats = materializeCoverage().VFLW.player_match_stats;
    for (const column of ["goal_assists", "marks_inside_fifty", "one_percenters"]) {
      expect(Object.values(stats?.[column] ?? {})[0]?.expected).toBe("best-effort");
    }
  });

  it("expands quarter fields and keeps exact ranges and Melbourne-time coverage canonical", () => {
    const coverage = materializeCoverage();
    expect(coverage.AFLM.matches?.weather_temp_c).toHaveProperty("2010..2025");
    expect(coverage.AFLM.matches?.attendance).toHaveProperty("1990..2019");
    expect(coverage.AFLM.player_match_stats?.brownlow_votes).toHaveProperty("1990..2025");
    for (const competition of COVERAGE_COMPETITIONS) {
      expect(Object.values(coverage[competition].matches?.local_time ?? {})[0]?.expected).toBe(
        "complete",
      );
    }
    for (const side of ["home", "away"]) {
      for (const quarter of [1, 2, 3, 4]) {
        for (const score of ["goals", "behinds"]) {
          expect(coverage.AFLM.matches).toHaveProperty(`${side}_q${quarter}_${score}`);
        }
      }
    }
  });

  it("keeps default schema deterministic, database-free, and below 128 KiB", async () => {
    const schema = await getSchemaInfo();
    const serialized = JSON.stringify(schema);
    expect(serialized.length).toBeLessThan(128 * 1024);
    expect(schema.database.coverage_contract.version).toBe(1);
    expect(schema.database.column_coverage.deprecated).toBe(true);
    expect(schema.database.column_coverage.columns["matches.weather_temp_c"]).toMatchObject({
      from: 2010,
      to: 2025,
    });
    expect(schema.database.competitions.AFLM.coverage).toEqual({
      matches: true,
      stats: true,
      lineups: "2015+",
      pav: "1998+",
    });
  });

  it("keeps a fully observed schema response below 128 KiB", async () => {
    const { env } = observationEnv();
    const schema = await getSchemaInfo(
      { includeObserved: true, competition: "AFLW", season: 2025 },
      env,
    );
    expect(JSON.stringify(schema).length).toBeLessThan(128 * 1024);
  });

  it("validates observed bounds before database access", () => {
    expect(SchemaToolRequestSchema.safeParse({}).success).toBe(true);
    expect(
      SchemaToolRequestSchema.safeParse({
        includeObserved: true,
        competition: "AFLM",
        season: 2026,
      }).success,
    ).toBe(true);
    for (const invalid of [
      { includeObserved: true },
      { includeObserved: true, competition: "NOPE", season: 2026 },
      { includeObserved: true, competition: "AFLM", season: 1989 },
      { includeObserved: true, competition: "AFLM", season: 2026.5 },
      { includeObserved: false, competition: "AFLM", season: 2026 },
      { unknown: true },
    ])
      expect(SchemaToolRequestSchema.safeParse(invalid).success).toBe(false);
  });

  it("runs separate bounded aggregate statements and caches successful results for 15 minutes", async () => {
    const { env, calls } = observationEnv();
    const { cache, entries } = fakeCache();
    const first = await observeCoverage(env, "VFLW", 2026, cache);
    expect(first.scalar["matches.weather_temp_c"]).toEqual({
      unit: "rows",
      rows: 3,
      non_null: 0,
      null: 3,
      ratio: 0,
    });
    expect(first.pav).toEqual({ unit: "table_rows", rows: 4 });
    expect(first.lineups).toEqual({
      unit: "match_presence",
      total_matches: 3,
      matches_with_rows: 2,
      rows: 5,
      ratio: 0.666667,
    });
    expect(calls).toHaveLength(6);
    expect(calls[0]?.bindings).toEqual(["VFLW", 2026]);
    expect(
      calls.slice(1).every((call) => call.bindings.length === 1 && call.bindings[0] === 77),
    ).toBe(true);
    expect(calls[1]?.sql).toContain("match_id IN (SELECT id FROM matches WHERE season_id = ?)");
    expect(calls[2]?.sql).toContain("FROM matches WHERE season_id = ?");
    expect(calls[3]?.sql).toContain("FROM player_season_pav WHERE season_id = ?");
    expect(calls[4]?.sql).toContain("COUNT(DISTINCT match_id)");
    expect(entries.size).toBe(1);
    expect(entries.values().next().value?.headers.get("Cache-Control")).toBe("max-age=900");

    await observeCoverage(env, "VFLW", 2026, cache);
    expect(calls).toHaveLength(6);
  });

  it("does not cache query errors", async () => {
    const { cache, entries } = fakeCache();
    const env = {
      DB: {
        prepare: () => ({
          bind: () => ({
            first: async () => {
              throw new Error("D1 down");
            },
          }),
        }),
      },
    } as unknown as Env;
    await expect(observeCoverage(env, "AFLM", 2026, cache)).rejects.toThrow("D1 down");
    expect(entries.size).toBe(0);
  });
});
