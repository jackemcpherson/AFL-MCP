import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getSchemaInfo } from "../../../src/mcp/tools/schema";

/**
 * The `schema` tool's example queries run against the migrated D1 schema
 * with fixture rows shaped like the production cases they must handle.
 */

/** Run one named `common_joins` example with its documented binds. */
async function runExample(
  name: string,
  ...binds: readonly (string | number)[]
): Promise<Record<string, unknown>[]> {
  const joins: Record<string, string> = (await getSchemaInfo()).database.common_joins;
  const sql = joins[name];
  if (sql === undefined) throw new Error(`no example ${name}`);
  const result = await env.DB.prepare(sql)
    .bind(...binds)
    .all<Record<string, unknown>>();
  return result.results;
}

/** Insert a row and return its id. */
async function insert(sql: string, ...binds: readonly (string | number)[]): Promise<number> {
  const row = await env.DB.prepare(`${sql} RETURNING id`)
    .bind(...binds)
    .first<{ id: number }>();
  if (row === null) throw new Error(`insert returned no row: ${sql}`);
  return row.id;
}

/** The seeded id of a competition code. */
async function competitionId(code: string): Promise<number> {
  const row = await env.DB.prepare("SELECT id FROM competitions WHERE code = ?")
    .bind(code)
    .first<{ id: number }>();
  if (row === null) throw new Error(`competition ${code} is not seeded`);
  return row.id;
}

describe("lineup_round_comparison example", () => {
  // Collingwood AFLW 2024 played Week 4 twice: 17 and 22 September.
  async function doubleGameWeek() {
    const aflw = await competitionId("AFLW");
    const season = await insert(
      "INSERT INTO seasons (competition_id, year, season_key) VALUES (?, 2024, '2024')",
      aflw,
    );
    const team = (name: string) =>
      insert("INSERT INTO teams (name, competition_id) VALUES (?, ?)", name, aflw);
    const collingwood = await team("Collingwood");
    const opponents = [await team("Carlton"), await team("Essendon"), await team("Richmond")];
    const fixtures = [
      { id: 180747, date: "2024-09-13", round: "Week 3", roundNumber: 3 },
      { id: 180755, date: "2024-09-17", round: "Week 4", roundNumber: 4 },
      { id: 180763, date: "2024-09-22", round: "Week 4", roundNumber: 4 },
    ];
    for (const [i, f] of fixtures.entries()) {
      await env.DB.prepare(
        "INSERT INTO matches (id, season_id, round, round_number, round_type, date, home_team_id, away_team_id, status) VALUES (?, ?, ?, ?, 'Regular', ?, ?, ?, 'Complete')",
      )
        .bind(f.id, season, f.round, f.roundNumber, f.date, collingwood, opponents[i] ?? 0)
        .run();
    }
    const names = [
      "Ruby Schleicher",
      "Ash Brazill",
      "Brittany Bonnici",
      "Erica Fowler",
      "Brianna Davey",
      "Mikala Cann",
      "Sarah Sansonetti",
      "Eleri Morris",
      "Charlotte Taylor",
      "Tarni White",
      "Sarah Ingram",
    ];
    const players = new Map<string, number>();
    for (const name of names) {
      const [first, surname] = name.split(" ");
      players.set(
        name,
        await insert(
          "INSERT INTO players (first_name, surname) VALUES (?, ?)",
          first ?? "",
          surname ?? "",
        ),
      );
    }
    const lineups = [
      { matchId: 180747, lineup: names.slice(0, 7) },
      {
        matchId: 180755,
        lineup: [...names.slice(0, 2), ...names.slice(4, 7), "Eleri Morris", "Charlotte Taylor"],
      },
      {
        matchId: 180763,
        lineup: [
          ...names.slice(0, 2),
          "Eleri Morris",
          "Charlotte Taylor",
          "Erica Fowler",
          "Tarni White",
          "Sarah Ingram",
        ],
      },
    ];
    for (const { matchId, lineup } of lineups) {
      for (const name of lineup) {
        await env.DB.prepare(
          "INSERT INTO match_lineups (match_id, player_id, team_id, position) VALUES (?, ?, ?, 'INT')",
        )
          .bind(matchId, players.get(name) ?? 0, collingwood)
          .run();
      }
    }
    // An emergency named for the second Week 4 match is not a change.
    await env.DB.prepare(
      "INSERT INTO match_lineups (match_id, player_id, team_id, position, is_emergency) VALUES (180763, ?, ?, 'EMERG', 1)",
    )
      .bind(players.get("Brianna Davey") ?? 0, collingwood)
      .run();
    // The opponent's lineup in a compared match is not Collingwood's change.
    await env.DB.prepare(
      "INSERT INTO match_lineups (match_id, player_id, team_id, position) VALUES (180755, ?, ?, 'FF')",
    )
      .bind(
        await insert("INSERT INTO players (first_name, surname) VALUES ('Other', 'Player')"),
        opponents[1] ?? 0,
      )
      .run();
    return players;
  }

  function changes(rows: readonly Record<string, unknown>[], change: string): string[] {
    return rows
      .filter((row) => row["change"] === change)
      .map((row) => `${String(row["first_name"])} ${String(row["surname"])}`)
      .sort();
  }

  it("compares the first Week 4 match with Week 3: 2 in, 2 out", async () => {
    const players = await doubleGameWeek();
    const rows = await runExample("lineup_round_comparison", "AFLW", "Collingwood", 180755, 180747);
    expect(changes(rows, "IN")).toEqual(["Charlotte Taylor", "Eleri Morris"]);
    expect(changes(rows, "OUT")).toEqual(["Brittany Bonnici", "Erica Fowler"]);
    for (const row of rows) {
      expect(row["player_id"]).toBe(
        players.get(`${String(row["first_name"])} ${String(row["surname"])}`),
      );
    }
    expect(rows.find((row) => row["change"] === "IN")).toMatchObject({
      match_id: 180755,
      date: "2024-09-17",
    });
    expect(rows.find((row) => row["change"] === "OUT")).toMatchObject({
      match_id: 180747,
      date: "2024-09-13",
    });
  });

  it("compares the two matches of one round: 3 in, 3 out", async () => {
    await doubleGameWeek();
    const rows = await runExample("lineup_round_comparison", "AFLW", "Collingwood", 180763, 180755);
    expect(changes(rows, "IN")).toEqual(["Erica Fowler", "Sarah Ingram", "Tarni White"]);
    expect(changes(rows, "OUT")).toEqual(["Brianna Davey", "Mikala Cann", "Sarah Sansonetti"]);
  });
});

describe("player_career_arc example", () => {
  it("labels AFLW 2022 Season 6 and Season 7 as separate rows", async () => {
    const aflw = await competitionId("AFLW");
    const team = await insert(
      "INSERT INTO teams (name, competition_id) VALUES ('Collingwood', ?)",
      aflw,
    );
    const opponent = await insert(
      "INSERT INTO teams (name, competition_id) VALUES ('Carlton', ?)",
      aflw,
    );
    const player = await insert(
      "INSERT INTO players (first_name, surname) VALUES ('Lauren', 'Brazzale')",
    );
    const seasons = [
      { key: "2022-S6", date: "2022-01-08", games: [10, 12] },
      { key: "2022-S7", date: "2022-08-27", games: [8, 9, 11] },
      { key: "2023", date: "2023-09-02", games: [7] },
    ];
    for (const season of seasons) {
      const seasonId = await insert(
        "INSERT INTO seasons (competition_id, year, season_key) VALUES (?, ?, ?)",
        aflw,
        Number(season.key.slice(0, 4)),
        season.key,
      );
      for (const [i, disposals] of season.games.entries()) {
        const matchId = await insert(
          "INSERT INTO matches (season_id, round, round_number, date, home_team_id, away_team_id, status) VALUES (?, ?, ?, date(?, ?), ?, ?, 'Complete')",
          seasonId,
          `Round ${i + 1}`,
          i + 1,
          season.date,
          `+${7 * i} days`,
          team,
          opponent,
        );
        await env.DB.prepare(
          "INSERT INTO player_match_stats (match_id, player_id, team_id, disposals, goals) VALUES (?, ?, ?, ?, 0)",
        )
          .bind(matchId, player, team, disposals)
          .run();
      }
    }

    const rows = await runExample("player_career_arc", "AFLW", player);

    expect(rows.map((row) => [row["season_key"], row["games"], row["total_disposals"]])).toEqual([
      ["2022-S6", 2, 22],
      ["2022-S7", 3, 28],
      ["2023", 1, 7],
    ]);
  });
});
