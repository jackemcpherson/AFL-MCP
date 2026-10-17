import { describe, expect, it } from "vitest";
import { testCtx, testEnv } from "#test/fixtures";
import { defaultDeps, handleMcpRequest, type McpDeps } from "../../src/mcp/protocol";

// A schema tool that throws exercises the top-level error boundary.
const throwingDeps: McpDeps = {
  ...defaultDeps,
  getSchemaInfo: () => {
    throw new Error("boom");
  },
};

function makeRequest(body: unknown, method = "POST"): Request {
  return new Request("https://afl.test/mcp", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Loosely-typed JSON-RPC response shape for test assertions. */
interface JsonRpcTestResponse {
  jsonrpc?: string;
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
}

async function parseJson(res: Response): Promise<JsonRpcTestResponse> {
  return await res.json<JsonRpcTestResponse>();
}

// Minimal env stub — tools that don't touch DB don't need it
const stubEnv = testEnv();
const stubCtx = testCtx();

describe("handleMcpRequest error boundary", () => {
  it("returns a -32603 JSON-RPC error at HTTP 200 when a handler throws", async () => {
    const res = await handleMcpRequest(
      makeRequest({
        jsonrpc: "2.0",
        id: 99,
        method: "tools/call",
        params: { name: "schema", arguments: {} },
      }),
      stubEnv,
      stubCtx,
      throwingDeps,
    );

    expect(res.status).toBe(200);
    const json = await parseJson(res);
    expect(json.jsonrpc).toBe("2.0");
    expect(json.id).toBe(99);
    expect(json.error?.code).toBe(-32603);
    // Internal detail must never leak to the client.
    expect(JSON.stringify(json)).not.toContain("boom");
  });
});
