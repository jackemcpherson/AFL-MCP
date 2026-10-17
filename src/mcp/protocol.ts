import { Predicate, Result } from "effect";
import pkg from "../../package.json";
import { COMPETITION_CODES } from "../lib/competitions";
import { describeIssue, firstIssue } from "../lib/decode";
import { logError } from "../lib/errors";
import { type ExecuteResult, executeCode } from "../sandbox/executor";
import type { Env } from "../types";
import { McpRequestError } from "./errors";
import { getSchemaInfo } from "./tools/schema";
import type { JsonRpcResponse, ToolDefinition } from "./types";
import {
  decodeCodeToolRequest,
  decodeJsonRpcId,
  decodeJsonRpcRequest,
  decodeSchemaToolRequest,
  decodeToolCallParams,
  type JsonRpcRequest,
  type SchemaToolRequest,
} from "./validation";

/**
 * Collaborators the MCP handler calls out to, injectable for tests.
 *
 * Production passes nothing and gets {@link defaultDeps}. Tests pass fakes
 * here instead of mocking modules, so a test can drive every tool result and
 * failure path through the public {@link handleMcpRequest} interface.
 */
export interface McpDeps {
  /** Run `code` tool source in a sandbox isolate. */
  readonly executeCode: (code: string, env: Env, ctx: ExecutionContext) => Promise<ExecuteResult>;
  /** Build the `schema` tool response from validated arguments. */
  readonly getSchemaInfo: (options: SchemaToolRequest, env: Env) => Promise<unknown>;
}

/** Real collaborators used by the Worker. */
export const defaultDeps: McpDeps = { executeCode, getSchemaInfo };

const SERVER_INFO = {
  name: "afl-mcp",
  version: pkg.version,
};

/**
 * Legacy-era (initialize handshake) protocol revisions this server speaks,
 * newest first. The first entry answers any request for another revision.
 */
const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = ["2025-11-25", "2025-06-18", "2025-03-26"];

const LATEST_PROTOCOL_VERSION = "2025-11-25";

/**
 * Pick the revision to answer an `initialize` with: the requested one when
 * supported, else the newest this server speaks.
 * @param requested - `params.protocolVersion` from the client, unvalidated.
 * @returns The negotiated protocol revision.
 */
function negotiateProtocolVersion(requested: unknown): string {
  return Predicate.isString(requested) && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
    ? requested
    : LATEST_PROTOCOL_VERSION;
}

// No CORS headers are sent: MCP clients are server-side, and withholding
// Access-Control-Allow-Origin stops arbitrary web pages from driving the
// code-execution endpoint with visitors' browsers (SEC-03).

const TOOLS: ToolDefinition[] = [
  {
    name: "schema",
    description:
      "Get the database schema for the multi-competition Australian football database (AFLM, AFLW, VFL, VFLW): table definitions, column details, per-competition coverage, join patterns, and query API reference. Call this first to understand what data is available before writing code. Valid calls: no params (full schema); competition alone (schema filtered to that competition); competition + season + includeObserved:true (measured coverage for that competition-season). Any other combination is an error.",
    inputSchema: {
      type: "object",
      properties: {
        includeObserved: {
          type: "boolean",
          default: false,
          description:
            "Overlay measured coverage for one competition-season. Requires both competition and season.",
        },
        competition: {
          type: "string",
          enum: [...COMPETITION_CODES],
          description:
            "Alone: filter the schema response to this competition. With season + includeObserved:true: the competition to measure.",
        },
        season: {
          oneOf: [{ type: "integer" }, { type: "string", pattern: "^[0-9]{4}(-S[67])?$" }],
          description:
            "Canonical season key or unambiguous year. AFLW 2022 requires 2022-S6 or 2022-S7. Requires competition and includeObserved:true.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "code",
    description:
      "Execute TypeScript code in an isolated sandbox with read-only access to the Australian football D1 database (AFLM, AFLW, VFL, VFLW) via the `db` variable. The code must return a JSON-serialisable value. Always filter your SQL by competition (JOIN competitions c WHERE c.code = ?); the optional `competition` argument is a hint indicating which competition the query is about, but does NOT auto-inject SQL — you must still write the filter. Call schema first to understand the database structure. Sandbox constraints: no network access, no npm imports (standard TypeScript/JavaScript only), 30-second timeout, write/DDL statements rejected, results over 1 MB truncated (narrow with LIMIT or aggregation), rate limited at 60 requests/minute per IP.",
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
  id: string | number | null,
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
        text: Predicate.isString(data) ? data : JSON.stringify(data, null, 2),
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
  args: unknown,
  env: Env,
  ctx: ExecutionContext,
  deps: McpDeps,
) {
  switch (name) {
    case "schema": {
      const parsed = decodeSchemaToolRequest(args);
      if (Result.isFailure(parsed)) return mcpError(describeIssue(parsed.failure));
      return mcpContent(await deps.getSchemaInfo(parsed.success, env));
    }

    case "code": {
      if (env.CODE_TOOL_DISABLED === "true") {
        return mcpError(
          "The code tool is temporarily disabled by the operator. The schema endpoint remains available.",
        );
      }
      const parsed = decodeCodeToolRequest(args);
      if (Result.isFailure(parsed)) {
        return mcpError(
          firstIssue(parsed.failure).path[0] === "competition"
            ? `competition must be one of ${COMPETITION_CODES.join(", ")}`
            : "code parameter is required and must be a non-empty string",
        );
      }
      const { code } = parsed.success;
      const competition = parsed.success.competition ?? null;
      console.log(JSON.stringify({ event: "tool:code", competition }));
      const result = await deps.executeCode(code, env, ctx);
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
  deps: McpDeps,
): Promise<JsonRpcResponse> {
  const { id, method, params } = request;

  switch (method) {
    case "initialize":
      return jsonRpcResponse(id, {
        protocolVersion: negotiateProtocolVersion(params?.["protocolVersion"]),
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });

    case "tools/list":
      return jsonRpcResponse(id, { tools: TOOLS });

    case "tools/call": {
      const call = decodeToolCallParams(params ?? {});
      if (Result.isFailure(call)) {
        throw new McpRequestError({ code: -32602, message: "Missing tool name" });
      }
      const { name } = call.success;
      const args = call.success.arguments ?? {};
      const result = await handleToolCall(name, args, env, ctx, deps);
      return jsonRpcResponse(id, result);
    }

    case "ping":
      return jsonRpcResponse(id, {});

    default:
      throw new McpRequestError({ code: -32601, message: `Method not found: ${method}` });
  }
}

/** Longest header value recorded in client logs. */
const MAX_LOGGED_HEADER_LENGTH = 200;

/**
 * Log the client's Origin and protocol version so later releases can tighten
 * request checks against observed traffic.
 * @param request - Incoming MCP POST request.
 * @param rpcRequest - Validated JSON-RPC request.
 */
function logClientHeaders(request: Request, rpcRequest: JsonRpcRequest): void {
  const header = (name: string) =>
    request.headers.get(name)?.slice(0, MAX_LOGGED_HEADER_LENGTH) ?? null;
  const requested = rpcRequest.params?.["protocolVersion"];
  const initializeProtocolVersion =
    rpcRequest.method === "initialize" && Predicate.isString(requested)
      ? requested.slice(0, MAX_LOGGED_HEADER_LENGTH)
      : null;
  console.log(
    JSON.stringify({
      event: "mcp:client",
      method: rpcRequest.method,
      origin: header("origin"),
      protocolVersionHeader: header("mcp-protocol-version"),
      initializeProtocolVersion,
    }),
  );
}

/**
 * The id a client sent, for echoing in an error reply.
 * @param body - Parsed request body.
 * @returns The string or number id, or `null` when there is none.
 */
function knownId(body: unknown): string | number | null {
  return Result.match(decodeJsonRpcId(body), {
    onSuccess: (envelope) => envelope.id,
    onFailure: () => null,
  });
}

/** Largest request body accepted, in bytes. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/**
 * Read a request body as UTF-8 text, counting the bytes actually received so
 * a chunked body without `Content-Length` cannot exceed the cap.
 * @param request - Incoming MCP POST request.
 * @returns The body text, or `null` once it passes {@link MAX_BODY_BYTES}.
 */
async function readBoundedText(request: Request): Promise<string | null> {
  if (request.body === null) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** `_meta` key that marks a request in the 2026-07-28 per-request format. */
const MODERN_PROTOCOL_VERSION_META = "io.modelcontextprotocol/protocolVersion";

/**
 * Check a request's protocol version against the revisions this server
 * speaks. `initialize` is exempt because its body negotiates the version.
 *
 * The caller answers a non-null result with HTTP 400 and plain `-32600`.
 * Never `-32020` or `-32022`: a dual-era client reads those as a 2026-07-28
 * server and would not fall back to `initialize`.
 * @param request - Incoming MCP POST request.
 * @param rpcRequest - Validated JSON-RPC request.
 * @returns The error message, or `null` when the request may proceed.
 */
function unsupportedProtocolMessage(request: Request, rpcRequest: JsonRpcRequest): string | null {
  if (rpcRequest.method === "initialize") return null;
  const meta = rpcRequest.params?.["_meta"];
  const header = request.headers.get("mcp-protocol-version");
  const modern =
    Predicate.isObject(meta) && Predicate.hasProperty(meta, MODERN_PROTOCOL_VERSION_META);
  if (!modern && (header === null || SUPPORTED_PROTOCOL_VERSIONS.includes(header))) return null;
  return `This server speaks MCP ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")} over an initialize handshake.`;
}

/**
 * Serve one MCP streamable-HTTP request.
 *
 * @param request - Incoming `/mcp` request.
 * @param env - Worker environment.
 * @param ctx - Worker execution context, passed to the sandbox executor.
 * @param deps - Collaborators. Omit in production to use {@link defaultDeps}.
 * @returns The HTTP response, a JSON-RPC body or an empty status reply.
 * @example
 * const res = await handleMcpRequest(request, env, ctx);
 */
export async function handleMcpRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  deps: McpDeps = defaultDeps,
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }

  if (request.method !== "POST") {
    return Response.json(jsonRpcError(null, -32600, "Only POST requests are accepted"), {
      status: 405,
      headers: { Allow: "POST, OPTIONS" },
    });
  }

  if (env.MCP_RATE_LIMIT) {
    const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
    const { success } = await env.MCP_RATE_LIMIT.limit({ key: ip });
    if (!success) {
      return Response.json(jsonRpcError(null, -32000, "Rate limit exceeded — retry later"), {
        status: 429,
        headers: { "Retry-After": "60" },
      });
    }
  }

  const contentType = request.headers.get("content-type") ?? "";
  const mediaType = contentType.split(";")[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    return Response.json(jsonRpcError(null, -32700, "Content-Type must be application/json"), {
      status: 415,
    });
  }

  const text = await readBoundedText(request);
  if (text === null) {
    return Response.json(jsonRpcError(null, -32600, "Request body exceeds 4 MiB"), { status: 413 });
  }

  let body: unknown;
  try {
    // SAFETY: widens JSON.parse's `any` to `unknown`; the envelope decoder narrows it.
    body = JSON.parse(text) as unknown;
  } catch {
    return Response.json(jsonRpcError(null, -32700, "Parse error: invalid JSON"), { status: 400 });
  }

  const decoded = decodeJsonRpcRequest(body);
  if (Result.isFailure(decoded)) {
    return Response.json(jsonRpcError(knownId(body), -32600, "Invalid JSON-RPC 2.0 request"), {
      status: 400,
    });
  }
  const rpcRequest = decoded.success;

  logClientHeaders(request, rpcRequest);

  const unsupported = unsupportedProtocolMessage(request, rpcRequest);
  if (unsupported !== null) {
    return Response.json(jsonRpcError(knownId(body), -32600, unsupported), { status: 400 });
  }

  // JSON-RPC notifications (method "notifications/*") take no response.
  // Per the MCP streamable-HTTP transport, acknowledge with 202 and no body.
  if (rpcRequest.method.startsWith("notifications/")) {
    return new Response(null, { status: 202 });
  }

  let response: JsonRpcResponse;
  try {
    response = await handleJsonRpc(rpcRequest, env, ctx, deps);
  } catch (err) {
    if (err instanceof McpRequestError) {
      response = jsonRpcError(rpcRequest.id, err.code, err.message);
    } else {
      logError("mcp_handler_error", err);
      response = jsonRpcError(rpcRequest.id, -32603, "Internal error");
    }
  }

  return Response.json(response, {
    headers: { "Content-Type": "application/json" },
  });
}
