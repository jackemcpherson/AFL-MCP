import { Predicate } from "effect";

/** Start of every truncation notice, so a model can search a result for it. */
const MARKER = "--- TRUNCATED";

/** How a model narrows a result that hit the cap. */
const NARROW = "Narrow the query with LIMIT, WHERE or aggregation.";

/** Room left for the notice that replaces the cut part. */
const MARKER_ALLOWANCE = 160;

/** Strings at or under this length are never cut. */
const MIN_STRING_CHARS = 100;

/** Upper bound on cut-and-measure passes. Each pass shortens one node. */
const MAX_PASSES = 32;

/** A JSON object. */
export interface JsonObject {
  [key: string]: JsonValue;
}

/** Any value `JSON.parse` can return. */
export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;

/**
 * Whether a JSON value is an object, not an array or a primitive.
 *
 * @param value - A JSON value.
 * @returns `true` for a JSON object.
 * @example
 * isJsonObject({ a: 1 }); // true
 */
export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return Predicate.isObject(value);
}

/**
 * Length of a result as the `code` tool's text block carries it: a string
 * as raw text, anything else as JSON with two-space indentation.
 *
 * @param value - A JSON-compatible result.
 * @returns The character count.
 * @example
 * serializedLength({ a: 1 }); // 12
 */
export function serializedLength(value: JsonValue): number {
  return Predicate.isString(value) ? value.length : JSON.stringify(value, null, 2).length;
}

/** What has been cut from one array or string so far. */
interface Cut {
  readonly original: number;
  kept: number;
}

/** A node the next pass may shorten, with its compact JSON size. */
interface Candidate {
  readonly size: number;
  /** Shorten the node by about `excess` compact characters. */
  readonly cut: (excess: number) => void;
}

/** Cut state for one pass, keyed by the arrays and string holders it touched. */
interface CutState {
  readonly arrays: WeakMap<JsonValue[], Cut>;
  readonly strings: WeakMap<object, Map<string, Cut>>;
}

/** A JSON container whose entries can be replaced by key. */
type Holder = JsonObject | JsonValue[];

function arrayMarker(cut: Cut): string {
  return `${MARKER}: showing ${cut.kept} of ${cut.original} items. ${NARROW} ---`;
}

function stringMarker(cut: Cut): string {
  return `… ${MARKER}: showing ${cut.kept} of ${cut.original} characters. ${NARROW} ---`;
}

function setEntry(holder: Holder, key: string, value: JsonValue): void {
  if (Array.isArray(holder)) {
    holder[Number(key)] = value;
  } else {
    holder[key] = value;
  }
}

/**
 * Walk a JSON value, record every node a pass could shorten, and return
 * its compact JSON size.
 */
function collect(
  holder: Holder,
  key: string,
  node: JsonValue,
  state: CutState,
  candidates: Candidate[],
): number {
  if (Predicate.isString(node)) {
    const cuts = state.strings.get(holder);
    const cut = cuts?.get(key) ?? { original: node.length, kept: node.length };
    const size = JSON.stringify(node).length;
    if (cut.kept > MIN_STRING_CHARS) {
      candidates.push({
        size,
        cut: (excess) => {
          const next = {
            original: cut.original,
            kept: Math.max(MIN_STRING_CHARS, cut.kept - excess),
          };
          setEntry(holder, key, `${node.slice(0, next.kept)}${stringMarker(next)}`);
          const map = cuts ?? new Map<string, Cut>();
          map.set(key, next);
          state.strings.set(holder, map);
        },
      });
    }
    return size;
  }
  if (Array.isArray(node)) {
    const previous = state.arrays.get(node);
    const kept = previous?.kept ?? node.length;
    const sizes = node
      .slice(0, kept)
      .map((item, index) => collect(node, String(index), item, state, candidates));
    const markerSize = previous === undefined ? 0 : arrayMarker(previous).length + 3;
    const size = 2 + sizes.reduce((sum, item) => sum + item + 1, 0) + markerSize;
    if (kept >= 2) {
      candidates.push({
        size,
        cut: (excess) => {
          const target = size - excess;
          let next = 0;
          let used = 2;
          for (const item of sizes) {
            if (used + item + 1 > target) break;
            used += item + 1;
            next += 1;
          }
          const cut = {
            original: previous?.original ?? node.length,
            kept: Math.min(kept - 1, Math.max(1, next)),
          };
          node.splice(cut.kept);
          node.push(arrayMarker(cut));
          state.arrays.set(node, cut);
        },
      });
    }
    return size;
  }
  if (isJsonObject(node)) {
    let size = 2;
    for (const [childKey, child] of Object.entries(node)) {
      size +=
        JSON.stringify(childKey).length + 2 + collect(node, childKey, child, state, candidates);
    }
    return size;
  }
  return JSON.stringify(node).length;
}

/**
 * Shorten a result until its text form fits the cap, keeping it valid JSON.
 *
 * Each pass cuts the largest array or string: an array keeps a prefix and
 * gains a final notice with the full item count, and a string keeps a
 * prefix and ends with a notice that gives its full length. Objects keep
 * every key. A result with nothing to shorten becomes a single notice.
 * The value is modified in place, so pass a freshly parsed copy.
 *
 * @param value - A JSON-compatible result, such as `JSON.parse` output.
 * @param maxChars - Largest {@link serializedLength} allowed.
 * @returns The result, shortened when over the cap.
 * @example
 * truncateResult(rows, 100_000);
 */
export function truncateResult(value: JsonValue, maxChars: number): JsonValue {
  const box = { root: value };
  const state: CutState = { arrays: new WeakMap(), strings: new WeakMap() };
  let total = serializedLength(box.root);
  for (let pass = 0; pass < MAX_PASSES && total > maxChars; pass += 1) {
    const candidates: Candidate[] = [];
    const compact = collect(box, "root", box.root, state, candidates);
    const largest = candidates.reduce<Candidate | undefined>(
      (best, candidate) => (best === undefined || candidate.size > best.size ? candidate : best),
      undefined,
    );
    if (largest === undefined) break;
    // Cut sizes are compact JSON. Scale the excess from the indented text form.
    const ratio = compact / total;
    largest.cut(Math.ceil((total - maxChars) * ratio) + MARKER_ALLOWANCE);
    total = serializedLength(box.root);
  }
  if (total <= maxChars) return box.root;
  return `${MARKER}: the result has ${serializedLength(value)} characters, over the ${maxChars}-character limit, and no array or string to shorten. ${NARROW} ---`;
}
