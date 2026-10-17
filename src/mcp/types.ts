/** A JSON-RPC 2.0 response: a `result` or an `error`. */
export interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  /** `null` when the request id could not be determined (JSON-RPC 2.0). */
  readonly id: string | number | null;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown };
}

/**
 * MCP tool behaviour hints. The spec defaults `destructiveHint` and
 * `openWorldHint` to `true`, so every hint is set explicitly.
 */
export interface ToolAnnotations {
  /** Display name for clients on 2025-03-26, which predate `Tool.title`. */
  readonly title: string;
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}

/** One entry in the `tools/list` result. */
export interface ToolDefinition {
  readonly name: string;
  /** Human-readable display name. */
  readonly title: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly annotations: ToolAnnotations;
}
