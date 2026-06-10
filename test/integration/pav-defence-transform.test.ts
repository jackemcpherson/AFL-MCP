import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "../../src/types";

/**
 * COR-11: the defence transform was written as
 * ((2dn - dn²) / NULLIF(2dn, 0)) × 100 × 2, which reduces algebraically
 * to 100 × (2 - dn) with NULL at dn = 0. pav.ts now uses the reduced
 * form; this test proves the two expressions agree across the realistic
 * dn range so the simplification can never silently change ratings.
 * (A golden-value test against HPN's published season figures still
 * needs sourced data — tracked separately.)
 */
describe("PAV defence transform equivalence", () => {
  it("matches the original expression for dn in [0, 2]", async () => {
    const { results } = await (env as Env).DB.prepare(
      `WITH dn_values(dn) AS (
         VALUES (0.0), (0.25), (0.5), (0.75), (1.0), (1.1), (1.5), (2.0)
       )
       SELECT dn,
         (100.0 * ((2.0 * dn - dn * dn) / NULLIF(2.0 * dn, 0))) * 2.0 AS original,
         CASE WHEN dn = 0 THEN NULL ELSE 100.0 * (2.0 - dn) END AS simplified
       FROM dn_values`,
    ).all<{ dn: number; original: number | null; simplified: number | null }>();

    expect(results).toHaveLength(8);
    for (const row of results) {
      if (row.original === null) {
        expect(row.simplified).toBeNull();
      } else {
        expect(row.simplified).not.toBeNull();
        expect(row.simplified as number).toBeCloseTo(row.original, 10);
      }
    }
  });
});
