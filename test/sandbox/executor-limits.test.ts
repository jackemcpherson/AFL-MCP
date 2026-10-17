import { describe, expect, it } from "vitest";
import { testCtx, testEnv, testLoader } from "#test/fixtures";
import { executeCode, sanitizeErrorMessage } from "../../src/sandbox/executor";
import type { Env } from "../../src/types";

const stubCtx = testCtx({ DbProxy: () => ({}) });

function envWithLoaderFetch(fetchImpl: () => Promise<Response>): Env {
  return testEnv({ LOADER: testLoader(fetchImpl) });
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
    expect(result.result).toBeTypeOf("string");
    expect(String(result.result)).toMatch(/truncated/);
    expect(String(result.result).length).toBeLessThan(1_100_000);
  });

  it("returns parsed JSON results under the cap untouched", async () => {
    const env = envWithLoaderFetch(async () => new Response(JSON.stringify({ rows: [1, 2, 3] })));
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
    const env = envWithLoaderFetch(async () => new Response(""));
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

  it("leaves a successful run without an error class", async () => {
    const env = envWithLoaderFetch(async () => new Response("1"));
    const result = await executeCode("return 1", env, stubCtx);
    expect(result).not.toHaveProperty("errorClass");
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
