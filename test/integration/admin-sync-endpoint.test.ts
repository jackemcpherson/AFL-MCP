import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {},
}));

import worker from "../../src/index";
import type { Env } from "../../src/types";

const stubCtx = { waitUntil: () => {} } as unknown as ExecutionContext;

const ADMIN_TOKEN = "test-admin-token";
const authedEnv: Env = { ...(env as Env), ADMIN_TOKEN };

function makeRequest(token: string | null = ADMIN_TOKEN): Request {
  const headers: Record<string, string> = {};
  if (token !== null) {
    headers.Authorization = `Bearer ${token}`;
  }
  return new Request("https://afl.test/mcp/admin/sync", {
    method: "POST",
    headers,
  });
}

describe("POST /mcp/admin/sync — authentication", () => {
  it("returns 401 without an Authorization header", async () => {
    const res = await worker.fetch(makeRequest(null), authedEnv, stubCtx);
    expect(res.status).toBe(401);
  });

  it("returns 401 with a wrong token", async () => {
    const res = await worker.fetch(makeRequest("wrong-token"), authedEnv, stubCtx);
    expect(res.status).toBe(401);
  });
});

describe("POST /mcp/admin/sync — response shape", () => {
  afterEach(async () => {
    // Reset the sync lease so other tests start with a clean slate.
    await (env as Env).DB.prepare(
      "UPDATE sync_lease SET holder = NULL, acquired_at = NULL WHERE id = 1",
    ).run();
  });

  it("returns 200 with a results array (regression: pre-fix returned no results key)", async () => {
    // Pre-acquire the sync lease so sync() short-circuits without making
    // any outbound network requests. Migration 0012 inserts the row with
    // holder=NULL; this UPDATE holds it so acquireSyncLease() inside
    // sync() sees changes=0 and returns [] immediately.
    await (env as Env).DB.prepare(
      "UPDATE sync_lease SET holder = 'test', acquired_at = datetime('now') WHERE id = 1",
    ).run();

    const res = await worker.fetch(makeRequest(), authedEnv, stubCtx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; results: unknown };
    expect(body.status).toBe("ok");
    // Regression guard: the pre-fix code returned { status: "ok" } with
    // no results key, so Array.isArray(undefined) would have been false.
    expect(Array.isArray(body.results)).toBe(true);
  });
});
