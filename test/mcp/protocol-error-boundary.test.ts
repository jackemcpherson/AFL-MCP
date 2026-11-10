import { describe, expect, it } from "vitest";
import { testCtx, testEnv } from "#test/fixtures";
import { SeasonSelectionError } from "../../src/db/seasons";
import { CoverageObservationError } from "../../src/mcp/errors";
import { defaultDeps, handleMcpRequest, type McpDeps } from "../../src/mcp/protocol";
import { SCHEMA_TOOL_CONTRACT } from "../../src/mcp/validation";

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

describe("schema tool expected failures", () => {
  function depsThrowing(error: unknown): McpDeps {
    return {
      ...defaultDeps,
      getSchemaInfo: () => {
        throw error;
      },
    };
  }

  async function callSchema(deps: McpDeps): Promise<JsonRpcTestResponse> {
    const res = await handleMcpRequest(
      makeRequest({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "schema", arguments: {} },
      }),
      stubEnv,
      stubCtx,
      deps,
    );
    expect(res.status).toBe(200);
    return parseJson(res);
  }

  it("returns a missing season as an isError tool result with the usage hint", async () => {
    const json = await callSchema(
      depsThrowing(
        new SeasonSelectionError({
          message: "No AFLM season 1800 exists",
          code: "SEASON_NOT_FOUND",
          validSelectors: [],
        }),
      ),
    );
    expect(json.error).toBeUndefined();
    expect(json.result).toEqual({
      content: [{ type: "text", text: `No AFLM season 1800 exists. ${SCHEMA_TOOL_CONTRACT}` }],
      isError: true,
    });
  });

  it("returns a blocked observation as a retryable isError tool result", async () => {
    const json = await callSchema(
      depsThrowing(new CoverageObservationError({ message: "Retry shortly" })),
    );
    expect(json.error).toBeUndefined();
    expect(json.result).toEqual({
      content: [{ type: "text", text: "Retry shortly" }],
      isError: true,
    });
  });
});
