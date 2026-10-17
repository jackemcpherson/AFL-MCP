import { Schema } from "effect";
import { resolveStoredSeason } from "../db/seasons";
import { CompetitionCodeSchema } from "../lib/competitions";
import { strictDecoder } from "../lib/decode";
import {
  booleanDefault,
  PositiveIntSchema,
  SeasonSelectorSchema,
  Sha256HexSchema,
} from "../lib/schemas";
import { acquireOperationLease, releaseOperationLease } from "../sync/lease";
import type { Env } from "../types";
import { OperationConflictError } from "./errors";

/** Targeted retry of an unavailable observation after reviewing its stored diagnostic. */
export const WeatherRetryRequestSchema = Schema.Struct({
  competition: CompetitionCodeSchema,
  season: SeasonSelectorSchema,
  matchId: PositiveIntSchema,
  dryRun: booleanDefault(true),
  manifestDigest: Schema.optionalKey(Sha256HexSchema),
});

/** A validated weather retry request. */
export type WeatherRetryRequest = typeof WeatherRetryRequestSchema.Type;

/** Decode a weather retry body, rejecting unknown keys. */
export const decodeWeatherRetryRequest = strictDecoder(WeatherRetryRequestSchema);

/**
 * Preview and queue one match's weather retry without fetching unrelated matches.
 * @param env - Worker bindings.
 * @param request - Validated exact match and season scope.
 * @returns Diagnostic preview or count of reset retry schedules.

 * @throws If approval, recovery, lease ownership or a database operation fails.
 * @example
 * await retryWeather(env, Result.getOrThrow(decodeWeatherRetryRequest(body))); */
export async function retryWeather(env: Env, request: WeatherRetryRequest) {
  const holder = crypto.randomUUID();
  if (!(await acquireOperationLease(env, holder))) return { busy: true };
  try {
    const season = await resolveStoredSeason(env, request.competition, request.season);
    const rows =
      await env.DB.prepare(`SELECT r.* FROM weather_refresh_state r JOIN matches m ON m.id=r.match_id
      WHERE m.id=?1 AND m.season_id=?2 AND r.diagnostic IS NOT NULL ORDER BY r.kind,r.source`)
        .bind(request.matchId, season.id)
        .all();
    const digest = Array.from(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(JSON.stringify({ season, rows: rows.results })),
        ),
      ),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    if (request.dryRun)
      return {
        busy: false,
        dryRun: true,
        season,
        observations: rows.results,
        manifestDigest: digest,
      };
    if (!rows.results.length)
      throw new OperationConflictError({
        message: "No unresolved weather observations in this exact match scope",
      });
    if (request.manifestDigest !== digest)
      throw new OperationConflictError({ message: "Weather retry preview missing or stale" });
    const result =
      await env.DB.prepare(`UPDATE weather_refresh_state SET failures=0,next_retry_at=?1
      WHERE match_id=?2 AND diagnostic IS NOT NULL
      AND EXISTS(SELECT 1 FROM sync_lease WHERE id=1 AND holder=?3
        AND acquired_at>=datetime('now','-10 minutes')) RETURNING match_id`)
        .bind(new Date().toISOString(), request.matchId, holder)
        .all();
    if (result.results.length !== rows.results.length)
      throw new OperationConflictError({ message: "Weather retry lease lost or scope changed" });
    return { busy: false, dryRun: false, queued: result.results.length };
  } finally {
    await releaseOperationLease(env, holder);
  }
}
