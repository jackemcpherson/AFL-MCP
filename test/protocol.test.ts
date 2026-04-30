import { describe, expect, it, vi } from "vitest";

// Mock the cloudflare:workers module that executor.ts imports
vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {},
}));

import { handleMcpRequest } from "../src/mcp/protocol";

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
  result?: {
    serverInfo?: { name: string };
    capabilities?: { tools?: unknown };
    tools?: { name: string }[];
    content?: { type: string; text: string }[];
    isError?: boolean;
  };
  error?: { code: number; message: string };
}

async function parseJson(res: Response): Promise<JsonRpcTestResponse> {
  return (await res.json()) as JsonRpcTestResponse;
}

// Minimal env stub — tools that don't touch DB don't need it
const stubEnv = {} as unknown as import("../src/types").Env;
const stubCtx = { waitUntil: () => {} } as unknown as ExecutionContext;

describe("handleMcpRequest", () => {
  it("returns CORS headers on OPTIONS preflight", async () => {
    const req = new Request("https://afl.test/mcp", { method: "OPTIONS" });
    const res = await handleMcpRequest(req, stubEnv, stubCtx);

    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
  });

  it("rejects non-POST methods with 405", async () => {
    const req = new Request("https://afl.test/mcp", { method: "GET" });
    const res = await handleMcpRequest(req, stubEnv, stubCtx);

    expect(res.status).toBe(405);
  });

  it("rejects non-JSON content type with 415", async () => {
    const req = new Request("https://afl.test/mcp", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "not json",
    });
    const res = await handleMcpRequest(req, stubEnv, stubCtx);

    expect(res.status).toBe(415);
  });

  it("returns parse error for malformed JSON", async () => {
    const req = new Request("https://afl.test/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{invalid",
    });
    const res = await handleMcpRequest(req, stubEnv, stubCtx);

    expect(res.status).toBe(400);
    const json = await parseJson(res);
    expect(json.error?.code).toBe(-32700);
  });

  it("returns error for invalid JSON-RPC request", async () => {
    const res = await handleMcpRequest(makeRequest({ notJsonRpc: true }), stubEnv, stubCtx);

    expect(res.status).toBe(400);
    const json = await parseJson(res);
    expect(json.error?.code).toBe(-32600);
  });

  it("handles initialize and returns server info", async () => {
    const res = await handleMcpRequest(
      makeRequest({ jsonrpc: "2.0", id: 1, method: "initialize" }),
      stubEnv,
      stubCtx,
    );

    expect(res.status).toBe(200);
    const json = await parseJson(res);
    expect(json.jsonrpc).toBe("2.0");
    expect(json.id).toBe(1);
    expect(json.result?.serverInfo?.name).toBe("afl-mcp-v2");
    expect(json.result?.capabilities?.tools).toBeDefined();
  });

  it("handles tools/list and returns all three tools", async () => {
    const res = await handleMcpRequest(
      makeRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      stubEnv,
      stubCtx,
    );

    const json = await parseJson(res);
    const toolNames = json.result?.tools?.map((t) => t.name);
    expect(toolNames).toEqual(["schema", "tools", "code"]);
  });

  it("handles ping", async () => {
    const res = await handleMcpRequest(
      makeRequest({ jsonrpc: "2.0", id: 3, method: "ping" }),
      stubEnv,
      stubCtx,
    );

    const json = await parseJson(res);
    expect(json.id).toBe(3);
    expect(json.error).toBeUndefined();
  });

  it("returns method-not-found for unknown methods", async () => {
    const res = await handleMcpRequest(
      makeRequest({ jsonrpc: "2.0", id: 4, method: "unknown/method" }),
      stubEnv,
      stubCtx,
    );

    const json = await parseJson(res);
    expect(json.error?.code).toBe(-32601);
  });

  it("returns schema tool content", async () => {
    const res = await handleMcpRequest(
      makeRequest({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "schema", arguments: {} },
      }),
      stubEnv,
      stubCtx,
    );

    const json = await parseJson(res);
    expect(json.result?.content).toHaveLength(1);
    expect(json.result?.content?.[0]?.type).toBe("text");
    const schema = JSON.parse(json.result?.content?.[0]?.text ?? "");
    expect(schema.database.tables).toHaveProperty("matches");
    expect(schema.database.tables).toHaveProperty("player_match_stats");
  });

  it("returns tools info content", async () => {
    const res = await handleMcpRequest(
      makeRequest({
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { name: "tools", arguments: {} },
      }),
      stubEnv,
      stubCtx,
    );

    const json = await parseJson(res);
    const tools = JSON.parse(json.result?.content?.[0]?.text ?? "");
    expect(tools.environment.db.type).toBe("D1Database");
    expect(tools.constraints).toBeInstanceOf(Array);
  });

  it("returns error for missing tool name", async () => {
    const res = await handleMcpRequest(
      makeRequest({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { arguments: {} },
      }),
      stubEnv,
      stubCtx,
    );

    const json = await parseJson(res);
    expect(json.error?.code).toBe(-32602);
  });

  it("returns error for unknown tool", async () => {
    const res = await handleMcpRequest(
      makeRequest({
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: { name: "nonexistent", arguments: {} },
      }),
      stubEnv,
      stubCtx,
    );

    const json = await parseJson(res);
    expect(json.result?.isError).toBe(true);
    expect(json.result?.content?.[0]?.text).toContain("Unknown tool");
  });

  it("returns error when code tool receives empty string", async () => {
    const res = await handleMcpRequest(
      makeRequest({
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: { name: "code", arguments: { code: "  " } },
      }),
      stubEnv,
      stubCtx,
    );

    const json = await parseJson(res);
    expect(json.result?.isError).toBe(true);
    expect(json.result?.content?.[0]?.text).toContain("code parameter is required");
  });

  it("includes CORS header on all JSON responses", async () => {
    const res = await handleMcpRequest(
      makeRequest({ jsonrpc: "2.0", id: 10, method: "ping" }),
      stubEnv,
      stubCtx,
    );

    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});
