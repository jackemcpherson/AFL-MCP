import { OperationConflictError } from "../admin/errors";
import type { Env } from "../types";

/**
 * Start a public input write owned by the current, unexpired operation lease.
 * Existing markers require operator recovery, even after their lease expires.
 * @param env - Worker bindings.
 * @param holder - Lease owner token.
 * @param now - Timestamp for recovery diagnostics.
 * @throws If another write is unfinished or the lease is no longer owned.
 */
export async function beginPublicInputWrite(
  env: Env,
  holder: string,
  now = new Date(),
  operation: string | null = null,
): Promise<void> {
  const result = await env.DB.prepare(
    `UPDATE public_input_revision SET in_progress = 1, write_started_at = ?1, write_holder = ?2, write_operation = ?3
     WHERE id = 1 AND in_progress = 0 AND EXISTS (
       SELECT 1 FROM sync_lease WHERE id = 1 AND holder = ?2
       AND acquired_at >= datetime('now', '-10 minutes')
     )`,
  )
    .bind(now.toISOString(), holder, operation)
    .run();
  if (result.meta.changes !== 1)
    throw new OperationConflictError(
      "Input write requires an active lease and a recovered public marker",
    );
}

/**
 * Clear the marker after a consistent write, only while its owner retains the lease.
 * @param env - Worker bindings.
 * @param holder - Lease owner token used to begin the write.
 * @throws If the marker or unexpired lease belongs to another operation.
 */
export async function finishPublicInputWrite(env: Env, holder: string): Promise<void> {
  const result = await env.DB.prepare(
    `UPDATE public_input_revision SET in_progress = 0, write_started_at = NULL, write_holder = NULL, write_operation = NULL
     WHERE id = 1 AND write_holder = ?1 AND EXISTS (
       SELECT 1 FROM sync_lease WHERE id = 1 AND holder = ?1
       AND acquired_at >= datetime('now', '-10 minutes')
     )`,
  )
    .bind(holder)
    .run();
  if (result.meta.changes !== 1)
    throw new OperationConflictError("Input write lease lost; marker retained for recovery");
}

/**
 * Resume an explicitly requested, checkpointed operation without exposing partial inputs.
 * The marker must name exactly this operation; a newly acquired lease fences the old owner.
 * @param env - Worker bindings.
 * @param holder - Current lease owner.
 * @param operation - Persisted operation identity verified by the caller.
 * @throws If the marker belongs to another operation or the lease has expired.
 */
export async function resumePublicInputWrite(
  env: Env,
  holder: string,
  operation: string,
): Promise<void> {
  const result = await env.DB.prepare(`UPDATE public_input_revision SET write_holder=?1
    WHERE id=1 AND in_progress=1 AND write_operation=?2 AND EXISTS (
      SELECT 1 FROM sync_lease WHERE id=1 AND holder=?1
      AND acquired_at >= datetime('now', '-10 minutes'))`)
    .bind(holder, operation)
    .run();
  if (result.meta.changes !== 1)
    throw new OperationConflictError(
      "Recovery requires the matching operation marker and active lease",
    );
}

/**
 * Fence a transactional mutation against lease expiry or takeover.
 * Place this first in the same D1 batch as the writes. The marker's CHECK
 * constraint aborts the entire batch if the lease or marker has another owner.
 * @param env - Worker bindings.
 * @param holder - Lease owner responsible for this batch.
 * @returns Prepared assertion for an atomic write batch.
 */
export function publicInputWriteFence(env: Env, holder: string): D1PreparedStatement {
  return env.DB.prepare(`UPDATE public_input_revision SET in_progress=CASE
    WHEN in_progress=1 AND write_holder=?1 AND EXISTS (
      SELECT 1 FROM sync_lease WHERE id=1 AND holder=?1
      AND acquired_at >= datetime('now', '-10 minutes')) THEN 1 ELSE -1 END
    WHERE id=1`).bind(holder);
}

/**
 * Bind every database call in a writer to its public marker and operation lease.
 * A fence and each batch commit together, so an expired owner cannot continue
 * writing after another operator resumes the checkpoint. Use the original
 * environment to finish the marker and release the lease.
 * @param env - Original Worker bindings.
 * @param holder - Owner of an active public write marker.
 * @returns Bindings for use inside the marked write operation.
 */
export function protectOperationWrites(env: Env, holder: string): Env {
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const batch = async (statements: D1PreparedStatement[]) => {
    const results = await env.DB.batch([
      publicInputWriteFence(env, holder),
      ...statements.map((statement) => originals.get(statement) ?? statement),
    ]);
    return results.slice(1);
  };
  const protect = (statement: D1PreparedStatement): D1PreparedStatement => {
    const wrapped = new Proxy(statement, {
      get(target, property) {
        if (property === "bind") return (...values: unknown[]) => protect(target.bind(...values));
        if (property === "run" || property === "all") return async () => (await batch([target]))[0];
        if (property === "first")
          return async (column?: string) => {
            const row = (await batch([target]))[0]?.results[0] as
              | Record<string, unknown>
              | undefined;
            return column === undefined ? (row ?? null) : (row?.[column] ?? null);
          };
        if (property === "raw") throw new Error("Use all() inside a protected write operation");
        return Reflect.get(target, property);
      },
    });
    originals.set(wrapped, statement);
    return wrapped;
  };
  const DB = new Proxy(env.DB, {
    get(target, property) {
      if (property === "prepare") return (sql: string) => protect(target.prepare(sql));
      if (property === "batch") return batch;
      if (property === "exec" || property === "withSession")
        throw new Error("Use prepared batches inside a protected write operation");
      return Reflect.get(target, property);
    },
  });
  return { ...env, DB };
}
