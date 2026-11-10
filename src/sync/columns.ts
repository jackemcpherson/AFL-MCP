/**
 * Single-manifest SQL fragment generation for change-detecting upserts.
 *
 * The sync upserts repeat the same column list in four places that must stay
 * in lockstep: the INSERT column list, the VALUES placeholders, the
 * `ON CONFLICT DO UPDATE SET` clause, and the change-detection WHERE clause
 * whose `excluded.col IS NOT col` predicates gate `meta.changes` (which in
 * turn gates PAV recalculation). One missed line silently breaks change
 * counting, so every fragment is derived from a single column manifest here.
 */

/**
 * How a column participates in the generated `ON CONFLICT DO UPDATE`
 * SET / change-detection WHERE fragments:
 *
 * - `"key"` — excluded from both fragments. Either a conflict-target /
 *   identity column, an insert-only column, or a column updated by
 *   branch-specific SQL outside the generated fragments.
 * - `"replace"` — `col = excluded.col`, detected via
 *   `table.col IS NOT excluded.col`.
 * - `"coalesce"` — `col = COALESCE(excluded.col, table.col)` so a NULL in
 *   the incoming row never clobbers existing data; detected via
 *   `table.col IS NOT COALESCE(excluded.col, table.col)`. A
 *   {@link ColumnDef.replaceWhen} condition switches it to replace.
 */
export type UpsertColumnKind = "key" | "replace" | "coalesce";

/** Name and update semantics for one upserted column (value-free view). */
export interface ColumnDef {
  /** SQL column name. */
  readonly name: string;
  /** Update / change-detection semantics for the generated fragments. */
  readonly kind: UpsertColumnKind;
  /**
   * `"coalesce"` only: a SQL condition over the existing row and `excluded`
   * under which the incoming value replaces the stored one, NULL included.
   * Otherwise the column coalesces.
   */
  readonly replaceWhen?: string;
}

/**
 * One column in an upsert manifest: SQL name, update semantics, and the
 * extractor producing its bind value from the input row.
 */
export interface UpsertColumn<Row> extends ColumnDef {
  /** Extract the bind value for this column from the input row. */
  readonly value: (row: Row) => unknown;
}

/**
 * Comma-separated column names for the INSERT column list, in manifest order.
 */
export function insertColumnList(columns: readonly ColumnDef[]): string {
  return columns.map((c) => c.name).join(", ");
}

/** Comma-separated `?` placeholders, one per manifest column. */
export function placeholderList(columns: readonly ColumnDef[]): string {
  return columns.map(() => "?").join(", ");
}

/**
 * The value a non-`"key"` column takes on update, shared by the SET and
 * change-detection fragments so they cannot disagree.
 */
function updatedValue(table: string, c: ColumnDef): string {
  if (c.kind !== "coalesce") return `excluded.${c.name}`;
  const coalesced = `COALESCE(excluded.${c.name}, ${table}.${c.name})`;
  return c.replaceWhen === undefined
    ? coalesced
    : `CASE WHEN ${c.replaceWhen} THEN excluded.${c.name} ELSE ${coalesced} END`;
}

/**
 * `DO UPDATE SET` assignments for every non-`"key"` column, in manifest
 * order. `"coalesce"` columns use `COALESCE(excluded.col, table.col)` so a
 * NULL re-fetch never clobbers existing data.
 *
 * @param table - Table name used to qualify the existing row's columns.
 */
export function updateSetClause(table: string, columns: readonly ColumnDef[]): string {
  return columns
    .filter((c) => c.kind !== "key")
    .map((c) => `${c.name} = ${updatedValue(table, c)}`)
    .join(",\n      ");
}

/**
 * Change-detection predicates (`OR`-joined) for every non-`"key"` column,
 * mirroring {@link updateSetClause} exactly: the upsert's WHERE clause is
 * true only when the SET clause would actually change the row, so
 * `meta.changes` counts real writes rather than no-op upserts.
 *
 * @param table - Table name used to qualify the existing row's columns.
 */
export function changeDetectionWhere(table: string, columns: readonly ColumnDef[]): string {
  return columns
    .filter((c) => c.kind !== "key")
    .map((c) => `${table}.${c.name} IS NOT ${updatedValue(table, c)}`)
    .join(" OR\n      ");
}

/** Bind values for the input row, in manifest order (matches the placeholders). */
export function bindValues<Row>(columns: readonly UpsertColumn<Row>[], row: Row): unknown[] {
  return columns.map((c) => c.value(row));
}
