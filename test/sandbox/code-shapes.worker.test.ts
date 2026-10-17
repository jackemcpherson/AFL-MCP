/**
 * The `code` tool's language and code-shape contract, end to end through a
 * real Dynamic Worker: what the tool description promises about `db`, the
 * accepted code shapes, and the errors for TypeScript and missing returns.
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

function text(body: McpToolResponse): string {
  return body.result?.content[0]?.text ?? "";
}

const HINT = "The sandbox runs JavaScript. Remove type annotations.";

describe("code tool db API matches the declaration", () => {
  it("all() returns results, success and meta", async () => {
    const body = await callCodeTool(
      "const r = await db.prepare('SELECT 1 AS one').all(); return { keys: Object.keys(r).sort(), results: r.results, success: r.success }",
    );
    expect(body.result?.structuredContent).toEqual({
      keys: ["meta", "results", "success"],
      results: [{ one: 1 }],
      success: true,
    });
  });

  it("first() returns one row, or null when there is none", async () => {
    const body = await callCodeTool(
      "return { row: await db.prepare('SELECT 2 AS two').first(), none: await db.prepare('SELECT 1 WHERE 0').first() }",
    );
    expect(body.result?.structuredContent).toEqual({
      row: { two: 2 },
      none: null,
    });
  });

  it("bind() fills ? placeholders and returns the statement", async () => {
    const body = await callCodeTool(
      "return await db.prepare('SELECT ? AS a, ? AS b').bind(1, 'x').first()",
    );
    expect(body.result?.structuredContent).toEqual({ a: 1, b: "x" });
  });
});

describe("code tool code shapes", () => {
  it("invokes a lone async arrow function", async () => {
    const body = await callCodeTool(
      "async () => {\n  const r = await db.prepare('SELECT 3 AS n').first();\n  return r;\n}",
    );
    expect(body.result?.isError).toBeUndefined();
    expect(body.result?.structuredContent).toEqual({ n: 3 });
  });

  it("strips a Markdown fence", async () => {
    const body = await callCodeTool("```js\nreturn { fenced: true }\n```");
    expect(body.result?.structuredContent).toEqual({ fenced: true });
  });

  it("explains code that returns no value", async () => {
    const body = await callCodeTool("await db.prepare('SELECT 1').all()");
    expect(body.result?.isError).toBe(true);
    expect(text(body)).toMatch(
      /^Execution error \(\d+ms\): The code returned no value\. End it with `return`/,
    );
  });
});

describe("code tool TypeScript errors", () => {
  it.each([
    ["an annotation", "const f = (x: number) => x\nreturn f(1)"],
    ["an interface", "interface Row { id: number }\nreturn 1"],
    ["a type alias", "type X = number\nreturn 1"],
    ["an as cast", "const y = 1 as number\nreturn y"],
    ["a generic function", "function g<T>(x: T): T { return x }\nreturn g(1)"],
  ])("reports the parser error with the hint for %s", async (_shape, code) => {
    const body = await callCodeTool(code);
    expect(body.result?.isError).toBe(true);
    expect(text(body)).toMatch(/^Execution error \(\d+ms\): SyntaxError: .+\. /);
    expect(text(body).endsWith(HINT)).toBe(true);
  });

  it("reports a JavaScript syntax error without the hint", async () => {
    const body = await callCodeTool("return {");
    expect(body.result?.isError).toBe(true);
    expect(text(body)).toMatch(/^Execution error \(\d+ms\): SyntaxError: /);
    expect(text(body)).not.toContain(HINT);
  });
});
