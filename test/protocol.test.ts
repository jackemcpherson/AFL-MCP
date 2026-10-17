import { Predicate } from "effect";
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

import { scriptedD1, testCtx, testEnv } from "#test/fixtures";
import { defaultDeps, handleMcpRequest } from "../src/mcp/protocol";
import type { Env } from "../src/types";

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
  return await res.json<JsonRpcTestResponse>();
}

// Minimal env stub — tools that don't touch DB don't need it
const stubEnv = testEnv();
const stubCtx = testCtx();

function observedSchemaEnv(): Env {
  const rows = [
    { id: 77, year: 2025, season_key: "2025", code: "AFLW" },
    { row_count: 2, n0: 2 },
    { row_count: 4 },
    { row_count: 5, match_count: 2 },
    { row_count: 3 },
    null,
    { failures: 0, unresolved: 0, overdue: 0 },
    { revision: 0, in_progress: 0 },
    { revision: 0, in_progress: 0 },
  ];
  return testEnv({ DB: scriptedD1(rows).db });
}

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

  it("rejects a media type that only mentions application/json with 415", async () => {
    const req = new Request("https://afl.test/mcp", {
      method: "POST",
      headers: { "Content-Type": "text/plain;x=application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    const res = await handleMcpRequest(req, stubEnv, stubCtx);

    expect(res.status).toBe(415);
  });

  it("accepts application/json with parameters", async () => {
    const req = new Request("https://afl.test/mcp", {
      method: "POST",
      headers: { "Content-Type": "Application/JSON; charset=utf-8" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    const res = await handleMcpRequest(req, stubEnv, stubCtx);

    expect(res.status).toBe(200);
  });

  it("logs client origin and protocol versions", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const req = new Request("https://afl.test/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://client.test",
        "MCP-Protocol-Version": "2025-03-26",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      }),
    });
    await handleMcpRequest(req, stubEnv, stubCtx);

    expect(log).toHaveBeenCalledWith(
      JSON.stringify({
        event: "mcp:client",
        method: "initialize",
        origin: "https://client.test",
        protocolVersionHeader: "2025-03-26",
        initializeProtocolVersion: "2025-06-18",
      }),
    );
    log.mockRestore();
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
    expect(toolNames).toEqual(["schema", "code"]);
    // SAFETY: tools/list returns the TOOLS definitions, which all carry an inputSchema.
    const schemaTool = json.result?.tools?.find((tool) => tool.name === "schema") as
      | { inputSchema?: { properties?: Record<string, unknown> } }
      | undefined;
    expect(schemaTool?.inputSchema?.properties).toHaveProperty("includeObserved");
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
    expect(schema.database.coverage_contract.version).toBe(4);
  });

  it("rejects invalid observed schema arguments before querying D1", async () => {
    const res = await handleMcpRequest(
      makeRequest({
        jsonrpc: "2.0",
        id: 51,
        method: "tools/call",
        params: {
          name: "schema",
          arguments: { includeObserved: true, competition: "AFLM" },
        },
      }),
      stubEnv,
      stubCtx,
    );
    const json = await parseJson(res);
    expect(json.result?.isError).toBe(true);
    expect(json.result?.content?.[0]?.text).toBe(
      "Valid calls: no params (full schema); competition alone (competition-filtered schema); competition + season + includeObserved:true (measured coverage).",
    );
  });

  it("returns a competition-filtered base schema for competition alone", async () => {
    const res = await handleMcpRequest(
      makeRequest({
        jsonrpc: "2.0",
        id: 53,
        method: "tools/call",
        params: { name: "schema", arguments: { competition: "AFLM" } },
      }),
      stubEnv,
      stubCtx,
    );
    const json = await parseJson(res);
    expect(json.result?.isError).toBeFalsy();
    const schema = JSON.parse(json.result?.content?.[0]?.text ?? "");
    expect(Object.keys(schema.database.coverage_contract.by_competition)).toEqual(["AFLM"]);
    expect(Object.keys(schema.database.competitions)).toEqual(["AFLM"]);
    expect(schema.database.tables).toHaveProperty("matches");
    expect(schema.database.notes.length).toBeGreaterThan(0);
  });

  it("returns a bounded observed season overlay through the schema tool", async () => {
    const res = await handleMcpRequest(
      makeRequest({
        jsonrpc: "2.0",
        id: 52,
        method: "tools/call",
        params: {
          name: "schema",
          arguments: { includeObserved: true, competition: "AFLW", season: 2025 },
        },
      }),
      observedSchemaEnv(),
      stubCtx,
    );
    const json = await parseJson(res);
    expect(json.result?.isError).toBeFalsy();
    const schema = JSON.parse(json.result?.content?.[0]?.text ?? "");
    const observed = schema.database.coverage_contract.observed;
    expect(observed).toMatchObject({ competition: "AFLW", season: 2025 });
    expect(observed.player_match_stats.guernsey_number).toMatchObject({
      unit: "rows",
      rows: 2,
      non_null: 2,
      ratio: 1,
    });
  });

  it("rejects the removed tools tool as unknown", async () => {
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
    expect(json.error?.message ?? json.result?.content?.[0]?.text).toMatch(/unknown tool/i);
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

  it("returns -32602 for an unknown tool", async () => {
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
    expect(json.error?.code).toBe(-32602);
    expect(json.error?.message).toBe("Unknown tool: nonexistent");
  });

  it("rejects code execution when the kill switch is set", async () => {
    const disabledEnv = testEnv({ CODE_TOOL_DISABLED: "true" });
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
            params: {
              name: "code",
              arguments: { code: "return 1", competition: "AFLW" },
            },
          }),
          stubEnv,
          stubCtx,
        );
        const json = await parseJson(res);
        expect(json.result?.isError).toBeFalsy();
        const telemetryCall = logSpy.mock.calls.find(
          (c) => Predicate.isString(c[0]) && c[0].includes("tool:code"),
        );
        expect(telemetryCall).toBeDefined();
        expect(JSON.parse(String(telemetryCall?.[0]))).toEqual({
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
          (c) => Predicate.isString(c[0]) && c[0].includes("tool:code"),
        );
        expect(telemetryCall).toBeDefined();
        expect(JSON.parse(String(telemetryCall?.[0]))).toEqual({
          event: "tool:code",
          competition: null,
        });
      } finally {
        logSpy.mockRestore();
      }
    });

    it("treats competition: null like an omitted hint", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const executeCode = vi.fn(async () => ({ result: 1, execution_time_ms: 1 }));
      try {
        const res = await handleMcpRequest(
          makeRequest({
            jsonrpc: "2.0",
            id: 23,
            method: "tools/call",
            params: {
              name: "code",
              arguments: { code: "return 1", competition: null },
            },
          }),
          stubEnv,
          stubCtx,
          { ...defaultDeps, executeCode },
        );
        const json = await parseJson(res);
        expect(json.result?.isError).toBeFalsy();
        expect(executeCode).toHaveBeenCalledOnce();
        const telemetryCall = logSpy.mock.calls.find(
          (c) => Predicate.isString(c[0]) && c[0].includes("tool:code"),
        );
        expect(JSON.parse(String(telemetryCall?.[0]))).toEqual({
          event: "tool:code",
          competition: null,
        });
      } finally {
        logSpy.mockRestore();
      }
    });

    it("rejects an unrecognised competition with the valid codes and runs nothing", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const executeCode = vi.fn(async () => ({ result: 1, execution_time_ms: 1 }));
      try {
        const res = await handleMcpRequest(
          makeRequest({
            jsonrpc: "2.0",
            id: 22,
            method: "tools/call",
            params: {
              name: "code",
              arguments: { code: "return 1", competition: "NRL" },
            },
          }),
          stubEnv,
          stubCtx,
          { ...defaultDeps, executeCode },
        );
        const json = await parseJson(res);
        expect(json.result?.isError).toBe(true);
        expect(json.result?.content?.[0]?.text).toBe(
          "competition must be one of AFLM, AFLW, VFL, VFLW",
        );
        expect(executeCode).not.toHaveBeenCalled();
        const telemetryCall = logSpy.mock.calls.find(
          (c) => Predicate.isString(c[0]) && c[0].includes("tool:code"),
        );
        expect(telemetryCall).toBeUndefined();
      } finally {
        logSpy.mockRestore();
      }
    });
  });

  it("returns 429 when the rate limiter denies the request", async () => {
    const limitedEnv = testEnv({
      MCP_RATE_LIMIT: { limit: async () => ({ success: false }) },
    });
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
    const limitedEnv = testEnv({
      MCP_RATE_LIMIT: {
        limit: async ({ key }: { key: string }) => {
          seenKeys.push(key);
          return { success: true };
        },
      },
    });
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
