/**
 * The one way to run mutually exclusive work against D1.
 *
 * Two persisted machines guard every cron tick and admin operation:
 *
 * - The **operation lease** (`sync_lease`): free, held, or stale once it is
 *   {@link LEASE_TTL_MINUTES} old. One holder at a time.
 * - The **public write marker** (`public_input_revision`): idle, writing, or
 *   stranded. A stranded marker is one whose writer no longer holds the
 *   lease. Readers treat any marker as "inputs are changing".
 *
 * {@link runOperation} owns both lifecycles, so callers state only what they
 * do under them:
 *
 * | Body outcome                 | Marker             | Lease    |
 * | ---------------------------- | ------------------ | -------- |
 * | returns without `write()`    | untouched          | released |
 * | returns after `write()`      | cleared            | released |
 * | throws after `write()`       | stranded on purpose | released |
 *
 * A stranded marker is the recovery checkpoint: only a later operation that
 * names the same identity and asks to resume may take it over.
 */
import { OperationConflictError } from "../admin/errors";
import { acquireOperationLease, releaseOperationLease } from "../sync/lease";
import type { Env } from "../types";
import {
  beginPublicInputWrite,
  findStrandedWrite,
  finishPublicInputWrite,
  protectOperationWrites,
  resumePublicInputWrite,
  type StrandedWrite,
} from "./public-inputs";

/** How an operation enters the writing state. */
export interface WriteOptions {
  /** Take over the stranded marker with this identity instead of starting a new write. */
  readonly resume?: boolean;
  /** Recorded start of a new write. Defaults to the current time. */
  readonly startedAt?: Date;
}

/** The exclusive context handed to an operation body while it holds the lease. */
export interface Operation {
  /** Lease owner token, for statements that fence themselves explicitly. */
  readonly holder: string;
  /**
   * Enter the writing state and return bindings whose every statement is
   * fenced to this operation. Call at most once.
   *
   * @param identity - Persisted operation identity, matched exactly on resume.
   * @param options - Whether to resume a stranded write.
   * @returns Fenced Worker bindings.
   * @throws OperationConflictError when another write is unfinished, or a
   * resume finds no stranded write with this identity.
   */
  write(identity: string, options?: WriteOptions): Promise<Env>;
  /**
   * Find the stranded write left by an earlier run of exactly this identity.
   *
   * @param identity - Persisted operation identity.
   * @returns Its owner and start time, or null.
   */
  stranded(identity: string): Promise<StrandedWrite | null>;
  /**
   * Close out an operation whose own work is already complete. A crash
   * between the last write and clearing the marker leaves the marker
   * stranded; repeating the operation must not report success while readers
   * are still blocked.
   *
   * @param identity - Persisted operation identity.
   * @param resume - Whether the caller explicitly asked to recover.
   * @throws OperationConflictError when the marker is stranded and `resume` is false.
   */
  settle(identity: string, resume: boolean): Promise<void>;
}

/**
 * Run `body` under the operation lease, clearing the write marker only when
 * the body returns.
 *
 * @param env - Worker bindings.
 * @param onBusy - Produces the result when another operation holds the lease.
 * @param body - The exclusive work.
 * @returns The body's result, or `onBusy()`.
 * @throws Whatever the body throws; a write it started stays stranded.
 * @example
 * return runOperation(env, () => ({ busy: true }), async (operation) => {
 *   const writer = await operation.write("pav:12:abc");
 *   await writer.DB.prepare("DELETE FROM pav_rebuild_queue WHERE season_id=12").run();
 *   return { busy: false };
 * });
 */
export async function runOperation<T>(
  env: Env,
  onBusy: () => T | Promise<T>,
  body: (operation: Operation) => Promise<T>,
): Promise<T> {
  const holder = crypto.randomUUID();
  if (!(await acquireOperationLease(env, holder))) return onBusy();
  const marker = { writing: false };
  const write = async (identity: string, options: WriteOptions = {}): Promise<Env> => {
    if (marker.writing) throw new Error("An operation enters the writing state once");
    if (options.resume) await resumePublicInputWrite(env, holder, identity);
    else await beginPublicInputWrite(env, holder, options.startedAt ?? new Date(), identity);
    marker.writing = true;
    return protectOperationWrites(env, holder);
  };
  try {
    const result = await body({
      holder,
      write,
      stranded: (identity) => findStrandedWrite(env, identity),
      settle: async (identity, resume) => {
        if ((await findStrandedWrite(env, identity)) === null) return;
        if (!resume)
          throw new OperationConflictError({
            message: "Completed operation still holds the write marker; repeat with resume",
          });
        await write(identity, { resume: true });
      },
    });
    if (marker.writing) await finishPublicInputWrite(env, holder);
    return result;
  } finally {
    await releaseOperationLease(env, holder);
  }
}
