export interface JsonRpcResponse {
  jsonrpc: "2.0";
  /** `null` when the request id could not be determined (JSON-RPC 2.0). */
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
