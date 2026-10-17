import { Predicate } from "effect";
import { describe, expect, it } from "vitest";
import { type JsonValue, serializedLength, truncateResult } from "../../src/sandbox/truncate";

function rows(count: number): Array<{ id: number; team: string; goals: number }> {
  return Array.from({ length: count }, (_, id) => ({
    id,
    team: `Team ${id}`,
    goals: id % 7,
  }));
}

describe("serializedLength", () => {
  it("counts a string as raw text and anything else as pretty JSON", () => {
    expect(serializedLength("abc")).toBe(3);
    expect(serializedLength({ a: 1 })).toBe('{\n  "a": 1\n}'.length);
  });
});

describe("truncateResult", () => {
  it("returns a result under the cap unchanged", () => {
    const value = { results: rows(3), success: true };
    expect(truncateResult(value, 10_000)).toEqual({
      results: rows(3),
      success: true,
    });
  });

  it("cuts a long array to fit and ends it with a marker giving the full count", () => {
    const out = truncateResult(rows(1_000), 2_000);
    expect(Array.isArray(out)).toBe(true);
    // SAFETY: the assertion above proved an array.
    const list = out as unknown[];
    expect(serializedLength(out)).toBeLessThanOrEqual(2_000);
    const marker = list.at(-1);
    expect(marker).toMatch(
      /^--- TRUNCATED: showing \d+ of 1000 items\. Narrow the query with LIMIT, WHERE or aggregation\. ---$/,
    );
    const kept = list.slice(0, -1);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept).toEqual(rows(kept.length));
    expect(marker).toContain(`showing ${kept.length} of 1000 items`);
  });

  it("keeps the object shape and cuts the array inside it", () => {
    const out = truncateResult(
      { results: rows(1_000), success: true, meta: { rows_read: 1 } },
      3_000,
    );
    expect(serializedLength(out)).toBeLessThanOrEqual(3_000);
    expect(out).toMatchObject({ success: true, meta: { rows_read: 1 } });
    // SAFETY: toMatchObject above proved an object; truncation keeps its keys.
    const results = (out as { results: unknown[] }).results;
    expect(results.at(-1)).toMatch(/^--- TRUNCATED: showing \d+ of 1000 items\./);
  });

  it("cuts a long string and states its full length", () => {
    const out = truncateResult("x".repeat(50_000), 1_000);
    expect(Predicate.isString(out)).toBe(true);
    expect(serializedLength(out)).toBeLessThanOrEqual(1_000);
    expect(out).toMatch(/^x+… --- TRUNCATED: showing \d+ of 50000 characters\. .+ ---$/);
  });

  it("cuts a long string inside a single row rather than dropping the row", () => {
    const out = truncateResult([{ id: 1, notes: "y".repeat(20_000) }], 1_000);
    expect(serializedLength(out)).toBeLessThanOrEqual(1_000);
    // SAFETY: the input was a one-row array, and truncation keeps the row.
    const [row] = out as Array<{ id: number; notes: string }>;
    expect(row?.id).toBe(1);
    expect(row?.notes).toMatch(/--- TRUNCATED: showing \d+ of 20000 characters\./);
  });

  it("keeps the original count when an array is cut more than once", () => {
    // Nested arrays make the first estimate too generous, so a second pass runs.
    const nested = Array.from({ length: 300 }, (_, i) => ({
      i,
      values: rows(5),
    }));
    const out = truncateResult(nested, 1_500);
    expect(serializedLength(out)).toBeLessThanOrEqual(1_500);
    expect(Array.isArray(out) && out.at(-1)).toMatch(/showing \d+ of 300 items/);
  });

  it("replaces a result with nothing to shorten by a marker", () => {
    const wide = Object.fromEntries(Array.from({ length: 2_000 }, (_, i) => [`k${i}`, i]));
    const out = truncateResult(wide, 500);
    expect(out).toMatch(
      /^--- TRUNCATED: the result has \d+ characters, over the 500-character limit, and no array or string to shorten\. Narrow the query with LIMIT, WHERE or aggregation\. ---$/,
    );
  });

  it("always yields JSON within the cap", () => {
    const shapes: JsonValue[] = [
      rows(5_000),
      { a: rows(2_000), b: rows(2_000), c: "z".repeat(30_000) },
      [[rows(500)], [rows(500)]],
      {
        deep: {
          deeper: {
            list: Array.from({ length: 4_000 }, (_, i) => `item ${i}`),
          },
        },
      },
    ];
    for (const shape of shapes) {
      const out = truncateResult(shape, 5_000);
      expect(serializedLength(out)).toBeLessThanOrEqual(5_000);
      expect(JSON.parse(JSON.stringify(out))).toEqual(out);
    }
  });
});
