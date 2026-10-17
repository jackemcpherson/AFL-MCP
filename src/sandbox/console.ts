/** Most console lines returned from one run. */
export const MAX_CONSOLE_LINES: number = 100;

/** Most console characters returned from one run, across all lines. */
export const MAX_CONSOLE_CHARS: number = 10_000;

/**
 * Sandbox-side source that replaces `console.log`, `info`, `warn`, `error`
 * and `debug` with a capture into `__logs`, bounded as
 * {@link boundConsoleLines} bounds it, and counts the lines it drops in
 * `__dropped`. Objects print as JSON, circular references as `[Circular]`.
 * Runs inside the sandbox's `fetch` handler, before the submitted code.
 */
export const CONSOLE_CAPTURE_SOURCE: string = `
          const __logs = []
          let __logChars = 0
          let __dropped = 0
          const __text = (value) => {
            if (typeof value === "string") return value
            if (value instanceof Error) return value.name + ": " + value.message
            if (typeof value !== "object" || value === null) return String(value)
            const seen = new WeakSet()
            try {
              const json = JSON.stringify(value, (key, item) => {
                if (typeof item === "bigint") return String(item)
                if (typeof item === "object" && item !== null) {
                  if (seen.has(item)) return "[Circular]"
                  seen.add(item)
                }
                return item
              })
              return json === undefined ? String(value) : json
            } catch {
              return String(value)
            }
          }
          const __capture = (prefix) => (...args) => {
            if (__logs.length >= ${MAX_CONSOLE_LINES} || __logChars >= ${MAX_CONSOLE_CHARS}) {
              __dropped += 1
              return
            }
            const line = prefix + args.map(__text).join(" ")
            const room = ${MAX_CONSOLE_CHARS} - __logChars
            const kept = line.length > room ? line.slice(0, room) + "…" : line
            __logChars += kept.length
            __logs.push(kept)
          }
          console.log = __capture("")
          console.info = __capture("[info] ")
          console.warn = __capture("[warn] ")
          console.error = __capture("[error] ")
          console.debug = __capture("[debug] ")
`;

/**
 * Bound console lines to {@link MAX_CONSOLE_LINES} lines and
 * {@link MAX_CONSOLE_CHARS} characters. The line that crosses the
 * character limit is cut and ends with `…`. A final line counts what was
 * left out.
 *
 * @param lines - Captured lines, in order.
 * @param dropped - Lines the sandbox already left out.
 * @returns The lines to return, with a final count line when any were left out.
 * @example
 * boundConsoleLines(["a", "b"], 3); // ["a", "b", "… [3 more console lines not shown]"]
 */
export function boundConsoleLines(lines: readonly string[], dropped: number): string[] {
  const kept: string[] = [];
  let chars = 0;
  let omitted = dropped;
  for (const line of lines) {
    if (kept.length >= MAX_CONSOLE_LINES || chars >= MAX_CONSOLE_CHARS) {
      omitted += 1;
      continue;
    }
    const room = MAX_CONSOLE_CHARS - chars;
    const text = line.length > room ? `${line.slice(0, room)}…` : line;
    chars += text.length;
    kept.push(text);
  }
  if (omitted > 0) {
    kept.push(`… [${omitted} more console line${omitted === 1 ? "" : "s"} not shown]`);
  }
  return kept;
}
