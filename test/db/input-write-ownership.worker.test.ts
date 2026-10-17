import { env } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import {
  beginPublicInputWrite,
  finishPublicInputWrite,
  protectOperationWrites,
  publicInputWriteFence,
  resumePublicInputWrite,
} from "../../src/db/public-inputs";
import { acquireOperationLease, releaseOperationLease } from "../../src/sync/lease";

it("rejects writers without an active lease", async () => {
  await expect(beginPublicInputWrite(env, "missing")).rejects.toThrow("active lease");
});

it("retains an abandoned marker and prevents stale owners clearing a successor", async () => {
  expect(await acquireOperationLease(env, "first")).toBe(true);
  await beginPublicInputWrite(env, "first");
  await env.DB.prepare("UPDATE sync_lease SET acquired_at = datetime('now', '-11 minutes')").run();
  await expect(finishPublicInputWrite(env, "first")).rejects.toThrow("lease lost");
  expect(await acquireOperationLease(env, "second")).toBe(true);
  await expect(beginPublicInputWrite(env, "second")).rejects.toThrow("recovered public marker");
  await releaseOperationLease(env, "first");
  expect(await env.DB.prepare("SELECT holder FROM sync_lease").first("holder")).toBe("second");
  // Simulate explicit operator recovery after validating the abandoned checkpoint.
  await env.DB.prepare(
    "UPDATE public_input_revision SET in_progress = 0, write_holder = NULL",
  ).run();
  await beginPublicInputWrite(env, "second");
  await expect(finishPublicInputWrite(env, "first")).rejects.toThrow("lease lost");
  expect(
    await env.DB.prepare("SELECT in_progress FROM public_input_revision").first("in_progress"),
  ).toBe(1);
  await finishPublicInputWrite(env, "second");
  expect(
    await env.DB.prepare("SELECT in_progress FROM public_input_revision").first("in_progress"),
  ).toBe(0);
});

it("resumes only the named checkpoint and keeps readers blocked until completion", async () => {
  expect(await acquireOperationLease(env, "interrupted")).toBe(true);
  await beginPublicInputWrite(env, "interrupted", new Date(), "identity:approved");
  await env.DB.prepare("UPDATE sync_lease SET acquired_at=datetime('now', '-11 minutes')").run();
  expect(await acquireOperationLease(env, "recovery")).toBe(true);
  await expect(resumePublicInputWrite(env, "recovery", "identity:other")).rejects.toThrow(
    "matching operation",
  );
  await resumePublicInputWrite(env, "recovery", "identity:approved");
  expect(
    await env.DB.prepare("SELECT in_progress FROM public_input_revision").first("in_progress"),
  ).toBe(1);
  await expect(finishPublicInputWrite(env, "interrupted")).rejects.toThrow("lease lost");
  await finishPublicInputWrite(env, "recovery");
  expect(
    await env.DB.prepare("SELECT write_operation FROM public_input_revision").first(
      "write_operation",
    ),
  ).toBeNull();
});

it("rolls back an expired owner's whole mutation batch", async () => {
  expect(await acquireOperationLease(env, "expired")).toBe(true);
  await beginPublicInputWrite(env, "expired");
  await env.DB.prepare("UPDATE sync_lease SET acquired_at=datetime('now', '-11 minutes')").run();
  await expect(
    env.DB.batch([
      publicInputWriteFence(env, "expired"),
      env.DB.prepare("INSERT INTO players(surname) VALUES('Must not commit')"),
    ]),
  ).rejects.toThrow("CHECK constraint failed");
  expect(await env.DB.prepare("SELECT count(*) AS n FROM players").first("n")).toBe(0);
  expect(
    await env.DB.prepare("SELECT in_progress FROM public_input_revision").first("in_progress"),
  ).toBe(1);
});

it("fences bound statements and batches after a successor resumes", async () => {
  expect(await acquireOperationLease(env, "original")).toBe(true);
  await beginPublicInputWrite(env, "original", new Date(), "test:checkpoint");
  const writer = protectOperationWrites(env, "original");
  const insert = writer.DB.prepare("INSERT INTO players(surname) VALUES(?1)");
  await insert.bind("Before interruption").run();
  expect(await writer.DB.prepare("SELECT surname FROM players").first("surname")).toBe(
    "Before interruption",
  );
  const rows = await writer.DB.prepare("SELECT surname FROM players").all();
  expect(rows.results).toEqual([{ surname: "Before interruption" }]);
  await writer.DB.batch([insert.bind("Second"), insert.bind("Third")]);
  await env.DB.prepare("UPDATE sync_lease SET acquired_at=datetime('now', '-11 minutes')").run();
  expect(await acquireOperationLease(env, "successor")).toBe(true);
  await resumePublicInputWrite(env, "successor", "test:checkpoint");
  await expect(insert.bind("Stale run").run()).rejects.toThrow("CHECK constraint failed");
  await expect(
    writer.DB.batch([insert.bind("Stale batch"), insert.bind("Also stale")]),
  ).rejects.toThrow("CHECK constraint failed");
  expect(await env.DB.prepare("SELECT count(*) AS n FROM players").first("n")).toBe(3);
  expect(
    await env.DB.prepare("SELECT write_holder FROM public_input_revision").first("write_holder"),
  ).toBe("successor");
  await finishPublicInputWrite(env, "successor");
});

afterEach(() => vi.restoreAllMocks());

async function retryWriter() {
  await acquireOperationLease(env, "read-retry");
  await beginPublicInputWrite(env, "read-retry", new Date(), "test:read-retry");
  return protectOperationWrites(env, "read-retry");
}

it("retries a bound SELECT after a lost response to a committed fence", async () => {
  const writer = await retryWriter();
  const original = env.DB.batch.bind(env.DB);
  const batch = vi.spyOn(env.DB, "batch").mockImplementationOnce(async (statements) => {
    await original(statements);
    throw new Error("D1_ERROR: Network connection lost.");
  });
  expect(await writer.DB.prepare("SELECT ?1 AS answer").bind(42).first("answer")).toBe(42);
  expect(batch).toHaveBeenCalledTimes(2);
  expect(
    await env.DB.prepare("SELECT write_holder FROM public_input_revision").first("write_holder"),
  ).toBe("read-retry");
});

it("bounds exhausted read retries and retains the recovery marker", async () => {
  const writer = await retryWriter();
  const batch = vi
    .spyOn(env.DB, "batch")
    .mockRejectedValue(new Error("D1_ERROR: Network connection lost."));
  await expect(writer.DB.prepare("SELECT 1 AS answer").all()).rejects.toThrow(
    "Network connection lost",
  );
  expect(batch).toHaveBeenCalledTimes(3);
  expect(
    await env.DB.prepare("SELECT in_progress FROM public_input_revision").first("in_progress"),
  ).toBe(1);
});

it("rechecks ownership after a transient read failure", async () => {
  const writer = await retryWriter();
  const batch = vi.spyOn(env.DB, "batch").mockImplementationOnce(async () => {
    await env.DB.prepare("UPDATE sync_lease SET acquired_at=datetime('now','-11 minutes')").run();
    throw new Error("D1_ERROR: Network connection lost.");
  });
  await expect(writer.DB.prepare("SELECT 1 AS answer").first()).rejects.toThrow(
    "CHECK constraint failed",
  );
  expect(batch).toHaveBeenCalledTimes(2);
  expect(
    await env.DB.prepare("SELECT in_progress FROM public_input_revision").first("in_progress"),
  ).toBe(1);
});

it("does not retry non-network failures or mutation-returning reads", async () => {
  const writer = await retryWriter();
  const batch = vi
    .spyOn(env.DB, "batch")
    .mockRejectedValueOnce(new Error("D1_ERROR: syntax error"));
  await expect(writer.DB.prepare("SELECT 1").all()).rejects.toThrow("syntax error");
  expect(batch).toHaveBeenCalledTimes(1);
  batch.mockRejectedValue(new Error("D1_ERROR: Network connection lost."));
  await expect(
    writer.DB.prepare("INSERT INTO players(surname) VALUES('Do not replay') RETURNING id").first(),
  ).rejects.toThrow("Network connection lost");
  await expect(
    writer.DB.prepare("INSERT INTO players(surname) VALUES('Do not replay') RETURNING id").all(),
  ).rejects.toThrow("Network connection lost");
  await expect(
    writer.DB.prepare("INSERT INTO players(surname) VALUES('Do not replay')").run(),
  ).rejects.toThrow("Network connection lost");
  await expect(writer.DB.batch([writer.DB.prepare("SELECT 1")])).rejects.toThrow(
    "Network connection lost",
  );
  expect(batch).toHaveBeenCalledTimes(5);
  expect(await env.DB.prepare("SELECT count(*) AS n FROM players").first("n")).toBe(0);
});
