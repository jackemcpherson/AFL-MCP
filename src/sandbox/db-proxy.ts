import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "../types";
import { assertReadOnlySql } from "./sql-guard";

/**
 * RPC entrypoint the sandbox isolate receives as `env.__db`.
 *
 * Lives apart from the executor so modules that only start sandboxes do not
 * import `cloudflare:workers`, and can load in the Node test pool. The Worker
 * entry re-exports it so `ctx.exports.DbProxy` resolves at runtime.
 */
export class DbProxy extends WorkerEntrypoint<Env> {
  /**
   * Run one read-only statement and return every row.
   *
   * @param sql - SQL text from sandbox code. Rejected unless read-only.
   * @param params - Positional bind values.
   * @returns The D1 result with all rows.
   * @throws {Error} When the SQL guard rejects the statement or D1 fails.
   * @example
   * await env.__db.query("SELECT id FROM teams WHERE name = ?", "Carlton");
   */
  async query(sql: string, ...params: unknown[]): Promise<D1Result<Record<string, unknown>>> {
    assertReadOnlySql(sql);
    const stmt = this.env.DB.prepare(sql);
    const bound = params.length > 0 ? stmt.bind(...params) : stmt;
    return await bound.all();
  }

  /**
   * Run one read-only statement and return its first row.
   *
   * @param sql - SQL text from sandbox code. Rejected unless read-only.
   * @param params - Positional bind values.
   * @returns The first row, or `null` when there is none.
   * @throws {Error} When the SQL guard rejects the statement or D1 fails.
   * @example
   * await env.__db.queryFirst("SELECT COUNT(*) AS n FROM matches");
   */
  async queryFirst(sql: string, ...params: unknown[]): Promise<Record<string, unknown> | null> {
    assertReadOnlySql(sql);
    const stmt = this.env.DB.prepare(sql);
    const bound = params.length > 0 ? stmt.bind(...params) : stmt;
    return await bound.first();
  }
}
