import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {},
}));

import worker from "../../src/index";
import type { Env } from "../../src/types";

const stubCtx = { waitUntil: () => {} } as unknown as ExecutionContext;

async function getHealth(): Promise<Response> {
  return worker.fetch(new Request("https://afl.test/mcp/health"), env as Env, stubCtx);
}

async function seedSyncLog(timestamp: string, error: string | null): Promise<void> {
  await (env as Env).DB.prepare(
    "INSERT INTO sync_log (timestamp, type, rows_affected, error) VALUES (?, 'sync:AFLM', 0, ?)",
  )
    .bind(timestamp, error)
    .run();
}

describe("GET /mcp/health (OPS-02)", () => {
  it("returns 200 ok for a fresh, error-free sync", async () => {
    await seedSyncLog(new Date().toISOString(), null);
    const res = await getHealth();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; stale: boolean };
    expect(body.status).toBe("ok");
    expect(body.stale).toBe(false);
  });

  it("returns 503 when the last sync is stale", async () => {
    await seedSyncLog(new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(), null);
    const res = await getHealth();
    expect(res.status).toBe(503);
    const body = (await res.json()) as { status: string; stale: boolean };
    expect(body.status).toBe("unhealthy");
    expect(body.stale).toBe(true);
  });

  it("returns 503 when there is no sync history at all", async () => {
    const res = await getHealth();
    expect(res.status).toBe(503);
  });

  it("returns 503 when the last sync recorded an error", async () => {
    await seedSyncLog(new Date().toISOString(), "fetchMatches failed: boom");
    const res = await getHealth();
    expect(res.status).toBe(503);
    const body = (await res.json()) as { status: string; stale: boolean };
    expect(body.status).toBe("unhealthy");
    expect(body.stale).toBe(false);
  });
});
