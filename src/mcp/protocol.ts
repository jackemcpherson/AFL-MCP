import { Predicate, Result } from "effect";
import pkg from "../../package.json";
import { COMPETITION_CODES } from "../lib/competitions";
import { describeIssue, firstIssue } from "../lib/decode";
import { logError } from "../lib/errors";
import { type ExecuteResult, executeCode } from "../sandbox/executor";
import { looksLikeTypeScript } from "../sandbox/normalize";
import type { Env } from "../types";
import { McpRequestError } from "./errors";
import { getSchemaInfo } from "./tools/schema";
import type { JsonRpcResponse, ToolAnnotations, ToolDefinition } from "./types";
import {
  CODE_TOOL_CONTRACT,
  decodeCodeToolRequest,
  decodeJsonRpcId,
  decodeJsonRpcRequest,
  decodeSchemaToolRequest,
  decodeToolCallParams,
  type JsonRpcRequest,
  SCHEMA_TOOL_CONTRACT,
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

/** Newest protocol revision, answered to any request for an unsupported one. */
const LATEST_PROTOCOL_VERSION = "2025-11-25";

/** Legacy-era (initialize handshake) protocol revisions this server speaks, newest first. */
const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [
  LATEST_PROTOCOL_VERSION,
  "2025-06-18",
  "2025-03-26",
];

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

/**
 * Session-wide guidance returned from `initialize`. Each rule has one home:
 * tool descriptions say only what triggers the tool and what its arguments
 * mean, and the competition-filter guardrail sits on the `code` tool, where
 * the model writes SQL.
 */
const INSTRUCTIONS =
  "Call the schema tool before your first code call. It returns the tables, query rules, per-competition coverage and query API that code-tool queries depend on.";

/**
 * Both tools only read the database and touch no outside system.
 * @param title - Display name for the tool.
 * @returns Annotations marking the tool read-only, non-destructive,
 * idempotent and closed-world.
 */
function readOnlyAnnotations(title: string): ToolAnnotations {
  return {
    title,
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };
}

// No CORS headers are sent: MCP clients are server-side, and withholding
// Access-Control-Allow-Origin stops arbitrary web pages from driving the
// code-execution endpoint with visitors' browsers (SEC-03).

/**
 * The `db` surface the sandbox exposes, as a TypeScript declaration. It must
 * match the wrapper in `src/sandbox/executor.ts` and the rows `DbProxy`
 * returns: `bind` replaces earlier values, `all` returns D1's whole result,
 * and `first` returns one row.
 */
const DB_DECLARATION = [
  "type Row = Record<string, unknown>;",
  "interface D1Result { results: Row[]; success: boolean; meta: Record<string, unknown> }",
  "interface Statement {",
  "  /** Bind positional values to ? placeholders. */",
  "  bind(...values: unknown[]): Statement;",
  "  /** Run the read-only statement and return every row. */",
  "  all(): Promise<D1Result>;",
  "  /** Run the read-only statement and return the first row, or null. */",
  "  first(): Promise<Row | null>;",
  "}",
  "declare const db: { prepare(sql: string): Statement };",
].join("\n");

/** What the `code` tool runs, and the one syntax rule models most often break. */
const CODE_TOOL_DESCRIPTION = [
  "Run JavaScript in an isolated sandbox with read-only access to the Australian football D1 database through `db`.",
  "Write the body of an async function in plain JavaScript: use await, and end with return and a JSON-serialisable value, such as `const r = await db.prepare(sql).bind('AFLM').all(); return r.results;`. A single `async () => { ... }` function also works.",
  "Do NOT use TypeScript syntax: no type annotations, interfaces, `as` casts or generics. The sandbox does not compile TypeScript, so that code fails to parse.",
  `The \`db\` API, declared in TypeScript for reference:\n${DB_DECLARATION}`,
  "Filter every SQL query by competition with JOIN competitions c ... WHERE c.code = ?, as the schema notes show.",
  "Sandbox constraints: no network access, no npm imports, 30-second timeout, write/DDL statements rejected, results over 1 MB truncated (narrow with LIMIT or aggregation), rate limited at 60 requests/minute per IP.",
].join("\n\n");

const TOOLS: ToolDefinition[] = [
  {
    name: "schema",
    title: "Database schema",
    description: `Get the schema of the Australian football database: table definitions, column details, query rules, per-competition coverage, join patterns and query API. ${SCHEMA_TOOL_CONTRACT}`,
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
          // Mirrors SEASON_KEY_PATTERN. Both spellings are on the wire (this one in
          // tools/list, the other in schema error text), so each stays literal.
          oneOf: [{ type: "integer" }, { type: "string", pattern: "^[0-9]{4}(-S[67])?$" }],
          description:
            "Canonical season key or unambiguous year. AFLW 2022 requires 2022-S6 or 2022-S7. Requires competition and includeObserved:true.",
        },
      },
      additionalProperties: false,
    },
    annotations: readOnlyAnnotations("Database schema"),
  },
  {
    name: "code",
    title: "Run query code",
    description: CODE_TOOL_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description:
            "JavaScript async function body to run, ending in return. `db` is in scope, with the API in the tool description. TypeScript syntax is not supported.",
        },
        competition: {
          type: "string",
          enum: [...COMPETITION_CODES],
          description:
            "Optional hint naming the competition the query is about. It adds no SQL filter.",
        },
      },
      required: ["code"],
      additionalProperties: false,
    },
    annotations: readOnlyAnnotations("Run query code"),
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

/**
 * Build a successful tool result. The text block is always present, for
 * clients that ignore structured content. A JSON object is also returned as
 * `structuredContent`. Strings, arrays and other values are text only,
 * because the spec requires `structuredContent` to be an object.
 * @param data - Tool output.
 * @returns The `tools/call` result.
 */
function mcpContent(data: unknown) {
  const content = [
    {
      type: "text",
      text: Predicate.isString(data) ? data : JSON.stringify(data, null, 2),
    },
  ];
  return Predicate.isObject(data) ? { content, structuredContent: data } : { content };
}

function mcpError(message: string) {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

/** Appended to a syntax error in code that carries TypeScript syntax. */
const TYPESCRIPT_HINT = "The sandbox runs JavaScript. Remove type annotations.";

/**
 * The executor's error message, with the TypeScript hint when the failure
 * is a syntax error and the code looks like TypeScript.
 * @param result - A failed sandbox run.
 * @param code - The submitted code.
 * @returns The message to show the model.
 */
function withTypeScriptHint(result: ExecuteResult, code: string): string {
  const message = result.error ?? "";
  if (result.errorClass !== "SyntaxError" || !looksLikeTypeScript(code)) return message;
  return `${message.replace(/\.?$/, ".")} ${TYPESCRIPT_HINT}`;
}

/**
 * Log one `tool:code` event per run. It records the outcome and the error
 * class only, never the error message or the code, which carry user text.
 * @param competition - The competition hint, or `null`.
 * @param result - The sandbox run.
 */
function logCodeOutcome(competition: string | null, result: ExecuteResult): void {
  const event =
    result.error === undefined
      ? { event: "tool:code", competition, outcome: "ok" }
      : {
          event: "tool:code",
          competition,
          outcome: "error",
          errorClass: result.errorClass ?? "Error",
        };
  console.log(JSON.stringify(event));
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
      if (Result.isFailure(parsed)) {
        // Every argument error carries the usage hint so the model can retry.
        const message = describeIssue(parsed.failure);
        return mcpError(
          message === SCHEMA_TOOL_CONTRACT ? message : `${message}. ${SCHEMA_TOOL_CONTRACT}`,
        );
      }
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
        const key = firstIssue(parsed.failure).path[0];
        if (key === "competition") {
          return mcpError(`competition must be one of ${COMPETITION_CODES.join(", ")}`);
        }
        if (key === undefined || key === "code") {
          return mcpError("code parameter is required and must be a non-empty string");
        }
        // Any other key is an argument the tool does not declare.
        return mcpError(`${describeIssue(parsed.failure)}. ${CODE_TOOL_CONTRACT}`);
      }
      const { code } = parsed.success;
      const competition = parsed.success.competition ?? null;
      const result = await deps.executeCode(code, env, ctx);
      logCodeOutcome(competition, result);
      if (result.error !== undefined) {
        const message = withTypeScriptHint(result, code);
        return mcpError(`Execution error (${result.execution_time_ms}ms): ${message}`);
      }
      return mcpContent(result.result);
    }

    default:
      throw new McpRequestError({ code: -32602, message: `Unknown tool: ${name}` });
  }
}

/** A JSON-RPC request that carries an id, so it takes a response. */
type JsonRpcCall = JsonRpcRequest & { readonly id: string | number };

async function handleJsonRpc(
  request: JsonRpcCall,
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
        instructions: INSTRUCTIONS,
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

/** `_meta` key that marks a request in the 2026-07-28 per-request format. */
const MODERN_PROTOCOL_VERSION_META = "io.modelcontextprotocol/protocolVersion";

/**
 * Read the 2026-07-28 protocol version marker from a request's `_meta`.
 * @param rpcRequest - Validated JSON-RPC request.
 * @returns `{ value }` when the marker key is present (any value), else `null`.
 */
function modernProtocolMarker(rpcRequest: JsonRpcRequest): { readonly value: unknown } | null {
  const meta = rpcRequest.params?.["_meta"];
  return Predicate.isObject(meta) && Predicate.hasProperty(meta, MODERN_PROTOCOL_VERSION_META)
    ? { value: meta[MODERN_PROTOCOL_VERSION_META] }
    : null;
}

/**
 * Log the client's Origin and protocol version so later releases can tighten
 * request checks against observed traffic. `metaProtocolVersion` records the
 * 2026-07-28 `_meta` marker, so a request flagged only by `_meta` is told
 * apart from a 2025-03-26 request (which sends no version header).
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
  const marker = modernProtocolMarker(rpcRequest);
  const metaProtocolVersion =
    marker === null
      ? null
      : (Predicate.isString(marker.value)
          ? marker.value
          : String(JSON.stringify(marker.value))
        ).slice(0, MAX_LOGGED_HEADER_LENGTH);
  console.log(
    JSON.stringify({
      event: "mcp:client",
      method: rpcRequest.method,
      origin: header("origin"),
      protocolVersionHeader: header("mcp-protocol-version"),
      initializeProtocolVersion,
      metaProtocolVersion,
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
  const header = request.headers.get("mcp-protocol-version");
  const isModern = modernProtocolMarker(rpcRequest) !== null;
  if (!isModern && (header === null || SUPPORTED_PROTOCOL_VERSIONS.includes(header))) return null;
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

  if (await isRateLimited(request, env)) return rateLimitedResponse();

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

  const header = request.headers.get("mcp-protocol-version");
  if (Array.isArray(body) && (header === null || header === BATCH_PROTOCOL_VERSION)) {
    return handleBatch(request, body, env, ctx, deps);
  }

  const outcome = await handleMessage(request, body, env, ctx, deps, false);
  switch (outcome.kind) {
    case "rejected":
      return Response.json(outcome.response, { status: 400 });
    case "none":
      // Per the MCP streamable-HTTP transport, acknowledge with 202 and no body.
      return new Response(null, { status: 202 });
    case "answered":
      return Response.json(outcome.response, { headers: { "Content-Type": "application/json" } });
  }
}

/**
 * What one JSON-RPC message produced: an error that rejects it before any
 * method runs, no response (a notification), or the method's response.
 */
type MessageOutcome =
  | { readonly kind: "rejected"; readonly response: JsonRpcResponse }
  | { readonly kind: "none" }
  | { readonly kind: "answered"; readonly response: JsonRpcResponse };

/**
 * Validate and run one JSON-RPC message, alone or as a batch element.
 * @param request - Incoming MCP POST request, for headers and logging.
 * @param message - The parsed message.
 * @param env - Worker environment.
 * @param ctx - Worker execution context.
 * @param deps - Collaborators.
 * @param inBatch - Whether the message is an element of a batch.
 * @returns The message's outcome.
 */
async function handleMessage(
  request: Request,
  message: unknown,
  env: Env,
  ctx: ExecutionContext,
  deps: McpDeps,
  inBatch: boolean,
): Promise<MessageOutcome> {
  const decoded = decodeJsonRpcRequest(message);
  if (Result.isFailure(decoded)) {
    return {
      kind: "rejected",
      response: jsonRpcError(knownId(message), -32600, "Invalid JSON-RPC 2.0 request"),
    };
  }
  const rpcRequest = decoded.success;

  logClientHeaders(request, rpcRequest);

  const unsupported = unsupportedProtocolMessage(request, rpcRequest);
  if (unsupported !== null) {
    return { kind: "rejected", response: jsonRpcError(knownId(message), -32600, unsupported) };
  }

  // JSON-RPC 2.0: a message without an id is a notification, whatever its
  // method, so it is not run and takes no response. "notifications/*"
  // methods take no response even when a client attaches an id.
  const { id } = rpcRequest;
  if (id === undefined || rpcRequest.method.startsWith("notifications/")) {
    return { kind: "none" };
  }

  // 2025-03-26 lifecycle: initialize MUST NOT be part of a batch.
  if (inBatch && rpcRequest.method === "initialize") {
    return {
      kind: "rejected",
      response: jsonRpcError(id, -32600, "initialize must not be part of a JSON-RPC batch"),
    };
  }

  try {
    const response = await handleJsonRpc({ ...rpcRequest, id }, env, ctx, deps);
    return { kind: "answered", response };
  } catch (err) {
    if (err instanceof McpRequestError) {
      return { kind: "answered", response: jsonRpcError(id, err.code, err.message) };
    }
    logError("mcp_handler_error", err);
    return { kind: "answered", response: jsonRpcError(id, -32603, "Internal error") };
  }
}

/** The only revision this server speaks with JSON-RPC batching. 2025-06-18 removed it. */
const BATCH_PROTOCOL_VERSION = "2025-03-26";

/**
 * Most messages accepted in one batch. Elements run one after another, so
 * this bounds a batch to 20 sandbox runs.
 */
const MAX_BATCH_MESSAGES = 20;

/**
 * Serve a 2025-03-26 JSON-RPC batch.
 *
 * Elements run one at a time, in order, so a batch holds at most one
 * sandbox isolate at once. Each element beyond the first costs one more
 * rate-limit token, so batching does not multiply a caller's quota.
 * @param request - Incoming MCP POST request.
 * @param batch - The parsed JSON array.
 * @param env - Worker environment.
 * @param ctx - Worker execution context.
 * @param deps - Collaborators.
 * @returns 200 with the responses in input order, 202 when no element takes
 * a response, or one error for an empty, oversized or rate-limited batch.
 */
async function handleBatch(
  request: Request,
  batch: readonly unknown[],
  env: Env,
  ctx: ExecutionContext,
  deps: McpDeps,
): Promise<Response> {
  if (batch.length === 0) {
    return Response.json(jsonRpcError(null, -32600, "Invalid JSON-RPC 2.0 request"), {
      status: 400,
    });
  }
  if (batch.length > MAX_BATCH_MESSAGES) {
    return Response.json(
      jsonRpcError(null, -32600, `Batch exceeds ${MAX_BATCH_MESSAGES} messages`),
      { status: 400 },
    );
  }
  const extraTokens = Array.from({ length: batch.length - 1 }, () => isRateLimited(request, env));
  if ((await Promise.all(extraTokens)).includes(true)) return rateLimitedResponse();

  const responses: JsonRpcResponse[] = [];
  for (const message of batch) {
    const outcome = await handleMessage(request, message, env, ctx, deps, true);
    if (outcome.kind !== "none") responses.push(outcome.response);
  }
  if (responses.length === 0) return new Response(null, { status: 202 });
  return Response.json(responses, { headers: { "Content-Type": "application/json" } });
}

/**
 * Take one token from the caller's per-IP rate limit.
 * @param request - Incoming MCP request.
 * @param env - Worker environment.
 * @returns `true` when the caller is over the limit.
 */
async function isRateLimited(request: Request, env: Env): Promise<boolean> {
  if (!env.MCP_RATE_LIMIT) return false;
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const { success } = await env.MCP_RATE_LIMIT.limit({ key: ip });
  return !success;
}

/** The 429 reply for a caller over the rate limit. */
function rateLimitedResponse(): Response {
  return Response.json(jsonRpcError(null, -32000, "Rate limit exceeded — retry later"), {
    status: 429,
    headers: { "Retry-After": "60" },
  });
}
