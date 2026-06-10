import { describe, expect, it } from "vitest";
import { assertReadOnlySql, ReadOnlySqlError } from "../src/sandbox/sql-guard";

describe("assertReadOnlySql", () => {
  it("allows plain SELECT statements", () => {
    expect(() => assertReadOnlySql("SELECT * FROM matches")).not.toThrow();
  });

  it("allows lowercase and whitespace-prefixed select", () => {
    expect(() => assertReadOnlySql("  \n select 1")).not.toThrow();
  });

  it("allows read-only CTEs", () => {
    expect(() =>
      assertReadOnlySql("WITH recent AS (SELECT * FROM matches) SELECT * FROM recent"),
    ).not.toThrow();
  });

  it("allows EXPLAIN of a read", () => {
    expect(() => assertReadOnlySql("EXPLAIN QUERY PLAN SELECT 1")).not.toThrow();
  });

  it("allows leading comments before a read", () => {
    expect(() => assertReadOnlySql("-- top scorers\nSELECT 1")).not.toThrow();
    expect(() => assertReadOnlySql("/* x */ SELECT 1")).not.toThrow();
  });

  it("is not confused by write keywords inside string literals", () => {
    expect(() =>
      assertReadOnlySql("SELECT * FROM sync_log WHERE message = 'delete failed'"),
    ).not.toThrow();
  });

  it("is not confused by column names containing write keywords", () => {
    expect(() => assertReadOnlySql("SELECT updated_at, created_at FROM matches")).not.toThrow();
  });

  it("rejects DELETE", () => {
    expect(() => assertReadOnlySql("DELETE FROM matches")).toThrow(ReadOnlySqlError);
  });

  it("rejects INSERT, UPDATE, DROP, PRAGMA, ATTACH", () => {
    for (const sql of [
      "INSERT INTO matches VALUES (1)",
      "UPDATE matches SET round = 'R1'",
      "DROP TABLE matches",
      "PRAGMA table_info(matches)",
      "ATTACH DATABASE 'x' AS x",
    ]) {
      expect(() => assertReadOnlySql(sql)).toThrow(ReadOnlySqlError);
    }
  });

  it("rejects writes hidden behind a CTE", () => {
    expect(() =>
      assertReadOnlySql("WITH x AS (SELECT 1) DELETE FROM matches WHERE 1 IN (SELECT * FROM x)"),
    ).toThrow(ReadOnlySqlError);
  });

  it("rejects writes hidden behind comments", () => {
    expect(() => assertReadOnlySql("/* SELECT */ DROP TABLE matches")).toThrow(ReadOnlySqlError);
  });

  it("rejects transaction control", () => {
    expect(() => assertReadOnlySql("BEGIN")).toThrow(ReadOnlySqlError);
  });

  it("rejects empty and non-SQL input", () => {
    expect(() => assertReadOnlySql("")).toThrow(ReadOnlySqlError);
    expect(() => assertReadOnlySql("-- only a comment")).toThrow(ReadOnlySqlError);
  });
});
