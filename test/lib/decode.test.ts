import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  batchRow,
  batchRows,
  decodeRow,
  describeIssue,
  firstIssue,
  looseDecoder,
  strictDecoder,
} from "../../src/lib/decode";

const Body = Schema.Struct({
  dryRun: Schema.Boolean,
  scope: Schema.Struct({ season: Schema.Int }),
});

describe("strictDecoder", () => {
  const decode = strictDecoder(Body);

  it("decodes a body with only declared keys", () => {
    const result = decode({ dryRun: true, scope: { season: 2024 } });
    expect(Result.isSuccess(result) && result.success).toEqual({
      dryRun: true,
      scope: { season: 2024 },
    });
  });

  it("rejects an undeclared key at any depth", () => {
    expect(Result.isFailure(decode({ dryRun: true, scope: { season: 2024 }, x: 1 }))).toBe(true);
    expect(Result.isFailure(decode({ dryRun: true, scope: { season: 2024, x: 1 } }))).toBe(true);
  });
});

describe("looseDecoder", () => {
  it("drops undeclared keys", () => {
    const result = looseDecoder(Body)({
      dryRun: true,
      scope: { season: 2024, x: 1 },
      y: 2,
    });
    expect(Result.isSuccess(result) && result.success).toEqual({
      dryRun: true,
      scope: { season: 2024 },
    });
  });
});

describe("firstIssue and describeIssue", () => {
  const failure = (input: unknown) => {
    const result = strictDecoder(Body)(input);
    if (Result.isSuccess(result)) throw new Error("fixture decoded");
    return result.failure;
  };

  it("report the path to the failing value", () => {
    const error = failure({ dryRun: true, scope: { season: "2024" } });
    expect(firstIssue(error)).toEqual({
      path: ["scope", "season"],
      message: "Expected number",
    });
    expect(describeIssue(error)).toBe('Expected number at "scope.season"');
  });

  it("name an undeclared key", () => {
    expect(describeIssue(failure({ dryRun: true, scope: { season: 1 }, extra: 1 }))).toBe(
      'Expected no excess property at "extra"',
    );
  });

  it("omit the path for a top-level failure", () => {
    const error = failure(null);
    expect(firstIssue(error).path).toEqual([]);
    expect(describeIssue(error)).toBe(firstIssue(error).message);
  });
});

describe("row helpers", () => {
  const Row = Schema.Struct({ id: Schema.Number });
  // SAFETY: the row helpers read only `results`, never `meta`.
  const meta = {} as D1Meta & Record<string, unknown>;
  const batch = (results: unknown[]): D1Result[] => [
    { results: [], success: true, meta },
    { results, success: true, meta },
  ];

  it("decodeRow returns null for no row, ignores extra columns and throws on a bad row", () => {
    expect(decodeRow(null, Row)).toBeNull();
    expect(decodeRow({ id: 1, extra: "x" }, Row)).toEqual({ id: 1 });
    expect(() => decodeRow({ id: "1" }, Row)).toThrow();
  });

  it("batchRows and batchRow read the statement at an index", () => {
    const results = batch([{ id: 1 }, { id: 2 }]);
    expect(batchRows(results, 1, Row)).toEqual([{ id: 1 }, { id: 2 }]);
    expect(batchRow(results, 1, Row)).toEqual({ id: 1 });
    expect(batchRows(results, 0, Row)).toEqual([]);
    expect(batchRow(results, 0, Row)).toBeUndefined();
    expect(batchRows(results, 5, Row)).toEqual([]);
    expect(() => batchRows(batch([{ id: "x" }]), 1, Row)).toThrow();
  });
});
