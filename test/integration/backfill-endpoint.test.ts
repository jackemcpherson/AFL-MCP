import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {},
}));

import worker from "../../src/index";

const stubCtx = { waitUntil: () => {} } as unknown as ExecutionContext;

function makeRequest(body: unknown): Request {
  return new Request("https://afl.test/mcp/admin/backfill", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

interface ErrorResponse {
  error: string;
}

describe("POST /mcp/admin/backfill — input validation", () => {
  it("returns 400 for invalid JSON body", async () => {
    const req = new Request("https://afl.test/mcp/admin/backfill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    const res = await worker.fetch(req, env, stubCtx);
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorResponse;
    expect(body.error).toMatch(/invalid JSON/i);
  });

  it("returns 400 when competitions is missing", async () => {
    const res = await worker.fetch(makeRequest({ fromYear: 2025, toYear: 2025 }), env, stubCtx);
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorResponse;
    expect(body.error).toMatch(/competitions/);
  });

  it("returns 400 when competitions is empty", async () => {
    const res = await worker.fetch(
      makeRequest({ competitions: [], fromYear: 2025, toYear: 2025 }),
      env,
      stubCtx,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorResponse;
    expect(body.error).toMatch(/competitions/);
  });

  it("returns 400 for an unknown competition code", async () => {
    const res = await worker.fetch(
      makeRequest({ competitions: ["NOPE"], fromYear: 2025, toYear: 2025 }),
      env,
      stubCtx,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorResponse;
    expect(body.error).toMatch(/invalid competition/i);
  });

  it("returns 400 when fromYear is not an integer", async () => {
    const res = await worker.fetch(
      makeRequest({ competitions: ["AFLW"], fromYear: "2025", toYear: 2025 }),
      env,
      stubCtx,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorResponse;
    expect(body.error).toMatch(/fromYear/);
  });

  it("returns 400 when toYear < fromYear", async () => {
    const res = await worker.fetch(
      makeRequest({ competitions: ["AFLW"], fromYear: 2025, toYear: 2020 }),
      env,
      stubCtx,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorResponse;
    expect(body.error).toMatch(/toYear/);
  });

  it("rejects non-POST methods (falls through to MCP handler, which returns 405)", async () => {
    const req = new Request("https://afl.test/mcp/admin/backfill", { method: "GET" });
    const res = await worker.fetch(req, env, stubCtx);
    // The GET doesn't match the POST-gated backfill route; the path starts
    // with /mcp/ so it hits the MCP handler, which rejects non-POST with 405.
    expect(res.status).toBe(405);
  });
});
