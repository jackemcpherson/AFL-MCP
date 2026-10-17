import type { Env } from "../types";

/**
 * Append one row to `sync_log`.
 *
 * @param env - Worker bindings.
 * @param type - Event type, such as `admin:brownlow-backfill`.
 * @param rowsAffected - Rows the step changed.
 * @param error - Failure message, when the step failed.
 * @returns Resolves once the row is written.
 * @example
 * await logSync(env, "admin:brownlow-backfill", 12);
 */
export async function logSync(
  env: Env,
  type: string,
  rowsAffected: number,
  error?: string,
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO sync_log (timestamp, type, rows_affected, error) VALUES (?, ?, ?, ?)",
  )
    .bind(new Date().toISOString(), type, rowsAffected, error ?? null)
    .run();
}
