import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { syncPlayers } from "../../src/sync/sync-players";
import { makePlayerStats } from "./_fixtures";

describe("syncPlayers (current pipeline)", () => {
  it("inserts a brand-new player keyed by external_afl_player_id", async () => {
    await syncPlayers(env, [
      makePlayerStats({ playerId: "P-1", givenName: "Patrick", surname: "Cripps" }),
    ]);

    const rows = await env.DB.prepare(
      "SELECT first_name, surname, external_afl_player_id FROM players",
    ).all<{ first_name: string; surname: string; external_afl_player_id: string }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]).toEqual({
      first_name: "Patrick",
      surname: "Cripps",
      external_afl_player_id: "P-1",
    });
  });

  it("dedupes by playerId within the same batch (same player twice → one row)", async () => {
    await syncPlayers(env, [
      makePlayerStats({ playerId: "P-1", matchId: "M-1" }),
      makePlayerStats({ playerId: "P-1", matchId: "M-2" }),
    ]);

    const count = await env.DB.prepare("SELECT COUNT(*) as n FROM players").first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it("is idempotent on re-run with the same player", async () => {
    const stats = [makePlayerStats({ playerId: "P-1" })];
    await syncPlayers(env, stats);
    await syncPlayers(env, stats);

    const count = await env.DB.prepare("SELECT COUNT(*) as n FROM players").first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it("adopts a legacy fryzigg-only row by name match instead of inserting a duplicate", async () => {
    // Pre-seed a player as if imported from fryzigg (external_id set, no AFL id).
    await env.DB.prepare("INSERT INTO players (first_name, surname, external_id) VALUES (?, ?, ?)")
      .bind("Patrick", "Cripps", "fryzigg-123")
      .run();

    await syncPlayers(env, [
      makePlayerStats({ playerId: "P-1", givenName: "Patrick", surname: "Cripps" }),
    ]);

    const rows = await env.DB.prepare(
      "SELECT first_name, surname, external_id, external_afl_player_id FROM players",
    ).all<{
      first_name: string;
      surname: string;
      external_id: string | null;
      external_afl_player_id: string | null;
    }>();

    // One row — the fryzigg row was adopted, not duplicated.
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]).toEqual({
      first_name: "Patrick",
      surname: "Cripps",
      external_id: "fryzigg-123",
      external_afl_player_id: "P-1",
    });
  });

  it("does not adopt across distinct names (Patrick Cripps ≠ Tom Cripps)", async () => {
    await env.DB.prepare("INSERT INTO players (first_name, surname, external_id) VALUES (?, ?, ?)")
      .bind("Tom", "Cripps", "fryzigg-999")
      .run();

    await syncPlayers(env, [
      makePlayerStats({ playerId: "P-1", givenName: "Patrick", surname: "Cripps" }),
    ]);

    const rows = await env.DB.prepare(
      "SELECT first_name, external_id, external_afl_player_id FROM players ORDER BY first_name",
    ).all<{
      first_name: string;
      external_id: string | null;
      external_afl_player_id: string | null;
    }>();

    expect(rows.results).toHaveLength(2);
    expect(rows.results[0]?.first_name).toBe("Patrick");
    expect(rows.results[0]?.external_id).toBeNull();
    expect(rows.results[0]?.external_afl_player_id).toBe("P-1");
    expect(rows.results[1]?.first_name).toBe("Tom");
    expect(rows.results[1]?.external_id).toBe("fryzigg-999");
    expect(rows.results[1]?.external_afl_player_id).toBeNull();
  });
});
