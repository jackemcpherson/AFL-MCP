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
  async query(sql: string, ...params: unknown[]) {
    assertReadOnlySql(sql);
    const stmt = this.env.DB.prepare(sql);
    const bound = params.length > 0 ? stmt.bind(...params) : stmt;
    return await bound.all();
  }

  async queryFirst(sql: string, ...params: unknown[]) {
    assertReadOnlySql(sql);
    const stmt = this.env.DB.prepare(sql);
    const bound = params.length > 0 ? stmt.bind(...params) : stmt;
    return await bound.first();
  }
}
