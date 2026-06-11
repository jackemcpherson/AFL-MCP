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
const INTERNAL_TABLES = new Set(["d1_migrations", "sync_lease", "sync_log", "_cf_KV"]);

describe("schema tool vs live D1 schema", () => {
  it("documents every analytics table and column", async () => {
    const doc = JSON.stringify(getSchemaInfo());

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
});
