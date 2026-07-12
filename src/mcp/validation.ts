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

const COVERAGE_START_YEAR = { AFLM: 1990, AFLW: 2017, VFL: 2021, VFLW: 2021 } as const;

/** Optional arguments accepted by the existing schema tool. */
export const SchemaToolRequestSchema = z
  .object({
    includeObserved: z.boolean().optional().default(false),
    competition: z.enum(COMPETITION_CODE_VALUES).optional(),
    season: z.number().int().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.includeObserved) {
      if (value.competition !== undefined || value.season !== undefined) {
        context.addIssue({
          code: "custom",
          message: "competition and season require includeObserved=true",
        });
      }
      return;
    }
    if (value.competition === undefined || value.season === undefined) {
      context.addIssue({
        code: "custom",
        message: "observed coverage requires competition and season",
      });
      return;
    }
    const currentMelbourneYear = Number(
      new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Melbourne", year: "numeric" }).format(
        new Date(),
      ),
    );
    if (
      value.season < COVERAGE_START_YEAR[value.competition] ||
      value.season > currentMelbourneYear + 1
    ) {
      context.addIssue({
        code: "custom",
        message: "season is outside the competition coverage range",
      });
    }
  });

export type SchemaToolRequest = z.infer<typeof SchemaToolRequestSchema>;

/** Shape of POST /mcp/admin/backfill bodies. Range clamps live with the route. */
export const BackfillRequestSchema = z.object({
  competitions: z.array(z.enum(COMPETITION_CODE_VALUES)).min(1),
  fromYear: z.number().int(),
  toYear: z.number().int(),
  skipShouldRunNow: z.boolean().optional(),
  skipPav: z.boolean().optional(),
});

export type BackfillRequest = z.infer<typeof BackfillRequestSchema>;

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
