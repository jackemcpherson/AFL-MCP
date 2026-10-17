/**
 * Boundary failures are logged as structured events that never carry the
 * raw error message, which may hold upstream payloads or credentials.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { testCtx, testEnv } from "#test/fixtures";
import { defaultDeps, handleMcpRequest } from "../src/mcp/protocol";

const SECRET = "upstream-secret-token";

function schemaCall(): Request {
  return new Request("https://afl.test/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "schema", arguments: {} },
    }),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MCP handler failure logging", () => {
  it("logs a structured event without the raw error message", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const deps = {
      ...defaultDeps,
      getSchemaInfo: async () => {
        throw new Error(SECRET);
      },
    };

    const response = await handleMcpRequest(schemaCall(), testEnv(), testCtx(), deps);

    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      id: 7,
      error: { code: -32603, message: "Internal error" },
    });
    expect(errorSpy).toHaveBeenCalledOnce();
    const logged = JSON.stringify(errorSpy.mock.calls);
    expect(logged).not.toContain(SECRET);
    expect(errorSpy.mock.calls[0]?.[0]).toBeTypeOf("string");
    expect(JSON.parse(String(errorSpy.mock.calls[0]?.[0]))).toMatchObject({
      event: "mcp_handler_error",
      errorType: "Error",
    });
  });
});
