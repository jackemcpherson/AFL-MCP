import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  booleanDefault,
  evidenceSchema,
  IsoDateSchema,
  NonEmptyStringSchema,
  PositiveIntSchema,
  SeasonKeySelectorSchema,
  Sha256HexSchema,
  toSeasonSelector,
  UrlStringSchema,
} from "../../src/lib/schemas";

describe("field schemas", () => {
  it.each([
    ["PositiveIntSchema", PositiveIntSchema, [1, 2_147_483_647], [0, -1, 1.5, "1"]],
    ["NonEmptyStringSchema", NonEmptyStringSchema, ["a", " "], ["", 1]],
    ["Sha256HexSchema", Sha256HexSchema, ["0".repeat(64)], ["0".repeat(63), "A".repeat(64)]],
    ["UrlStringSchema", UrlStringSchema, ["https://example.test/a"], ["example.test", ""]],
    ["IsoDateSchema", IsoDateSchema, ["2024-02-29"], ["2023-02-29", "2024-2-01", "2024-02-29T00"]],
    ["SeasonKeySelectorSchema", SeasonKeySelectorSchema, [2024, "2024", "2022-S7"], ["2022-S8"]],
  ] as const)("%s accepts valid values and rejects the rest", (_, schema, valid, invalid) => {
    const is = Schema.is(schema);
    for (const value of valid) expect(is(value), String(value)).toBe(true);
    for (const value of invalid) expect(is(value), String(value)).toBe(false);
  });
});

describe("booleanDefault", () => {
  const decode = Schema.decodeUnknownSync(Schema.Struct({ dryRun: booleanDefault(true) }));

  it("fills a missing key with the default and keeps a supplied value", () => {
    expect(decode({})).toEqual({ dryRun: true });
    expect(decode({ dryRun: false })).toEqual({ dryRun: false });
  });

  it("still rejects a non-boolean value", () => {
    expect(() => decode({ dryRun: "false" })).toThrow();
  });
});

describe("evidenceSchema", () => {
  const is = Schema.is(evidenceSchema(20));
  const item = (explanation: string) => ({
    url: "https://example.test/evidence",
    sha256: "f".repeat(64),
    explanation,
  });

  it("accepts an explanation at the minimum length and rejects one character less", () => {
    expect(is(item("x".repeat(20)))).toBe(true);
    expect(is(item("x".repeat(19)))).toBe(false);
  });

  it("checks the URL and digest of each item", () => {
    expect(is({ ...item("x".repeat(20)), url: "not a url" })).toBe(false);
    expect(is({ ...item("x".repeat(20)), sha256: "f".repeat(63) })).toBe(false);
  });
});

describe("toSeasonSelector", () => {
  it("passes through years and AFLW split keys", () => {
    expect(toSeasonSelector(2024)).toBe(2024);
    expect(toSeasonSelector("2022-S6")).toBe("2022-S6");
  });

  it("throws for a string that is not a season key", () => {
    expect(() => toSeasonSelector("2022-S8")).toThrow();
    expect(() => toSeasonSelector("latest")).toThrow();
  });
});
