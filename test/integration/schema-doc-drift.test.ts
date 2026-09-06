import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getSchemaInfo } from "../../src/mcp/tools/schema";
import type { Env } from "../../src/types";

/**
 * DOC-01: the `schema` tool's prose is maintained by hand and previously
 * drifted from the real database. This test compares it against the live
 * migrated D1 schema, so any new table or column that isn't documented
 * fails CI.
 */

/** Operational tables not part of the documented analytics surface. */
const INTERNAL_TABLES = new Set([
  "d1_migrations",
  "sync_lease",
  "sync_log",
  "_cf_KV",
  "tipper_runs",
  "tipper_predictions",
  "tipper_game_ids",
  "tipper_reports",
  "tipper_status",
  "tipper_reconstruction_batches",
  "tipper_reconstructions",
]);

describe("schema tool vs live D1 schema", () => {
  it("documents every analytics table and column", async () => {
    const doc = JSON.stringify(await getSchemaInfo());

    const tables = await (env as Env).DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'",
    ).all<{ name: string }>();

    const analyticsTables = tables.results
      .map((t) => t.name)
      .filter((name) => !INTERNAL_TABLES.has(name));
    expect(analyticsTables.length).toBeGreaterThan(0);

    for (const table of analyticsTables) {
      expect(doc, `schema tool is missing table ${table}`).toContain(table);
      const columns = await (env as Env).DB.prepare(`PRAGMA table_info(${table})`).all<{
        name: string;
      }>();
      for (const column of columns.results) {
        expect(doc, `schema tool is missing ${table}.${column.name}`).toContain(column.name);
      }
    }
  });

  it("covers every live analytics table with a default and only real columns as exceptions", async () => {
    const schema = await getSchemaInfo();
    const contract = schema.database.coverage_contract.by_competition;
    const tables = await (env as Env).DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'",
    ).all<{ name: string }>();

    for (const table of tables.results
      .map((row) => row.name)
      .filter((name) => !INTERNAL_TABLES.has(name))) {
      const columns = await (env as Env).DB.prepare(`PRAGMA table_info(${table})`).all<{
        name: string;
      }>();
      const liveColumns = new Set(columns.results.map((c) => c.name));
      for (const competition of ["AFLM", "AFLW", "VFL", "VFLW"] as const) {
        // v2 contract: a table default covers every column; exceptions
        // must name real columns so stale entries fail CI.
        const tableContract = contract[competition][table];
        expect(
          tableContract?.expected,
          `coverage contract is missing a ${competition}.${table} default`,
        ).toBeDefined();
        expect(tableContract?.range, `${competition}.${table} default has no range`).toBeDefined();
        for (const exception of Object.keys(tableContract?.columns ?? {})) {
          expect(
            liveColumns.has(exception),
            `coverage exception ${competition}.${table}.${exception} names a column not in the live schema`,
          ).toBe(true);
        }
      }
    }
  });
});
