export interface JsonRpcResponse {
  jsonrpc: "2.0";
  /** `null` when the request id could not be determined (JSON-RPC 2.0). */
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * MCP tool behaviour hints. The spec defaults `destructiveHint` and
 * `openWorldHint` to `true`, so every hint is set explicitly.
 */
export interface ToolAnnotations {
  /** Display name for clients on 2025-03-26, which predate `Tool.title`. */
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface ToolDefinition {
  name: string;
  /** Human-readable display name. */
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: ToolAnnotations;
}
