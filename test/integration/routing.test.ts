import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {},
}));

import worker from "../../src/index";
import type { Env } from "../../src/types";

const stubCtx = { waitUntil: () => {} } as unknown as ExecutionContext;

async function get(path: string): Promise<Response> {
  return worker.fetch(new Request(`https://afl.test${path}`), env as Env, stubCtx);
}

describe("root and unknown-path routing", () => {
  it("serves the banner at the root path", async () => {
    const res = await get("/");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("Australian Football MCP Server");
  });

  it("returns 404 for arbitrary unknown paths", async () => {
    const res = await get("/nope");
    expect(res.status).toBe(404);
  });

  // Claude Web probes these before connecting; anything but 404 makes it
  // assume OAuth is configured and attempt client registration, which
  // fails and blocks the connection.
  it.each([
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp",
    "/.well-known/oauth-authorization-server",
    "/.well-known/openid-configuration",
  ])("returns 404 for OAuth discovery probe %s", async (path) => {
    const res = await get(path);
    expect(res.status).toBe(404);
  });
});

it("returns a safe 409 for an unapproved PAV write", async () => {
  await env.DB.prepare(
    "INSERT INTO seasons(competition_id,year,season_key) VALUES(1,2026,'2026')",
  ).run();
  const response = await worker.fetch(
    new Request("https://afl.test/mcp/admin/recalculate-pav", {
      method: "POST",
      headers: { Authorization: "Bearer test-admin" },
      body: JSON.stringify({ competition: "AFLM", season: 2026, dryRun: false }),
    }),
    { ...env, ADMIN_TOKEN: "test-admin" } as Env,
    stubCtx,
  );
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    error: "PAV preview missing or stale",
    code: "OPERATION_CONFLICT",
  });
  expect(
    await env.DB.prepare("SELECT in_progress FROM public_input_revision").first("in_progress"),
  ).toBe(0);
});
