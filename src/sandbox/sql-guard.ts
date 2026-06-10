/**
 * Read-only SQL enforcement for the sandbox `DbProxy`.
 *
 * The public `code` tool advertises read-only database access; this module
 * makes that claim true at the RPC boundary. D1 prepares a single statement
 * per call, so validating the one statement is sufficient — but a bare
 * prefix check is not, because SQLite permits writes behind a CTE
 * (`WITH x AS (...) DELETE FROM ...`). We therefore require a read-only
 * leading keyword AND reject any write/DDL keyword appearing anywhere in
 * the statement once comments and string literals are stripped.
 */

const ALLOWED_LEADING_KEYWORDS = new Set(["SELECT", "WITH", "EXPLAIN"]);

const FORBIDDEN_KEYWORDS =
  /\b(INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER|CREATE|TRUNCATE|PRAGMA|ATTACH|DETACH|VACUUM|REINDEX|BEGIN|COMMIT|ROLLBACK|SAVEPOINT)\b/i;

/** Error thrown when a statement fails read-only validation. */
export class ReadOnlySqlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReadOnlySqlError";
  }
}

/**
 * Removes SQL comments (line and block) and string literals
 * (single-quoted with `''` escapes, double-quoted identifiers, backticks,
 * and `[bracketed]` identifiers) so keyword scanning cannot be confused by
 * quoted content.
 *
 * @param sql - Raw SQL text.
 * @returns The SQL with comments removed and quoted regions blanked.
 */
function stripCommentsAndStrings(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === "-" && next === "-") {
      const nl = sql.indexOf("\n", i);
      if (nl === -1) break;
      i = nl;
    } else if (ch === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end === -1) break;
      i = end + 2;
    } else if (ch === "'") {
      i += 1;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
        } else if (sql[i] === "'") {
          i += 1;
          break;
        } else {
          i += 1;
        }
      }
      out += " ";
    } else if (ch === '"' || ch === "`") {
      const close = sql.indexOf(ch, i + 1);
      if (close === -1) break;
      i = close + 1;
      out += " ";
    } else if (ch === "[") {
      const close = sql.indexOf("]", i + 1);
      if (close === -1) break;
      i = close + 1;
      out += " ";
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

/**
 * Validates that a SQL statement is read-only.
 *
 * A statement passes when its first keyword is `SELECT`, `WITH`, or
 * `EXPLAIN` and no write/DDL/session keyword appears anywhere outside
 * comments and string literals.
 *
 * @param sql - The statement supplied by sandboxed code.
 * @throws ReadOnlySqlError if the statement is not provably read-only.
 */
export function assertReadOnlySql(sql: string): void {
  const cleaned = stripCommentsAndStrings(sql).trim();
  const leading = cleaned.match(/^[A-Za-z_]+/)?.[0]?.toUpperCase() ?? "";
  if (!ALLOWED_LEADING_KEYWORDS.has(leading)) {
    throw new ReadOnlySqlError(
      "Read-only access: statements must begin with SELECT, WITH, or EXPLAIN.",
    );
  }
  const forbidden = cleaned.match(FORBIDDEN_KEYWORDS);
  if (forbidden) {
    throw new ReadOnlySqlError(
      `Read-only access: ${forbidden[0].toUpperCase()} statements are not permitted.`,
    );
  }
}
