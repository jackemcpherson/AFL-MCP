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

async function seedSyncLog(
  timestamp: string,
  error: string | null,
  type = "sync:AFLM",
): Promise<void> {
  await (env as Env).DB.prepare(
    "INSERT INTO sync_log (timestamp, type, rows_affected, error) VALUES (?, ?, 0, ?)",
  )
    .bind(timestamp, type, error)
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

  it("returns 503 when a competition-level sync recorded a recent error", async () => {
    await seedSyncLog(new Date().toISOString(), "fetchMatches failed: boom");
    const res = await getHealth();
    expect(res.status).toBe(503);
    const body = (await res.json()) as { status: string; stale: boolean };
    expect(body.status).toBe("unhealthy");
    expect(body.stale).toBe(false);
  });

  it("returns 503 when a sync:fatal row is recent", async () => {
    await seedSyncLog(new Date().toISOString(), null);
    await seedSyncLog(new Date().toISOString(), "gate exploded", "sync:fatal");
    const res = await getHealth();
    expect(res.status).toBe(503);
  });

  it("stays 200 for routine sub-task degradations like lineup 404s", async () => {
    await seedSyncLog(new Date().toISOString(), null);
    await seedSyncLog(
      new Date().toISOString(),
      "fetchLineup failed: Request failed: 404 Not Found",
      "sync:AFLW:lineups",
    );
    const res = await getHealth();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ok");
  });

  it("does not treat Brownlow operation logs as cron freshness", async () => {
    await seedSyncLog(new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(), null);
    await seedSyncLog(new Date().toISOString(), null, "admin:brownlow-backfill");
    const res = await getHealth();
    expect(res.status).toBe(503);
    const body = (await res.json()) as { stale: boolean };
    expect(body.stale).toBe(true);
  });

  it("recovers after a successful retry without deleting the failure record", async () => {
    await seedSyncLog(new Date().toISOString(), "D1 import in progress", "sync:AFLW");
    await seedSyncLog(new Date().toISOString(), null, "sync:AFLW");
    expect((await getHealth()).status).toBe(200);
    const failure = await (env as Env).DB.prepare(
      "SELECT error FROM sync_log WHERE error IS NOT NULL",
    ).first<{ error: string }>();
    expect(failure?.error).toBe("D1 import in progress");
  });

  it("does not clear another competition's failure or accept sub-task recovery", async () => {
    await seedSyncLog(new Date().toISOString(), "failed", "sync:AFLW");
    await seedSyncLog(new Date().toISOString(), null, "sync:AFLM");
    await seedSyncLog(new Date().toISOString(), null, "sync:AFLW:lineups");
    expect((await getHealth()).status).toBe(503);
  });

  it("keeps an unresolved failure visible after another competition recovers", async () => {
    await seedSyncLog(new Date().toISOString(), "failed", "sync:AFLM");
    await seedSyncLog(new Date().toISOString(), "failed", "sync:AFLW");
    await seedSyncLog(new Date().toISOString(), null, "sync:AFLW");
    expect((await getHealth()).status).toBe(503);
  });

  it("does not clear fatal errors after a competition succeeds", async () => {
    await seedSyncLog(new Date().toISOString(), "fatal", "sync:fatal");
    await seedSyncLog(new Date().toISOString(), null, "sync:AFLW");
    expect((await getHealth()).status).toBe(503);
  });

  it("recovers to 200 once a critical error ages out of the window", async () => {
    await seedSyncLog(
      new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
      "fetchMatches failed: boom",
    );
    await seedSyncLog(new Date().toISOString(), null);
    const res = await getHealth();
    expect(res.status).toBe(200);
  });

  it("does not include raw error text in the response body", async () => {
    await seedSyncLog(new Date().toISOString(), "fetchMatches failed: secret-internal-detail");
    const res = await getHealth();
    expect(res.status).toBe(503);
    const body = await res.json();
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("secret-internal-detail");
    expect(serialized).toContain('"has_recent_critical_error":true');
  });

  it("response payload contains exactly the trimmed set of keys", async () => {
    await seedSyncLog(new Date().toISOString(), null);
    const res = await getHealth();
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      "has_recent_critical_error",
      "last_sync_age_ms",
      "latest_match",
      "stale",
      "status",
    ]);
  });
});
