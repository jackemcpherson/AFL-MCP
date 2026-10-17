import { Predicate } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testCtx, testEnv } from "#test/fixtures";
import { defaultDeps, handleMcpRequest } from "../../src/mcp/protocol";
import type { ExecuteResult } from "../../src/sandbox/executor";

const HINT = "The sandbox runs JavaScript. Remove type annotations.";

interface ToolResult {
  result?: { content?: { type: string; text: string }[]; isError?: boolean };
}

async function callCode(code: string, outcome: ExecuteResult): Promise<ToolResult> {
  const res = await handleMcpRequest(
    new Request("https://afl.test/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "code", arguments: { code } },
      }),
    }),
    testEnv(),
    testCtx(),
    { ...defaultDeps, executeCode: async () => outcome },
  );
  return await res.json<ToolResult>();
}

function syntaxError(message: string): ExecuteResult {
  return {
    result: null,
    error: message,
    errorClass: "SyntaxError",
    execution_time_ms: 1,
  };
}

describe("code tool TypeScript hint", () => {
  it.each([
    ["a parameter annotation", "const f = (x: number) => x\nreturn f(1)"],
    ["a variable annotation", "const rows: Row[] = []\nreturn rows"],
    ["an interface", "interface Row { id: number }\nreturn 1"],
    ["a type alias", "type Row = { id: number }\nreturn 1"],
    ["an as cast", "const r = (await db.prepare('SELECT 1').all()) as Result\nreturn r"],
    ["a generic call", "return await db.prepare('SELECT 1').first<Row>()"],
    ["a return type", "function f(): number { return 1 }\nreturn f()"],
  ])("appends the hint to a syntax error from %s", async (_shape, code) => {
    const body = await callCode(code, syntaxError("SyntaxError: Unexpected token ':'"));
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toBe(
      `Execution error (1ms): SyntaxError: Unexpected token ':'. ${HINT}`,
    );
  });

  it("leaves a JavaScript syntax error without the hint", async () => {
    const body = await callCode("return {", syntaxError("SyntaxError: Unexpected token ')'"));
    expect(body.result?.content?.[0]?.text).toBe(
      "Execution error (1ms): SyntaxError: Unexpected token ')'",
    );
  });

  it("leaves other error classes without the hint", async () => {
    const body = await callCode("const f = (x: number) => x", {
      result: null,
      error: "x is not a function",
      errorClass: "TypeError",
      execution_time_ms: 1,
    });
    expect(body.result?.content?.[0]?.text).toBe("Execution error (1ms): x is not a function");
  });
});

describe("code tool outcome logging", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function toolCodeEvents(calls: ReadonlyArray<ReadonlyArray<unknown>>): unknown[] {
    return calls
      .map((call) => call[0])
      .filter((line) => Predicate.isString(line) && line.includes('"tool:code"'))
      .map((line): unknown => JSON.parse(String(line)));
  }

  it("logs outcome ok for a successful run", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await callCode("return 1", { result: 1, execution_time_ms: 1 });
    expect(toolCodeEvents(spy.mock.calls)).toEqual([
      { event: "tool:code", competition: null, outcome: "ok" },
    ]);
  });

  it("logs outcome error with the error class and no user text", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = "const secret = (x: number) => x";
    await callCode(code, syntaxError("SyntaxError: Unexpected token ':'"));
    expect(toolCodeEvents(spy.mock.calls)).toEqual([
      {
        event: "tool:code",
        competition: null,
        outcome: "error",
        errorClass: "SyntaxError",
      },
    ]);
    const logged = spy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).not.toContain("secret");
    expect(logged).not.toContain("Unexpected token");
  });

  it("logs errorClass Error when the executor names no class", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await callCode("return 1", {
      result: null,
      error: "boom",
      execution_time_ms: 1,
    });
    expect(toolCodeEvents(spy.mock.calls)).toEqual([
      {
        event: "tool:code",
        competition: null,
        outcome: "error",
        errorClass: "Error",
      },
    ]);
  });
});
