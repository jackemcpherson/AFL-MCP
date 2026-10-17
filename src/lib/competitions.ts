/**
 * The four competition codes, defined once.
 *
 * fitzroy owns the canonical schema. Every request schema, tool definition
 * and status report in this Worker reads the codes from here.
 */

import { CompetitionCodeSchema } from "fitzroy";

export { CompetitionCodeSchema };

/** A competition code: `"AFLM"`, `"AFLW"`, `"VFL"` or `"VFLW"`. */
export type CompetitionCode = typeof CompetitionCodeSchema.Type;

/** Every competition code, in display order. */
export const COMPETITION_CODES: readonly CompetitionCode[] = CompetitionCodeSchema.literals;

/** Competitions for which the canonical HPN PAV formula can be computed. */
export const PavCompetitionSchema = CompetitionCodeSchema.pick(["AFLM", "AFLW"]);
