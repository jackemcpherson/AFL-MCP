import { describe, expect, it } from "vitest";
import { testCtx, testEnv, testLoader } from "#test/fixtures";
import { executeCode, sanitizeErrorMessage } from "../../src/sandbox/executor";
import { serializedLength } from "../../src/sandbox/truncate";
import type { Env } from "../../src/types";

const stubCtx = testCtx({ DbProxy: () => ({}) });

function envWithLoaderFetch(fetchImpl: () => Promise<Response>): Env {
  return testEnv({ LOADER: testLoader(fetchImpl) });
}

/** A sandbox that answers with the given reply envelope. */
function envWithReply(reply: Record<string, unknown>): Env {
  return envWithLoaderFetch(async () => new Response(JSON.stringify(reply)));
}

describe("executeCode limits", () => {
  it("times out when the sandbox never responds", async () => {
    const env = envWithLoaderFetch(() => new Promise<Response>(() => {}));
    const result = await executeCode("return 1", env, stubCtx, 50);
    expect(result.error).toMatch(/timed out/i);
    expect(result.result).toBeNull();
  });

  it("shortens a result over 100,000 characters structurally", async () => {
    const results = Array.from({ length: 5_000 }, (_, id) => ({ id, team: `Team ${id}` }));
    const env = envWithReply({ hasValue: true, value: { results, success: true }, logs: [] });
    const result = await executeCode("return big", env, stubCtx);
    expect(result.error).toBeUndefined();
    expect(serializedLength(result.result)).toBeLessThanOrEqual(100_000);
    expect(result.result).toMatchObject({ success: true });
    // SAFETY: toMatchObject above proved an object result; truncation keeps its keys.
    const kept = (result.result as { results: unknown[] }).results;
    expect(kept.at(-1)).toMatch(/^--- TRUNCATED: showing \d+ of 5000 items\./);
  });

  it("returns a result under the cap untouched", async () => {
    const env = envWithReply({ hasValue: true, value: { rows: [1, 2, 3] }, logs: [] });
    const result = await executeCode("return rows", env, stubCtx);
    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({ rows: [1, 2, 3] });
  });
});

describe("executeCode outcomes", () => {
  function envWithLoaderFailure(cause: unknown): Env {
    return envWithLoaderFetch(async () => {
      throw cause;
    });
  }

  it("explains a run that returned no value", async () => {
    const env = envWithReply({ hasValue: false, logs: [] });
    const result = await executeCode("db.prepare('SELECT 1').all()", env, stubCtx);
    expect(result.result).toBeNull();
    expect(result.error).toBe(
      "The code returned no value. End it with `return` and a JSON-serialisable value, such as `return rows.results`.",
    );
    expect(result.errorClass).toBe("NoReturnValueError");
  });

  it("names the timeout error class", async () => {
    const env = envWithLoaderFetch(() => new Promise<Response>(() => {}));
    const result = await executeCode("return 1", env, stubCtx, 50);
    expect(result.errorClass).toBe("SandboxTimeoutError");
  });

  it("reports a syntax error the loader wraps in a start-up failure", async () => {
    const env = envWithLoaderFailure(
      new Error(
        "Failed to start Worker:\nUncaught SyntaxError: Unexpected token ':'\n  at agent.js:14:60",
      ),
    );
    const result = await executeCode("const f = (x: number) => x", env, stubCtx);
    expect(result.error).toBe("SyntaxError: Unexpected token ':'");
    expect(result.errorClass).toBe("SyntaxError");
  });

  it("classifies a bare SyntaxError", async () => {
    const env = envWithLoaderFailure(new SyntaxError("Unexpected token ':'"));
    const result = await executeCode("const f = (x: number) => x", env, stubCtx);
    expect(result.error).toBe("Unexpected token ':'");
    expect(result.errorClass).toBe("SyntaxError");
  });

  it("classifies a parser message that arrives on a plain Error", async () => {
    const env = envWithLoaderFailure(new Error("Unexpected strict mode reserved word"));
    const result = await executeCode("interface Row { id: number }", env, stubCtx);
    expect(result.errorClass).toBe("SyntaxError");
  });

  it("takes the class from a message the RPC boundary prefixed", async () => {
    const message =
      "ReadOnlySqlError: Read-only access: statements must begin with SELECT, WITH, or EXPLAIN.";
    const env = envWithLoaderFailure(new Error(message));
    const result = await executeCode("return 1", env, stubCtx);
    expect(result.error).toBe(message);
    expect(result.errorClass).toBe("ReadOnlySqlError");
  });

  it("falls back to the error name", async () => {
    const typeError = await executeCode(
      "return 1",
      envWithLoaderFailure(new TypeError("x is not a function")),
      stubCtx,
    );
    expect(typeError.errorClass).toBe("TypeError");
    const d1Error = await executeCode(
      "return 1",
      envWithLoaderFailure(new Error("D1_ERROR: no such table: nope: SQLITE_ERROR")),
      stubCtx,
    );
    expect(d1Error.errorClass).toBe("Error");
  });

  it("reports an error the code threw, with its class", async () => {
    const env = envWithReply({
      error: { name: "TypeError", message: "x is not a function" },
      logs: [],
    });
    const result = await executeCode("return x()", env, stubCtx);
    expect(result.error).toBe("x is not a function");
    expect(result.errorClass).toBe("TypeError");
  });

  it("reports a reply it cannot read", async () => {
    const env = envWithLoaderFetch(async () => new Response("1"));
    const result = await executeCode("return 1", env, stubCtx);
    expect(result.error).toBe("The sandbox returned an unreadable reply.");
    expect(result.errorClass).toBe("SandboxReplyError");
  });

  it("leaves a successful run without an error class", async () => {
    const env = envWithReply({ hasValue: true, value: 1, logs: [] });
    const result = await executeCode("return 1", env, stubCtx);
    expect(result).not.toHaveProperty("errorClass");
  });
});

describe("executeCode console output", () => {
  it("returns console lines with a result", async () => {
    const env = envWithReply({ hasValue: true, value: 1, logs: ["first", "[warn] second"] });
    const result = await executeCode("return 1", env, stubCtx);
    expect(result.logs).toEqual(["first", "[warn] second"]);
  });

  it("returns console lines with an error", async () => {
    const env = envWithReply({ error: { name: "Error", message: "boom" }, logs: ["before"] });
    const result = await executeCode("throw new Error('boom')", env, stubCtx);
    expect(result.error).toBe("boom");
    expect(result.logs).toEqual(["before"]);
  });

  it("omits logs when the code wrote none", async () => {
    const env = envWithReply({ hasValue: true, value: 1, logs: [] });
    const result = await executeCode("return 1", env, stubCtx);
    expect(result).not.toHaveProperty("logs");
  });

  it("keeps at most 100 lines and counts the rest", async () => {
    const logs = Array.from({ length: 150 }, (_, i) => `line ${i}`);
    const env = envWithReply({ hasValue: true, value: 1, logs, droppedLogs: 7 });
    const result = await executeCode("return 1", env, stubCtx);
    expect(result.logs).toHaveLength(101);
    expect(result.logs?.[99]).toBe("line 99");
    expect(result.logs?.at(-1)).toBe("… [57 more console lines not shown]");
  });

  it("keeps at most 10,000 characters and cuts the line that crosses the limit", async () => {
    const logs = ["a".repeat(6_000), "b".repeat(6_000), "c"];
    const env = envWithReply({ hasValue: true, value: 1, logs });
    const result = await executeCode("return 1", env, stubCtx);
    expect(result.logs?.[0]).toBe("a".repeat(6_000));
    expect(result.logs?.[1]).toBe(`${"b".repeat(4_000)}…`);
    expect(result.logs?.[2]).toBe("… [1 more console line not shown]");
  });

  it("returns console lines when the sandbox reports a timeout", async () => {
    const env = envWithReply({ timedOut: true, logs: ["waiting"] });
    const result = await executeCode("return 1", env, stubCtx, 2_000);
    expect(result.result).toBeNull();
    expect(result.error).toBe("Execution timed out after 2s");
    expect(result.errorClass).toBe("SandboxTimeoutError");
    expect(result.logs).toEqual(["waiting"]);
  });

  it("drops log entries that are not strings", async () => {
    const env = envWithReply({ hasValue: true, value: 1, logs: ["ok", 5, null] });
    const result = await executeCode("return 1", env, stubCtx);
    expect(result.logs).toEqual(["ok"]);
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
