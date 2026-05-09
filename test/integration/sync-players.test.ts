import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { upsertPlayers } from "../../src/sync/upserts";

describe("upsertPlayers", () => {
  it("inserts a brand-new player keyed by external_afl_player_id", async () => {
    const map = await upsertPlayers(env, [
      { playerId: "P-1", givenName: "Patrick", surname: "Cripps" },
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
    expect(map.get("P-1")).toBeDefined();
  });

  it("returns a map of every player keyed by external_afl_player_id", async () => {
    const map = await upsertPlayers(env, [
      { playerId: "P-1", givenName: "Patrick", surname: "Cripps" },
      { playerId: "P-2", givenName: "Sam", surname: "Walsh" },
    ]);

    expect(map.size).toBe(2);
    expect(map.has("P-1")).toBe(true);
    expect(map.has("P-2")).toBe(true);
  });

  it("is idempotent on re-run with the same player", async () => {
    const player = { playerId: "P-1", givenName: "Patrick", surname: "Cripps" };
    await upsertPlayers(env, [player]);
    await upsertPlayers(env, [player]);

    const count = await env.DB.prepare("SELECT COUNT(*) as n FROM players").first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it("adopts a legacy fryzigg-only row by name match instead of inserting a duplicate", async () => {
    await env.DB.prepare("INSERT INTO players (first_name, surname, external_id) VALUES (?, ?, ?)")
      .bind("Patrick", "Cripps", "fryzigg-123")
      .run();

    await upsertPlayers(env, [{ playerId: "P-1", givenName: "Patrick", surname: "Cripps" }]);

    const rows = await env.DB.prepare(
      "SELECT first_name, surname, external_id, external_afl_player_id FROM players",
    ).all<{
      first_name: string;
      surname: string;
      external_id: string | null;
      external_afl_player_id: string | null;
    }>();
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

    await upsertPlayers(env, [{ playerId: "P-1", givenName: "Patrick", surname: "Cripps" }]);

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
