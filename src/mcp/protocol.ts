import { executeCode } from "../sandbox/executor";
import type { Env } from "../types";
import { getSchemaInfo } from "./tools/schema";
import { getToolsInfo } from "./tools/tools";
import type { JsonRpcResponse, ToolDefinition } from "./types";
import { type JsonRpcRequest, JsonRpcRequestSchema } from "./validation";

const SERVER_INFO = {
  name: "afl-mcp",
  version: "3.0.0",
};

const COMPETITION_CODES = ["AFLM", "AFLW", "VFL", "VFLW"] as const;

const PROTOCOL_VERSION = "2025-03-26";

// No CORS headers are sent: MCP clients are server-side, and withholding
// Access-Control-Allow-Origin stops arbitrary web pages from driving the
// code-execution endpoint with visitors' browsers (SEC-03).

const TOOLS: ToolDefinition[] = [
  {
    name: "schema",
    description:
      "Get the database schema for the multi-competition Australian football database (AFLM, AFLW, VFL, VFLW): table definitions, column details, per-competition coverage, join patterns, and query API reference. Call this first to understand what data is available before writing code.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "tools",
    description:
      "Get sandbox capabilities, constraints, and guidance for writing code that runs against the Australian football statistics database (AFLM, AFLW, VFL, VFLW).",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "code",
    description:
      "Execute TypeScript code in an isolated sandbox with read-only access to the Australian football D1 database (AFLM, AFLW, VFL, VFLW) via the `db` variable. The code must return a JSON-serialisable value. Always filter your SQL by competition (JOIN competitions c WHERE c.code = ?); the optional `competition` argument is a hint indicating which competition the query is about, but does NOT auto-inject SQL — you must still write the filter. Call schema first to understand the database structure.",
    inputSchema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description:
            "TypeScript code to execute. Has access to `db` (D1Database). Must return a value.",
        },
        competition: {
          type: "string",
          enum: [...COMPETITION_CODES],
          description:
            "Optional. Hint indicating which competition the query is about (AFLM, AFLW, VFL, VFLW). Does NOT auto-inject SQL — you are still responsible for filtering via JOIN competitions c WHERE c.code = ?.",
        },
      },
      required: ["code"],
      additionalProperties: false,
    },
  },
];

function jsonRpcResponse(id: string | number, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(
  id: string | number,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, data } };
}

function mcpContent(data: unknown) {
  return {
    content: [
      {
        type: "text",
        text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
      },
    ],
  };
}

function mcpError(message: string) {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
  env: Env,
  ctx: ExecutionContext,
) {
  switch (name) {
    case "schema":
      return mcpContent(getSchemaInfo());

    case "tools":
      return mcpContent(getToolsInfo());

    case "code": {
      const code = args.code;
      if (typeof code !== "string" || code.trim() === "") {
        return mcpError("code parameter is required and must be a non-empty string");
      }
      const result = await executeCode(code, env, ctx);
      if (result.error) {
        return mcpError(`Execution error (${result.execution_time_ms}ms): ${result.error}`);
      }
      return mcpContent(result.result);
    }

    default:
      return mcpError(`Unknown tool: ${name}`);
  }
}

async function handleJsonRpc(
  request: JsonRpcRequest,
  env: Env,
  ctx: ExecutionContext,
): Promise<JsonRpcResponse> {
  const { id, method, params } = request;

  switch (method) {
    case "initialize":
      return jsonRpcResponse(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });

    case "notifications/initialized":
      return jsonRpcResponse(id, {});

    case "tools/list":
      return jsonRpcResponse(id, { tools: TOOLS });

    case "tools/call": {
      const name = params?.name as string;
      const args = (params?.arguments ?? {}) as Record<string, unknown>;
      if (!name) {
        return jsonRpcError(id, -32602, "Missing tool name");
      }
      const result = await handleToolCall(name, args, env, ctx);
      return jsonRpcResponse(id, result);
    }

    case "ping":
      return jsonRpcResponse(id, {});

    default:
      return jsonRpcError(id, -32601, `Method not found: ${method}`);
  }
}

export async function handleMcpRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }

  if (request.method !== "POST") {
    return Response.json(jsonRpcError(0, -32600, "Only POST requests are accepted"), {
      status: 405,
    });
  }

  if (env.MCP_RATE_LIMIT) {
    const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
    const { success } = await env.MCP_RATE_LIMIT.limit({ key: ip });
    if (!success) {
      return Response.json(jsonRpcError(0, -32000, "Rate limit exceeded — retry later"), {
        status: 429,
        headers: { "Retry-After": "60" },
      });
    }
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return Response.json(jsonRpcError(0, -32700, "Content-Type must be application/json"), {
      status: 415,
    });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(jsonRpcError(0, -32700, "Parse error: invalid JSON"), { status: 400 });
  }

  const rpcRequest = JsonRpcRequestSchema.safeParse(body);
  if (!rpcRequest.success) {
    const fallbackId =
      typeof body === "object" && body !== null && "id" in body
        ? (body as { id?: string | number }).id
        : undefined;
    return Response.json(jsonRpcError(fallbackId ?? 0, -32600, "Invalid JSON-RPC 2.0 request"), {
      status: 400,
    });
  }

  const response = await handleJsonRpc(rpcRequest.data, env, ctx);

  return Response.json(response, {
    headers: { "Content-Type": "application/json" },
  });
}
