import { describe, expect, it } from "vitest";
import {
  bindValues,
  changeDetectionWhere,
  insertColumnList,
  placeholderList,
  type UpsertColumn,
  updateSetClause,
} from "../src/sync/columns";
import { MATCH_COLUMNS, STAT_COLUMNS } from "../src/sync/upserts";

/**
 * Row stub whose every property access yields another stub, so value
 * extractors of any nesting depth can be invoked without a real row.
 */
function stubRow<Row>(): Row {
  const handler: ProxyHandler<object> = {
    get: (_target, prop) => {
      // Allow extractors to coerce stub values to primitives (e.g. regex
      // matching on a derived round name).
      if (prop === Symbol.toPrimitive || prop === "toString" || prop === "valueOf") {
        return () => "stub";
      }
      return new Proxy({}, handler);
    },
  };
  return new Proxy({}, handler) as unknown as Row;
}

/**
 * Assert that every fragment generated from a manifest is mutually
 * consistent: same columns, same order, same per-column COALESCE
 * semantics in SET and WHERE, and one bind value per placeholder. This is
 * the invariant that keeps `meta.changes` (and therefore PAV recalculation)
 * correct when columns are added to a manifest.
 */
function expectConsistentFragments<Row>(
  table: string,
  columns: readonly UpsertColumn<Row>[],
): void {
  const names = columns.map((c) => c.name);
  const nonKey = columns.filter((c) => c.kind !== "key");

  // No duplicate column names within the manifest.
  expect(new Set(names).size).toBe(names.length);

  // INSERT list and VALUES placeholders pair up one-to-one, in order.
  expect(insertColumnList(columns).split(", ")).toEqual(names);
  const placeholders = placeholderList(columns).split(", ");
  expect(placeholders).toHaveLength(columns.length);
  expect(placeholders.every((p) => p === "?")).toBe(true);

  // One bind value per placeholder, derived from the same manifest.
  expect(bindValues(columns, stubRow<Row>())).toHaveLength(columns.length);

  // SET and WHERE cover exactly the non-key columns, in manifest order.
  const setEntries = updateSetClause(table, columns).split(",\n");
  const whereEntries = changeDetectionWhere(table, columns).split(" OR\n");
  expect(setEntries.map((e) => /^\s*(\w+) = /.exec(e)?.[1])).toEqual(nonKey.map((c) => c.name));
  expect(
    whereEntries.map((e) => new RegExp(`^\\s*${table}\\.(\\w+) IS NOT `).exec(e)?.[1]),
  ).toEqual(nonKey.map((c) => c.name));

  // COALESCE semantics agree between SET and WHERE for every column. A
  // mismatch would make WHERE flag a "change" the SET clause never writes
  // (or vice versa), corrupting the change count.
  for (const [i, c] of nonKey.entries()) {
    const wantsCoalesce = c.kind === "coalesce";
    expect(setEntries[i]?.includes("COALESCE(")).toBe(wantsCoalesce);
    expect(whereEntries[i]?.includes("COALESCE(")).toBe(wantsCoalesce);
  }
}

describe("upsert column manifests", () => {
  it("player_match_stats fragments are mutually consistent", () => {
    expectConsistentFragments("player_match_stats", STAT_COLUMNS);
  });

  it("player_match_stats excludes exactly the conflict keys from change detection", () => {
    const keys = STAT_COLUMNS.filter((c) => c.kind === "key").map((c) => c.name);
    expect(keys).toEqual(["match_id", "player_id"]);
  });

  it("matches fragments are mutually consistent", () => {
    expectConsistentFragments("matches", MATCH_COLUMNS);
  });

  it("matches excludes exactly the branch-specific columns from the shared fragments", () => {
    // These five are conflict targets / insert-only / updated by
    // branch-specific SQL in buildMatchUpsert. Anything else appearing here
    // would silently drop out of the shared SET/WHERE fragments.
    const keys = MATCH_COLUMNS.filter((c) => c.kind === "key").map((c) => c.name);
    expect(keys).toEqual(["external_afl_id", "season_id", "date", "home_team_id", "away_team_id"]);
  });
});
