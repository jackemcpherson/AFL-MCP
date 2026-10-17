/**
 * Console capture and structural truncation, end to end through a real
 * Dynamic Worker: what the sandbox writes reaches the model, bounded, and
 * an oversized result still parses.
 */
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

interface McpToolResponse {
  result?: {
    content: Array<{ type: string; text: string }>;
    structuredContent?: unknown;
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
  return await res.json<McpToolResponse>();
}

describe("code tool console output", () => {
  it("returns strings, objects and level prefixes after the result", async () => {
    const body = await callCodeTool(
      [
        "const loop = { name: 'loop' }",
        "loop.self = loop",
        "console.log('rows', 3)",
        "console.info({ team: 'Carlton' })",
        "console.warn(loop)",
        "console.error(new TypeError('bad'))",
        "console.debug(undefined, 10n)",
        "return { ok: true }",
      ].join("\n"),
    );
    expect(body.result?.isError).toBeUndefined();
    expect(body.result?.structuredContent).toEqual({ ok: true });
    expect(body.result?.content[1]?.text).toBe(
      [
        "Console output:",
        "rows 3",
        '[info] {"team":"Carlton"}',
        '[warn] {"name":"loop","self":"[Circular]"}',
        "[error] TypeError: bad",
        "[debug] undefined 10",
      ].join("\n"),
    );
  });

  it("returns lines written before a thrown error", async () => {
    const body = await callCodeTool("console.log('step 1')\nthrow new RangeError('stop')");
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content[0]?.text).toMatch(/^Execution error \(\d+ms\): stop$/);
    expect(body.result?.content[1]?.text).toBe("Console output:\nstep 1");
  });

  it("returns lines written before an unserialisable result", async () => {
    const body = await callCodeTool("console.log('about to return')\nreturn { n: 1n }");
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content[1]?.text).toBe("Console output:\nabout to return");
  });

  it("keeps the first 100 lines and counts the rest", async () => {
    const body = await callCodeTool(
      "for (let i = 0; i < 150; i++) console.log('line ' + i)\nreturn 1",
    );
    const lines = body.result?.content[1]?.text.split("\n") ?? [];
    expect(lines[0]).toBe("Console output:");
    expect(lines[1]).toBe("line 0");
    expect(lines[100]).toBe("line 99");
    expect(lines[101]).toBe("… [50 more console lines not shown]");
    expect(lines).toHaveLength(102);
  });

  it("adds no console block when nothing was written", async () => {
    const body = await callCodeTool("return 1");
    expect(body.result?.content).toHaveLength(1);
  });
});

describe("code tool result cap", () => {
  it("shortens an oversized result to valid JSON with a count notice", async () => {
    const body = await callCodeTool(
      "return { results: Array.from({ length: 20000 }, (_, id) => ({ id, team: 'Team ' + id })), success: true }",
    );
    expect(body.result?.isError).toBeUndefined();
    const text = body.result?.content[0]?.text ?? "";
    expect(text.length).toBeLessThanOrEqual(100_000);
    // SAFETY: the code returned this shape; the assertions below check it.
    const parsed = JSON.parse(text) as { results: unknown[]; success: boolean };
    expect(parsed.success).toBe(true);
    expect(parsed.results.at(-1)).toMatch(/^--- TRUNCATED: showing \d+ of 20000 items\./);
    expect(body.result?.structuredContent).toEqual(parsed);
  });
});
