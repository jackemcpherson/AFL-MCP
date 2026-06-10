import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

interface McpToolResponse {
  result?: {
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  };
}

async function callCodeTool(code: string): Promise<McpToolResponse> {
  const res = await SELF.fetch("https://afl.test/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "code", arguments: { code } },
    }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as McpToolResponse;
}

describe("sandbox security (end-to-end through the MCP endpoint)", () => {
  it("executes read-only SELECT statements", async () => {
    const body = await callCodeTool(
      'return db.prepare("SELECT code FROM competitions ORDER BY code").all()',
    );
    expect(body.result?.isError).toBeUndefined();
    expect(body.result?.content[0]?.text).toContain("AFLM");
  });

  it("rejects DELETE through the sandbox", async () => {
    const body = await callCodeTool('return db.prepare("DELETE FROM matches").all()');
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content[0]?.text).toMatch(/read-only/i);
  });

  it("rejects INSERT, UPDATE, DROP and PRAGMA through the sandbox", async () => {
    for (const sql of [
      "INSERT INTO sync_log (timestamp, type) VALUES ('x', 'x')",
      "UPDATE competitions SET code = 'HAX'",
      "DROP TABLE matches",
      "PRAGMA table_info(matches)",
    ]) {
      const body = await callCodeTool(`return db.prepare(${JSON.stringify(sql)}).all()`);
      expect(body.result?.isError).toBe(true);
      expect(body.result?.content[0]?.text).toMatch(/read-only/i);
    }
  });

  it("rejects writes via first() as well as all()", async () => {
    const body = await callCodeTool('return db.prepare("DELETE FROM matches").first()');
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content[0]?.text).toMatch(/read-only/i);
  });

  it("rejects CTE-wrapped writes", async () => {
    const body = await callCodeTool(
      'return db.prepare("WITH x AS (SELECT 1) DELETE FROM matches").all()',
    );
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content[0]?.text).toMatch(/read-only/i);
  });

  it("leaves the database untouched after rejected writes", async () => {
    await callCodeTool('return db.prepare("DELETE FROM competitions").all()');
    const after = await env.DB.prepare("SELECT COUNT(*) AS n FROM competitions").first<{
      n: number;
    }>();
    expect(after?.n).toBeGreaterThan(0);
  });
});
