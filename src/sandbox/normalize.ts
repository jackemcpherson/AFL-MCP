/** A whole submission wrapped in one Markdown code fence, with an optional language label. */
const FENCE = /^\s*```[\w-]*[ \t]*\r?\n([\s\S]*?)\r?\n?```\s*$/d;

/**
 * The start of a lone async function expression: an arrow with no
 * parameters, or an anonymous `async function ()`. Neither start is useful
 * as a statement in a function body, so the prefix alone marks a
 * submission that is one function to call.
 */
const ASYNC_FUNCTION_EXPRESSION = /^async\s*(?:\(\s*\)\s*=>|function\s*\(\s*\))/;

/**
 * A submission turned into the function body the sandbox runs, and where
 * the submission's own text sits in that body. The text is copied
 * verbatim, so a position inside it maps back to the submission.
 */
export interface NormalizedCode {
  /** Function body for the sandbox wrapper. */
  readonly body: string;
  /** Offset in `body` where the submission's text starts. */
  readonly bodyStart: number;
  /** Offset in the submission where that text starts. */
  readonly sourceStart: number;
  /** Length of that text. */
  readonly length: number;
}

/**
 * Turn common code shapes into the function body the sandbox runs.
 *
 * The documented shape is a function body that ends in `return`. Two other
 * shapes are accepted: code wrapped in a Markdown fence, and a single
 * `async () => { ... }` or `async function () { ... }` expression, which is
 * invoked and its result returned.
 *
 * @param code - Code as submitted to the `code` tool.
 * @returns A function body for the sandbox wrapper.
 * @example
 * normalizeCode("```js\nreturn 1\n```"); // "return 1"
 */
export function normalizeCode(code: string): string {
  return normalizeSubmission(code).body;
}

/**
 * {@link normalizeCode}, plus where the submission's text sits in the body.
 *
 * @param code - Code as submitted to the `code` tool.
 * @returns The function body and the span of submitted text inside it.
 * @example
 * normalizeSubmission("```js\nreturn 1\n```");
 * // { body: "return 1", bodyStart: 0, sourceStart: 6, length: 8 }
 */
export function normalizeSubmission(code: string): NormalizedCode {
  const fenced = FENCE.exec(code);
  const inner = fenced?.[1] ?? code;
  const innerStart = fenced?.indices?.[1]?.[0] ?? 0;
  const body = inner.trim();
  const sourceStart = innerStart + inner.length - inner.trimStart().length;
  if (!ASYNC_FUNCTION_EXPRESSION.test(body)) {
    return fenced === null
      ? { body: code, bodyStart: 0, sourceStart: 0, length: code.length }
      : { body, bodyStart: 0, sourceStart, length: body.length };
  }
  // Newlines keep a trailing line comment from swallowing the call.
  const prefix = "return await (\n";
  const call = body.replace(/;\s*$/, "");
  return {
    body: `${prefix}${call}\n)();`,
    bodyStart: prefix.length,
    sourceStart,
    length: call.length,
  };
}

/**
 * TypeScript-only syntax: a type alias or interface declaration, a variable,
 * parameter or return annotation, an `as` cast, or explicit type arguments.
 */
const TYPESCRIPT_SYNTAX: readonly RegExp[] = [
  /^\s*(?:export\s+)?interface\s+[A-Za-z_$][\w$]*\s*(?:<|\{|extends\b)/m,
  /^\s*(?:export\s+)?type\s+[A-Za-z_$][\w$]*\s*(?:<[^>]*>)?\s*=/m,
  /\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*:\s*[A-Za-z_${[(]/,
  /\(\s*[A-Za-z_$][\w$]*\s*\??:\s*[A-Za-z_${[(]/,
  /\)\s*:\s*[A-Za-z_$][\w$<>[\]]*\s*(?:=>|\{)/,
  /\bas\s+(?:const|any|unknown|string|number|boolean|Record|Array|[A-Z][\w$]*)\b/,
  /[\w$]<[A-Za-z_$][\w$]*(?:\[\])?(?:\s*,\s*[A-Za-z_$][\w$]*(?:\[\])?)*>\s*\(/,
];

/**
 * Whether code carries syntax that only TypeScript accepts. A heuristic for
 * explaining a syntax error: it scans text, so a match inside a string or
 * comment also counts.
 *
 * @param code - Code as submitted to the `code` tool.
 * @returns `true` when any TypeScript-only pattern appears.
 * @example
 * looksLikeTypeScript("const f = (x: number) => x"); // true
 */
export function looksLikeTypeScript(code: string): boolean {
  return TYPESCRIPT_SYNTAX.some((pattern) => pattern.test(code));
}
