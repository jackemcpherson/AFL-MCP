import type { Env } from "../types"

export async function logSync(env: Env, type: string, rowsAffected: number, error?: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO sync_log (timestamp, type, rows_affected, error) VALUES (?, ?, ?, ?)"
  ).bind(
    new Date().toISOString(),
    type,
    rowsAffected,
    error ?? null,
  ).run()
}
