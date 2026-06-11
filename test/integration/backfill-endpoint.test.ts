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

function makeRequest(body: unknown, token: string | null = ADMIN_TOKEN): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token !== null) {
    headers.Authorization = `Bearer ${token}`;
  }
  return new Request("https://afl.test/mcp/admin/backfill", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

interface ErrorResponse {
  error: string;
}

describe("POST /mcp/admin/backfill — authentication", () => {
  it("returns 503 when no admin token is configured (fail closed)", async () => {
    const res = await worker.fetch(
      makeRequest({ competitions: ["AFLW"], fromYear: 2025, toYear: 2025 }),
      (() => {
        const { ADMIN_TOKEN: _omitted, ...withoutToken } = authedEnv;
        return withoutToken as Env;
      })(),
      stubCtx,
    );
    expect(res.status).toBe(503);
  });

  it("returns 401 without an Authorization header", async () => {
    const res = await worker.fetch(
      makeRequest({ competitions: ["AFLW"], fromYear: 2025, toYear: 2025 }, null),
      authedEnv,
      stubCtx,
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 with a wrong token", async () => {
    const res = await worker.fetch(
      makeRequest({ competitions: ["AFLW"], fromYear: 2025, toYear: 2025 }, "wrong-token"),
      authedEnv,
      stubCtx,
    );
    expect(res.status).toBe(401);
  });

  it("gates every /mcp/admin/* route, not just backfill", async () => {
    for (const path of ["sync", "recalculate-pav", "recalculate-all-pav"]) {
      const res = await worker.fetch(
        new Request(`https://afl.test/mcp/admin/${path}`, { method: "POST" }),
        authedEnv,
        stubCtx,
      );
      expect(res.status).toBe(401);
    }
  });
});

describe("POST /mcp/admin/backfill — input validation", () => {
  it("returns 400 for invalid JSON body", async () => {
    const req = new Request("https://afl.test/mcp/admin/backfill", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ADMIN_TOKEN}`,
      },
      body: "{not json",
    });
    const res = await worker.fetch(req, authedEnv, stubCtx);
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorResponse;
    expect(body.error).toMatch(/invalid JSON/i);
  });

  it("returns 400 when competitions is missing", async () => {
    const res = await worker.fetch(
      makeRequest({ fromYear: 2025, toYear: 2025 }),
      authedEnv,
      stubCtx,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorResponse;
    expect(body.error).toMatch(/competitions/);
  });

  it("returns 400 when competitions is empty", async () => {
    const res = await worker.fetch(
      makeRequest({ competitions: [], fromYear: 2025, toYear: 2025 }),
      authedEnv,
      stubCtx,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorResponse;
    expect(body.error).toMatch(/competitions/);
  });

  it("returns 400 for an unknown competition code", async () => {
    const res = await worker.fetch(
      makeRequest({ competitions: ["NOPE"], fromYear: 2025, toYear: 2025 }),
      authedEnv,
      stubCtx,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorResponse;
    expect(body.error).toMatch(/invalid competition/i);
  });

  it("returns 400 when fromYear is not an integer", async () => {
    const res = await worker.fetch(
      makeRequest({ competitions: ["AFLW"], fromYear: "2025", toYear: 2025 }),
      authedEnv,
      stubCtx,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorResponse;
    expect(body.error).toMatch(/fromYear/);
  });

  it("returns 400 when toYear < fromYear", async () => {
    const res = await worker.fetch(
      makeRequest({ competitions: ["AFLW"], fromYear: 2025, toYear: 2020 }),
      authedEnv,
      stubCtx,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorResponse;
    expect(body.error).toMatch(/toYear/);
  });

  it("returns 400 for years before 1897 or in the future", async () => {
    for (const [fromYear, toYear] of [
      [1800, 1810],
      [2025, 2099],
    ]) {
      const res = await worker.fetch(
        makeRequest({ competitions: ["AFLM"], fromYear, toYear }),
        authedEnv,
        stubCtx,
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrorResponse;
      expect(body.error).toMatch(/years must be between/i);
    }
  });

  it("returns 400 when the year range exceeds the per-request cap", async () => {
    const res = await worker.fetch(
      makeRequest({ competitions: ["AFLM"], fromYear: 1897, toYear: 2025 }),
      authedEnv,
      stubCtx,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorResponse;
    expect(body.error).toMatch(/year range too large/i);
  });

  it("returns 404 for authorised requests to unknown admin routes", async () => {
    const req = new Request("https://afl.test/mcp/admin/backfill", {
      method: "GET",
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    const res = await worker.fetch(req, authedEnv, stubCtx);
    // GET doesn't match the POST-gated backfill route; admin paths no longer
    // fall through to the public MCP handler.
    expect(res.status).toBe(404);
  });
});
