import { describe, expect, it } from "vitest";
import {
  ANALYTICS_COLUMNS,
  COVERAGE_COMPETITIONS,
  COVERAGE_EXPECTATIONS,
  contractCoverage,
  observeCoverage,
} from "../src/mcp/tools/coverage";
import { getSchemaInfo } from "../src/mcp/tools/schema";
import { SCHEMA_TOOL_CONTRACT, SchemaToolRequestSchema } from "../src/mcp/validation";
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
  it("emits a default for every table and only well-formed exception columns", () => {
    const coverage = contractCoverage();
    for (const competition of COVERAGE_COMPETITIONS) {
      for (const [table, columns] of Object.entries(ANALYTICS_COLUMNS)) {
        expect(COVERAGE_EXPECTATIONS[competition]).toHaveProperty(table);
        const contract = coverage[competition][table];
        expect(contract?.range.length).toBeGreaterThan(0);
        expect(contract?.expected).toBeDefined();
        expect(contract?.source.length).toBeGreaterThan(0);
        // notes only present when non-empty (payload budget).
        if (contract?.notes) expect(contract.notes.length).toBeGreaterThan(0);
        for (const [column, exception] of Object.entries(contract?.columns ?? {})) {
          // Every exception names a real declared column...
          expect(columns as readonly string[]).toContain(column);
          // ...and genuinely deviates from the table default.
          expect(
            exception.expected !== undefined || exception.range !== undefined,
            `${competition}.${table}.${column} is a no-op exception`,
          ).toBe(true);
          if (exception.expected !== undefined)
            expect(exception.expected).not.toBe(contract?.expected);
          if (exception.range !== undefined) expect(exception.range).not.toBe(contract?.range);
        }
      }
    }
  });

  it("marks measured VFLW counterexample fields best-effort via the table default", () => {
    const stats = contractCoverage().VFLW.player_match_stats;
    // These columns are best-effort — same as the VFLW table default, so in
    // the v2 exceptions-only encoding they must NOT appear as exceptions.
    expect(stats?.expected).toBe("best-effort");
    for (const column of ["goal_assists", "marks_inside_fifty", "one_percenters"]) {
      expect(stats?.columns?.[column]).toBeUndefined();
    }
    // Genuine deviations from the default remain listed.
    expect(stats?.columns?.brownlow_votes?.expected).toBe("not-applicable");
    expect(stats?.columns?.supercoach_score?.expected).toBe("absent");
  });

  it("keeps exact ranges and Melbourne-time coverage canonical as exceptions", () => {
    const coverage = contractCoverage();
    expect(coverage.AFLM.matches?.columns?.weather_temp_c?.range).toBe("2010..2025");
    expect(coverage.AFLM.matches?.columns?.attendance?.range).toBe("1990..2019");
    expect(coverage.AFLM.player_match_stats?.columns?.brownlow_votes?.range).toBe("1990..2025");
    for (const competition of COVERAGE_COMPETITIONS) {
      expect(coverage[competition].matches?.columns?.local_time?.expected).toBe("complete");
    }
    for (const side of ["home", "away"]) {
      for (const quarter of [1, 2, 3, 4]) {
        for (const score of ["goals", "behinds"]) {
          expect(coverage.AFLM.matches?.columns?.[`${side}_q${quarter}_${score}`]?.range).toBe(
            "2020..current",
          );
        }
      }
    }
  });

  it("keeps default schema deterministic, database-free, and below 40 KiB", async () => {
    const schema = await getSchemaInfo();
    const serialized = JSON.stringify(schema);
    expect(serialized.length).toBeLessThan(40 * 1024);
    expect(schema.database.coverage_contract.version).toBe(2);
    expect(schema.database.coverage_contract.review_date).toBe("2026-07-12");
    expect(schema.database.coverage_contract.how_to_read).toContain("exceptions");
    expect(schema.database).not.toHaveProperty("column_coverage");
    expect(schema.database.competitions.AFLM.coverage).toEqual({
      matches: true,
      stats: true,
      lineups: "2015+",
      pav: "1998+",
    });
  });

  it("filters the base schema to one competition when competition is passed alone", async () => {
    const full = await getSchemaInfo();
    const filtered = await getSchemaInfo({ competition: "AFLW" });

    expect(Object.keys(filtered.database.competitions)).toEqual(["AFLW"]);
    expect(Object.keys(filtered.database.coverage_contract.by_competition)).toEqual(["AFLW"]);
    expect(filtered.database.coverage_contract.version).toBe(2);
    // The reading key survives the filter path.
    expect(filtered.database.coverage_contract.how_to_read).toContain("exceptions");
    // Tables, notes, and join examples are competition-agnostic and stay.
    expect(filtered.database.tables).toEqual(full.database.tables);
    expect(filtered.database.notes).toEqual(full.database.notes);
    expect(filtered.database.common_joins).toEqual(full.database.common_joins);
    // Filtering only ever shrinks the payload.
    expect(JSON.stringify(filtered).length).toBeLessThan(JSON.stringify(full).length);
    // The no-arg response is unaffected by the filtering path.
    expect(Object.keys(full.database.coverage_contract.by_competition)).toEqual([
      "AFLM",
      "AFLW",
      "VFL",
      "VFLW",
    ]);
    expect(Object.keys(full.database.competitions)).toEqual(["AFLM", "AFLW", "VFL", "VFLW"]);
  });

  it("attaches an observed block beside the static contract and stays below 64 KiB", async () => {
    const { env } = observationEnv();
    const schema = await getSchemaInfo(
      { includeObserved: true, competition: "AFLW", season: 2025 },
      env,
    );
    expect(JSON.stringify(schema).length).toBeLessThan(64 * 1024);
    const observed = schema.database.coverage_contract.observed;
    expect(observed?.competition).toBe("AFLW");
    expect(observed?.season).toBe(2025);
    expect(observed?.matches.weather_temp_c?.unit).toBe("rows");
    expect(observed?.player_match_stats.kicks?.unit).toBe("rows");
    expect(observed?.player_season_pav.unit).toBe("table_rows");
    expect(observed?.match_lineups.unit).toBe("match_presence");
    // Static expectations are never mutated by a measurement.
    expect(schema.database.coverage_contract.by_competition.AFLW).toEqual(contractCoverage().AFLW);
  });

  it("validates observed bounds before database access", () => {
    expect(SchemaToolRequestSchema.safeParse({}).success).toBe(true);
    expect(SchemaToolRequestSchema.safeParse({ competition: "AFLM" }).success).toBe(true);
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

  it("returns the full parameter contract as the single message for every invalid combination", () => {
    for (const invalid of [
      { season: 2026 },
      { competition: "AFLM", season: 2026 },
      { includeObserved: false, competition: "AFLM", season: 2026 },
      { includeObserved: true },
      { includeObserved: true, competition: "AFLM" },
      { includeObserved: true, season: 2026 },
    ]) {
      const result = SchemaToolRequestSchema.safeParse(invalid);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toBe(SCHEMA_TOOL_CONTRACT);
      }
    }
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
