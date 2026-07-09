import { describe, expect, it, vi } from "vitest";
import pkg from "../package.json";

// Mock the cloudflare:workers module that executor.ts imports
vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {},
}));

// Mock the executor so code-tool tests don't need a live sandbox
vi.mock("../src/sandbox/executor", () => ({
  executeCode: vi.fn().mockResolvedValue({ result: "ok", execution_time_ms: 5 }),
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
    serverInfo?: { name: string; version?: string };
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
  it("answers OPTIONS preflight without CORS allow headers (SEC-03)", async () => {
    const req = new Request("https://afl.test/mcp", { method: "OPTIONS" });
    const res = await handleMcpRequest(req, stubEnv, stubCtx);

    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
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
    expect(json.result?.serverInfo?.name).toBe("afl-mcp");
    expect(json.result?.serverInfo?.version).toBe(pkg.version);
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

  it("acknowledges notifications with 202 and no body", async () => {
    const res = await handleMcpRequest(
      makeRequest({ jsonrpc: "2.0", method: "notifications/initialized" }),
      stubEnv,
      stubCtx,
    );
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
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

  it("rejects code execution when the kill switch is set", async () => {
    const disabledEnv = { CODE_TOOL_DISABLED: "true" } as unknown as import("../src/types").Env;
    const res = await handleMcpRequest(
      makeRequest({
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: { name: "code", arguments: { code: "return 1;" } },
      }),
      disabledEnv,
      stubCtx,
    );

    const json = await parseJson(res);
    expect(json.result?.isError).toBe(true);
    expect(json.result?.content?.[0]?.text).toContain("temporarily disabled");
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

  it("does not emit CORS allow headers on JSON responses (SEC-03)", async () => {
    const res = await handleMcpRequest(
      makeRequest({ jsonrpc: "2.0", id: 10, method: "ping" }),
      stubEnv,
      stubCtx,
    );

    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  describe("code tool competition telemetry", () => {
    it("logs { event: 'tool:code', competition: 'AFLW' } when a valid competition hint is supplied", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        const res = await handleMcpRequest(
          makeRequest({
            jsonrpc: "2.0",
            id: 20,
            method: "tools/call",
            params: { name: "code", arguments: { code: "return 1", competition: "AFLW" } },
          }),
          stubEnv,
          stubCtx,
        );
        const json = await parseJson(res);
        expect(json.result?.isError).toBeFalsy();
        const telemetryCall = logSpy.mock.calls.find(
          (c) => typeof c[0] === "string" && (c[0] as string).includes("tool:code"),
        );
        expect(telemetryCall).toBeDefined();
        expect(JSON.parse(telemetryCall?.[0] as string)).toEqual({
          event: "tool:code",
          competition: "AFLW",
        });
      } finally {
        logSpy.mockRestore();
      }
    });

    it("logs competition: null when the competition hint is omitted", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        const res = await handleMcpRequest(
          makeRequest({
            jsonrpc: "2.0",
            id: 21,
            method: "tools/call",
            params: { name: "code", arguments: { code: "return 1" } },
          }),
          stubEnv,
          stubCtx,
        );
        const json = await parseJson(res);
        expect(json.result?.isError).toBeFalsy();
        const telemetryCall = logSpy.mock.calls.find(
          (c) => typeof c[0] === "string" && (c[0] as string).includes("tool:code"),
        );
        expect(telemetryCall).toBeDefined();
        expect(JSON.parse(telemetryCall?.[0] as string)).toEqual({
          event: "tool:code",
          competition: null,
        });
      } finally {
        logSpy.mockRestore();
      }
    });

    it("logs competition: null and does NOT return an error when competition is an unrecognised value", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        const res = await handleMcpRequest(
          makeRequest({
            jsonrpc: "2.0",
            id: 22,
            method: "tools/call",
            params: { name: "code", arguments: { code: "return 1", competition: "NRL" } },
          }),
          stubEnv,
          stubCtx,
        );
        const json = await parseJson(res);
        expect(json.result?.isError).toBeFalsy();
        const telemetryCall = logSpy.mock.calls.find(
          (c) => typeof c[0] === "string" && (c[0] as string).includes("tool:code"),
        );
        expect(telemetryCall).toBeDefined();
        expect(JSON.parse(telemetryCall?.[0] as string)).toEqual({
          event: "tool:code",
          competition: null,
        });
      } finally {
        logSpy.mockRestore();
      }
    });
  });

  it("returns 429 when the rate limiter denies the request", async () => {
    const limitedEnv = {
      MCP_RATE_LIMIT: { limit: async () => ({ success: false }) },
    } as unknown as import("../src/types").Env;
    const res = await handleMcpRequest(
      makeRequest({ jsonrpc: "2.0", id: 11, method: "ping" }),
      limitedEnv,
      stubCtx,
    );

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
  });

  it("keys the rate limiter on the connecting IP", async () => {
    const seenKeys: string[] = [];
    const limitedEnv = {
      MCP_RATE_LIMIT: {
        limit: async ({ key }: { key: string }) => {
          seenKeys.push(key);
          return { success: true };
        },
      },
    } as unknown as import("../src/types").Env;
    const req = new Request("https://afl.test/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.7" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 12, method: "ping" }),
    });
    const res = await handleMcpRequest(req, limitedEnv, stubCtx);

    expect(res.status).toBe(200);
    expect(seenKeys).toEqual(["203.0.113.7"]);
  });
});
