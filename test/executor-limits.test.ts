import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {},
}));

import { executeCode, sanitizeErrorMessage } from "../src/sandbox/executor";
import type { Env } from "../src/types";

const stubCtx = {
  exports: { DbProxy: (_opts: unknown) => ({}) },
} as unknown as ExecutionContext;

function envWithLoaderFetch(fetchImpl: () => Promise<Response>): Env {
  return {
    LOADER: {
      load: () => ({ getEntrypoint: () => ({ fetch: fetchImpl }) }),
    },
  } as unknown as Env;
}

describe("executeCode limits", () => {
  it("times out when the sandbox never responds", async () => {
    const env = envWithLoaderFetch(() => new Promise<Response>(() => {}));
    const result = await executeCode("return 1", env, stubCtx, 50);
    expect(result.error).toMatch(/timed out/i);
    expect(result.result).toBeNull();
  });

  it("truncates serialized results over the cap", async () => {
    const oversized = JSON.stringify("x".repeat(1_100_000));
    const env = envWithLoaderFetch(async () => new Response(oversized));
    const result = await executeCode("return big", env, stubCtx);
    expect(result.error).toBeUndefined();
    expect(typeof result.result).toBe("string");
    expect(result.result as string).toMatch(/truncated/);
    expect((result.result as string).length).toBeLessThan(1_100_000);
  });

  it("returns parsed JSON results under the cap untouched", async () => {
    const env = envWithLoaderFetch(async () => new Response(JSON.stringify({ rows: [1, 2, 3] })));
    const result = await executeCode("return rows", env, stubCtx);
    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({ rows: [1, 2, 3] });
  });
});

describe("sanitizeErrorMessage", () => {
  it("keeps a plain message", () => {
    expect(sanitizeErrorMessage(new Error("no such table: foo"))).toBe("no such table: foo");
  });

  it("drops everything after the first line", () => {
    expect(sanitizeErrorMessage(new Error("boom\n  at /internal/path.ts:1:1"))).toBe("boom");
  });

  it("caps very long messages", () => {
    const sanitized = sanitizeErrorMessage(new Error("y".repeat(2_000)));
    expect(sanitized.length).toBeLessThanOrEqual(501);
  });

  it("falls back when there is no usable message", () => {
    expect(sanitizeErrorMessage(new Error(""))).toBe("execution failed");
  });
});
