import { executeCode } from "../../sandbox/executor"
import type { Env } from "../../types"

export async function handleCodeTool(code: string, env: Env, ctx: ExecutionContext) {
  return executeCode(code, env, ctx)
}
