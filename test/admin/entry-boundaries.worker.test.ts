import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import { testCtx } from "#test/fixtures";
import worker from "../../src/index";
import type { Env } from "../../src/types";

it("answers unknown paths under /mcp/ with 404 instead of the MCP handler", async () => {
  for (const path of ["/mcp/xyz", "/mcp/tools", "/mcp/.well-known/oauth-authorization-server"]) {
    const response = await worker.fetch(
      new Request(`https://afl.test${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      }),
      env,
      testCtx(),
    );
    expect(response.status).toBe(404);
  }
});

it("stores a bounded sync:fatal error without URL query strings", async () => {
  const secret = "https://upstream.test/feed?token=secret-value#frag";
  const failure = new Error(
    `fetch ${secret} failed ${"x".repeat(2_000)}\n    at stack (file.ts:1:1)`,
  );
  // Every statement except the fatal log row throws, so the tick fails before
  // its per-competition handling and reaches the entry's catch.
  const db = new Proxy(env.DB, {
    get(target, property) {
      if (property === "prepare")
        return (sql: string) => {
          if (sql.startsWith("INSERT INTO sync_log")) return target.prepare(sql);
          throw failure;
        };
      if (property === "batch")
        return () => {
          throw failure;
        };
      return Reflect.get(target, property);
    },
  });
  const pending: Promise<unknown>[] = [];
  const ctx: ExecutionContext = {
    ...testCtx(),
    waitUntil: (promise: Promise<unknown>) => {
      pending.push(promise);
    },
  };
  const failingEnv: Env = { ...env, DB: db };
  // SAFETY: the scheduled handler reads only `scheduledTime` from the event.
  const event = { scheduledTime: Date.now(), cron: "*/5 * * * *" } as ScheduledEvent;
  await worker.scheduled(event, failingEnv, ctx);
  await Promise.all(pending);
  const row = await env.DB.prepare(
    "SELECT error FROM sync_log WHERE type = 'sync:fatal' ORDER BY id DESC LIMIT 1",
  ).first<{ error: string }>();
  expect(row?.error).toMatch(/^fetch https:\/\/upstream\.test\/feed failed x+…$/);
  expect(row?.error).not.toContain("secret-value");
  expect(row?.error.length).toBeLessThanOrEqual(501);
});
