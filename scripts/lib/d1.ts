/**
 * Shared remote D1 plumbing for the local maintenance scripts.
 *
 * Every call shells out to the lockfile's Wrangler through `bunx` against the
 * production `afl-stats` database. Arguments go to `execFileSync` as an array,
 * so SQL needs no shell quoting.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect, Schema } from "effect";

/** Name of the production D1 database the scripts read and write. */
export const D1_DATABASE = "afl-stats";

/** Statements per generated SQL file unless the caller picks another size. */
export const DEFAULT_BATCH_SIZE = 200;

const MAX_BUFFER = 50 * 1024 * 1024;

/** Envelope of `wrangler d1 execute --json`: one result set per statement. */
const D1ExecuteOutputSchema = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      results: Schema.Array(Schema.Unknown).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
    }),
  ),
);

function wrangler(args: readonly string[]): string {
  return execFileSync("bunx", ["wrangler", ...args], {
    encoding: "utf-8",
    maxBuffer: MAX_BUFFER,
  });
}

/**
 * Run one read query against remote D1 and decode its rows.
 *
 * @param sql - A single SQL statement.
 * @param rowSchema - Schema every result row must satisfy.
 * @returns The decoded rows of the first result set.
 * @throws When Wrangler fails or a row does not match `rowSchema`.
 * @example
 * const rows = queryD1("SELECT id FROM players", Schema.Struct({ id: Schema.Number }));
 */
export function queryD1<S extends Schema.ConstraintDecoder<unknown>>(
  sql: string,
  rowSchema: S,
): readonly S["Type"][] {
  const raw = wrangler(["d1", "execute", D1_DATABASE, "--remote", "--command", sql, "--json"]);
  const output = Schema.decodeUnknownSync(D1ExecuteOutputSchema)(raw);
  return Schema.decodeUnknownSync(Schema.Array(rowSchema))(output[0]?.results ?? []);
}

/**
 * Apply a SQL file to remote D1.
 *
 * @param filePath - Path of the `.sql` file to execute.
 * @throws When Wrangler exits non-zero.
 * @example
 * executeSQLFile("data/sql-dob/dob_fryzigg_0000.sql");
 */
export function executeSQLFile(filePath: string): void {
  wrangler(["d1", "execute", D1_DATABASE, "--remote", "--file", filePath]);
}

/**
 * Replace the `<prefix>_NNNN.sql` files in `dir` with `statements` in batches.
 *
 * @param dir - Directory that holds the generated SQL files.
 * @param prefix - File-name prefix. Existing files with it are deleted first.
 * @param statements - SQL statements without trailing semicolons.
 * @param batchSize - Statements per file.
 * @returns The number of files written.
 * @example
 * const files = writeBatchedSQL("data/sql-weather", "weather", statements);
 */
export function writeBatchedSQL(
  dir: string,
  prefix: string,
  statements: readonly string[],
  batchSize: number = DEFAULT_BATCH_SIZE,
): number {
  for (const f of readdirSync(dir).filter((f) => f.startsWith(`${prefix}_`))) {
    unlinkSync(join(dir, f));
  }
  let fileIndex = 0;
  for (let i = 0; i < statements.length; i += batchSize) {
    const sql = `${statements.slice(i, i + batchSize).join(";\n")};\n`;
    writeFileSync(join(dir, `${prefix}_${String(fileIndex).padStart(4, "0")}.sql`), sql);
    fileIndex++;
  }
  return fileIndex;
}
