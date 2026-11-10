import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import { runOperation } from "../../src/db/operation";
import { acquireOperationLease, releaseOperationLease } from "../../src/sync/lease";

const marker = () =>
  env.DB.prepare("SELECT in_progress, write_operation FROM public_input_revision").first();
const leaseHolder = () => env.DB.prepare("SELECT holder FROM sync_lease").first("holder");

it("returns the busy result without running the body while the lease is held", async () => {
  expect(await acquireOperationLease(env, "other")).toBe(true);
  let ran = false;
  const result = await runOperation(
    env,
    () => "busy",
    async () => {
      ran = true;
      return "ran";
    },
  );
  expect(result).toBe("busy");
  expect(ran).toBe(false);
  await releaseOperationLease(env, "other");
});

it("releases the lease and leaves the marker alone when the body never writes", async () => {
  expect(
    await runOperation(
      env,
      () => "busy",
      async () => "preview",
    ),
  ).toBe("preview");
  expect(await leaseHolder()).toBeNull();
  expect(await marker()).toEqual({ in_progress: 0, write_operation: null });
});

it("clears the marker when a writing body returns", async () => {
  await runOperation(
    env,
    () => undefined,
    async (operation) => {
      const writer = await operation.write("test:one");
      expect(await marker()).toEqual({ in_progress: 1, write_operation: "test:one" });
      await writer.DB.prepare("INSERT INTO sync_log(timestamp,type) VALUES('t','test')").run();
    },
  );
  expect(await marker()).toEqual({ in_progress: 0, write_operation: null });
  expect(await leaseHolder()).toBeNull();
});

it("strands the marker for recovery when a writing body throws", async () => {
  await expect(
    runOperation(
      env,
      () => undefined,
      async (operation) => {
        await operation.write("test:crash");
        throw new Error("mid-write failure");
      },
    ),
  ).rejects.toThrow("mid-write failure");
  expect(await marker()).toEqual({ in_progress: 1, write_operation: "test:crash" });
  expect(await leaseHolder()).toBeNull();

  // Another identity cannot start or take over; the same identity can resume.
  await expect(
    runOperation(
      env,
      () => undefined,
      async (operation) => {
        await operation.write("test:other", { resume: true });
      },
    ),
  ).rejects.toThrow("matching operation marker");
  await runOperation(
    env,
    () => undefined,
    async (operation) => {
      expect(await operation.stranded("test:crash")).not.toBeNull();
      await operation.write("test:crash", { resume: true });
    },
  );
  expect(await marker()).toEqual({ in_progress: 0, write_operation: null });
});

it("settles a completed operation only on explicit resume", async () => {
  await expect(
    runOperation(
      env,
      () => undefined,
      async (operation) => {
        await operation.write("test:done");
        throw new Error("crashed before clearing the marker");
      },
    ),
  ).rejects.toThrow();

  await expect(
    runOperation(
      env,
      () => undefined,
      (operation) => operation.settle("test:done", false),
    ),
  ).rejects.toThrow("still holds the write marker");
  expect(await marker()).toEqual({ in_progress: 1, write_operation: "test:done" });

  await runOperation(
    env,
    () => undefined,
    (operation) => operation.settle("test:done", true),
  );
  expect(await marker()).toEqual({ in_progress: 0, write_operation: null });

  // With nothing stranded, settling is a no-op.
  await runOperation(
    env,
    () => undefined,
    (operation) => operation.settle("test:done", false),
  );
});
