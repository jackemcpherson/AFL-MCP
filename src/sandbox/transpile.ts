/**
 * TypeScript support for the sandbox `code` tool.
 *
 * The Worker Loader only accepts JavaScript modules, so submitted code is
 * type-stripped in the host Worker before it is embedded in the sandbox
 * module. Sucrase is used because it is pure JavaScript (no Wasm, no
 * `eval`) and strips types without type-checking — annotations are
 * accepted, not enforced. Line numbers are preserved, so runtime and
 * syntax errors point at the caller's own lines.
 */

import { transform } from "sucrase";

/** Name of the async function the submitted code body is wrapped in. */
export const AGENT_FUNCTION_NAME = "__agent";

const PREFIX = `async function ${AGENT_FUNCTION_NAME}() {`;

/** Error thrown when submitted code is not valid TypeScript. */
export class TypeScriptSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TypeScriptSyntaxError";
  }
}

/**
 * Wraps a submitted code body in an async function and strips its
 * TypeScript syntax, returning a JavaScript function declaration named
 * {@link AGENT_FUNCTION_NAME}. The body keeps top-level `await` and
 * `return` semantics.
 *
 * @param code - The TypeScript (or plain JavaScript) function body.
 * @returns JavaScript source declaring `async function __agent() { … }`.
 * @throws {TypeScriptSyntaxError} When the code fails to parse; the
 *   message's `(line:column)` refers to the submitted code.
 * @example
 * transpileAgentCode("const n: number = 1; return n");
 * // "async function __agent() {const n = 1; return n\n}"
 */
export function transpileAgentCode(code: string): string {
  try {
    // The body starts on the same line as the wrapper so line numbers match
    // the submitted code; the trailing newline keeps a final `//` comment
    // from swallowing the closing brace.
    return transform(`${PREFIX}${code}\n}`, {
      transforms: ["typescript"],
      disableESTransforms: true,
    }).code;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new TypeScriptSyntaxError(`TypeScript syntax error: ${adjustPosition(message)}`);
  }
}

/** Shifts a line-1 `(line:column)` position back past the wrapper prefix. */
function adjustPosition(message: string): string {
  return message.replace(/\((\d+):(\d+)\)/, (match, line: string, column: string) => {
    if (line !== "1") {
      return match;
    }
    return `(1:${Math.max(0, Number(column) - PREFIX.length)})`;
  });
}
