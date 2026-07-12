/**
 * Zod schemas for the Worker's HTTP boundaries (MNT-02).
 *
 * Per the fleet style guide, external input is validated at the boundary
 * and trusted internally; types are inferred from the schemas.
 */

import { z } from "zod";

/** JSON-RPC 2.0 request envelope. */
export const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  // Notifications may omit id; default keeps response construction total.
  id: z.union([z.string(), z.number()]).default(0),
  method: z.string().min(1),
  params: z.record(z.string(), z.unknown()).optional(),
});

export type JsonRpcRequest = z.infer<typeof JsonRpcRequestSchema>;

export const COMPETITION_CODE_VALUES = ["AFLM", "AFLW", "VFL", "VFLW"] as const;

/** Shape of POST /mcp/admin/backfill bodies. Range clamps live with the route. */
export const BackfillRequestSchema = z.object({
  competitions: z.array(z.enum(COMPETITION_CODE_VALUES)).min(1),
  fromYear: z.number().int(),
  toYear: z.number().int(),
  skipShouldRunNow: z.boolean().optional(),
  skipPav: z.boolean().optional(),
});

export type BackfillRequest = z.infer<typeof BackfillRequestSchema>;

/** Shape of POST /mcp/admin/backfill-brownlow bodies. Range clamps live with the route. */
export const BrownlowBackfillRequestSchema = z.object({
  fromYear: z.number().int(),
  toYear: z.number().int(),
  dryRun: z.boolean().default(true),
});

export type BrownlowBackfillRequest = z.infer<typeof BrownlowBackfillRequestSchema>;

/**
 * Map the first Zod issue to the caller-facing message contract the
 * endpoint has always used (and the integration tests assert).
 */
export function describeBackfillIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  const root = issue?.path[0];
  if (root === "competitions") {
    return typeof issue?.path[1] === "number"
      ? "invalid competition code"
      : "competitions must be a non-empty array";
  }
  if (root === "fromYear") return "fromYear must be an integer";
  if (root === "toYear") return "toYear must be an integer";
  return issue?.message ?? "invalid request body";
}

/** Map the first Brownlow request issue to a stable caller-facing message. */
export function describeBrownlowBackfillIssue(error: z.ZodError): string {
  const root = error.issues[0]?.path[0];
  if (root === "fromYear") return "fromYear must be an integer";
  if (root === "toYear") return "toYear must be an integer";
  if (root === "dryRun") return "dryRun must be a boolean";
  return error.issues[0]?.message ?? "invalid request body";
}
