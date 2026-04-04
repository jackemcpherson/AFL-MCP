export interface JsonRpcRequest {
  jsonrpc: "2.0"
  id: string | number
  method: string
  params?: Record<string, unknown>
}

export interface JsonRpcResponse {
  jsonrpc: "2.0"
  id: string | number
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}
