import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import { PavRepairRequestSchema, repairPav } from "../../src/admin/pav";
import { beginPublicInputWrite } from "../../src/db/public-inputs";
import { acquireOperationLease } from "../../src/sync/lease";

async function seed() {
  await env.DB.prepare(
    "INSERT INTO seasons(id,competition_id,year) VALUES(1,1,2026),(2,2,2022)",
  ).run();
}

it("requires a current preview and rejects ambiguous AFLW years before marking writes", async () => {
  await seed();
  await expect(
    repairPav(env, PavRepairRequestSchema.parse({ competition: "AFLW", season: 2022 })),
  ).rejects.toThrow("Ambiguous");
  const request = { competition: "AFLM", season: 2026 };
  const preview = await repairPav(env, PavRepairRequestSchema.parse(request));
  if (!("manifestDigest" in preview)) throw new Error("Expected a preview digest");
  await env.DB.prepare("INSERT INTO players(surname) VALUES('New input')").run();
  await expect(
    repairPav(
      env,
      PavRepairRequestSchema.parse({
        ...request,
        dryRun: false,
        manifestDigest: preview.manifestDigest,
      }),
    ),
  ).rejects.toThrow("stale");
  expect(
    await env.DB.prepare("SELECT in_progress FROM public_input_revision").first("in_progress"),
  ).toBe(0);
});

it("resumes only its exact season checkpoint and makes an idempotent replacement", async () => {
  await seed();
  const request = { competition: "AFLM", season: 2026 };
  const preview = await repairPav(env, PavRepairRequestSchema.parse(request));
  if (!("manifestDigest" in preview)) throw new Error("Expected a preview digest");
  await acquireOperationLease(env, "interrupted");
  await beginPublicInputWrite(env, "interrupted", new Date(), `pav:1:${preview.manifestDigest}`);
  await env.DB.prepare("UPDATE sync_lease SET acquired_at=datetime('now','-11 minutes')").run();
  const result = await repairPav(
    env,
    PavRepairRequestSchema.parse({
      ...request,
      dryRun: false,
      resume: true,
      manifestDigest: preview.manifestDigest,
    }),
  );
  expect(result).toMatchObject({ busy: false, rows: 0, season: { id: 1 } });
  expect(
    await env.DB.prepare("SELECT in_progress FROM public_input_revision").first("in_progress"),
  ).toBe(0);
  const next = await repairPav(env, PavRepairRequestSchema.parse(request));
  if (!("manifestDigest" in next)) throw new Error("Expected a preview digest");
  expect(
    await repairPav(
      env,
      PavRepairRequestSchema.parse({
        ...request,
        dryRun: false,
        manifestDigest: next.manifestDigest,
      }),
    ),
  ).toMatchObject({ rows: 0 });
});
