import { Schema } from "effect";
import { fetchPlayerStats } from "fitzroy";
import { runFitzroy } from "../src/lib/fitzroy";
import { normaliseTeam } from "../src/lib/normalise";
import { queryD1 } from "./lib/d1";

const COMPETITION = "AFLM" as const;

const DbMatchSchema = Schema.Struct({
  id: Schema.Number,
  date: Schema.String,
  home: Schema.String,
  away: Schema.String,
});

const DbRosterSchema = Schema.Struct({
  match_id: Schema.Number,
  player_id: Schema.Number,
  first_name: Schema.NullOr(Schema.String),
  surname: Schema.String,
  team: Schema.String,
});
type DbRoster = typeof DbRosterSchema.Type;

function teamDateKey(date: string, team: string): string {
  return `${date}|${normaliseTeam(team)}`;
}

function playerKey(matchId: number, team: string, first: string, surname: string): string {
  return `${matchId}|${normaliseTeam(team)}|${first.trim()}|${surname.trim()}`;
}

function extractStatsDate(statsMatchId: string): string | null {
  const yyyymmdd = statsMatchId.slice(-8);
  if (!/^\d{8}$/.test(yyyymmdd)) return null;
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

async function main() {
  for (const year of [2022, 2023, 2024, 2025]) {
    console.log(`\n=== ${year} ===`);
    const matches = queryD1(
      `SELECT m.id, m.date, t1.name AS home, t2.name AS away
       FROM matches m
       JOIN seasons s ON s.id = m.season_id
       JOIN teams t1 ON t1.id = m.home_team_id
       JOIN teams t2 ON t2.id = m.away_team_id
       WHERE s.year = ${year}`,
      DbMatchSchema,
    );
    const matchByTeamDate = new Map<string, number>();
    for (const m of matches) {
      matchByTeamDate.set(teamDateKey(m.date, m.home), m.id);
      matchByTeamDate.set(teamDateKey(m.date, m.away), m.id);
    }

    const roster = queryD1(
      `SELECT pms.match_id, pms.player_id, p.first_name, p.surname, t.name AS team
       FROM player_match_stats pms
       JOIN matches m ON m.id = pms.match_id
       JOIN seasons s ON s.id = m.season_id
       JOIN players p ON p.id = pms.player_id
       JOIN teams t ON t.id = pms.team_id
       WHERE s.year = ${year}`,
      DbRosterSchema,
    );
    const rosterMap = new Map<string, number>();
    const teamRosterByMatch = new Map<string, DbRoster[]>();
    for (const r of roster) {
      const first = (r.first_name ?? "").trim();
      rosterMap.set(playerKey(r.match_id, r.team, first, r.surname), r.player_id);
      const k = `${r.match_id}|${normaliseTeam(r.team)}`;
      const list = teamRosterByMatch.get(k) ?? [];
      list.push(r);
      teamRosterByMatch.set(k, list);
    }

    const stats = await runFitzroy(
      fetchPlayerStats({
        source: "afl-tables",
        season: year,
        competition: COMPETITION,
      }),
    );
    if (!stats.success) {
      console.log(`  fitzroy fetch failed: ${stats.error.message}`);
      continue;
    }

    for (const s of stats.data.stats) {
      if (s.brownlowVotes === null || s.brownlowVotes === 0) continue;
      const date = extractStatsDate(s.matchId);
      if (!date) continue;
      const matchId = matchByTeamDate.get(teamDateKey(date, s.team));
      if (!matchId) continue;
      const exact = rosterMap.get(playerKey(matchId, s.team, s.givenName, s.surname));
      if (exact) continue;

      // Unresolved — show the team roster to help fix
      const teamKey = `${matchId}|${normaliseTeam(s.team)}`;
      const teamRoster = teamRosterByMatch.get(teamKey) ?? [];
      const surnameMatches = teamRoster.filter(
        (r) => r.surname.trim().toLowerCase() === s.surname.trim().toLowerCase(),
      );
      console.log(
        `  match=${matchId} ${date} team=${s.team} fitzroy="${s.givenName} ${s.surname}" votes=${s.brownlowVotes}`,
      );
      if (surnameMatches.length > 0) {
        console.log(
          `    surname matches in team: ${surnameMatches.map((r) => `"${r.first_name ?? ""} ${r.surname}" (id=${r.player_id})`).join(", ")}`,
        );
      } else {
        console.log("    NO surname match in team roster");
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
