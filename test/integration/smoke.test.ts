import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("integration test infrastructure", () => {
  it("D1 binding is available with the schema applied", async () => {
    const result = await env.DB.prepare("SELECT code FROM competitions ORDER BY code").all<{
      code: string;
    }>();
    expect(result.results.map((r) => r.code)).toEqual(["AFLM", "AFLW"]);
  });

  it("matches table is empty and writable", async () => {
    const before = await env.DB.prepare("SELECT COUNT(*) as n FROM matches").first<{
      n: number;
    }>();
    expect(before?.n).toBe(0);
  });
});
