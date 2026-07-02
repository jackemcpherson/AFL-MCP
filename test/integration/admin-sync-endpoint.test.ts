import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

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
