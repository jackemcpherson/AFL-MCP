import type { Env } from "../types";

/**
 * Mark an input write as active so native readers can reject mixed snapshots.
 *
 * @param env - Worker bindings.
 * @param now - Clock instant recorded for stale-writer recovery.
 * @returns A promise that resolves after D1 records the active write.
 * @throws If the D1 update fails.
 * @example
 * await beginPublicInputWrite(env);
 */
export async function beginPublicInputWrite(env: Env, now = new Date()): Promise<void> {
  await env.DB.prepare(
    "UPDATE public_input_revision SET in_progress = 1, write_started_at = ?1 WHERE id = 1",
  )
    .bind(now.toISOString())
    .run();
}

/**
 * Mark the shared input write complete after all meaningful writes settle.
 *
 * @param env - Worker bindings.
 * @returns A promise that resolves after D1 clears the active write marker.
 * @throws If the D1 update fails.
 * @example
 * await finishPublicInputWrite(env);
 */
export async function finishPublicInputWrite(env: Env): Promise<void> {
  await env.DB.prepare(
    "UPDATE public_input_revision SET in_progress = 0, write_started_at = NULL WHERE id = 1",
  ).run();
}
