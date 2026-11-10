import { describe, expect, it } from "vitest";
import { isReadOnlyQuery } from "../../src/db/public-inputs";

describe("isReadOnlyQuery", () => {
  it("treats SELECT and write-free CTE queries as reads", () => {
    expect(isReadOnlyQuery("  select 1")).toBe(true);
    expect(isReadOnlyQuery("\nWITH t AS (SELECT 1 AS n)\nSELECT n FROM t")).toBe(true);
  });

  it("treats writes, including CTE-prefixed writes, as writes", () => {
    expect(isReadOnlyQuery("UPDATE matches SET status = 'Complete'")).toBe(false);
    expect(isReadOnlyQuery("WITH t AS (SELECT 1) DELETE FROM sync_log")).toBe(false);
    expect(isReadOnlyQuery("WITH t AS (SELECT 1) INSERT INTO x SELECT * FROM t")).toBe(false);
  });
});
