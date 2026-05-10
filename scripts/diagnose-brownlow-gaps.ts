import { execSync } from "node:child_process";
import type { PlayerStats } from "fitzroy";
import { fetchPlayerStats } from "fitzroy";
import { normaliseTeam } from "../src/lib/normalise";

const COMPETITION = "AFLM" as const;

interface DbMatch {
  id: number;
  date: string;
  home: string;
  away: string;
}

interface DbRoster {
  match_id: number;
  player_id: number;
  first_name: string | null;
  surname: string;
  team: string;
}

function queryD1<T>(sql: string): T[] {
  const escaped = sql.replace(/"/g, '\\"');
  const raw = execSync(`npx wrangler d1 execute afl-stats --remote --command "${escaped}" --json`, {
    encoding: "utf-8",
    maxBuffer: 50 * 1024 * 1024,
  });
  return JSON.parse(raw)[0]?.results ?? [];
}

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
    const matches = queryD1<DbMatch>(
      `SELECT m.id, m.date, t1.name AS home, t2.name AS away
       FROM matches m
       JOIN seasons s ON s.id = m.season_id
       JOIN teams t1 ON t1.id = m.home_team_id
       JOIN teams t2 ON t2.id = m.away_team_id
       WHERE s.year = ${year}`,
    );
    const matchByTeamDate = new Map<string, number>();
    for (const m of matches) {
      matchByTeamDate.set(teamDateKey(m.date, m.home), m.id);
      matchByTeamDate.set(teamDateKey(m.date, m.away), m.id);
    }

    const roster = queryD1<DbRoster>(
      `SELECT pms.match_id, pms.player_id, p.first_name, p.surname, t.name AS team
       FROM player_match_stats pms
       JOIN matches m ON m.id = pms.match_id
       JOIN seasons s ON s.id = m.season_id
       JOIN players p ON p.id = pms.player_id
       JOIN teams t ON t.id = pms.team_id
       WHERE s.year = ${year}`,
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

    const stats = await fetchPlayerStats({
      source: "afl-tables",
      season: year,
      competition: COMPETITION,
    });
    if (!stats.success) {
      console.log(`  fitzroy fetch failed: ${stats.error.message}`);
      continue;
    }

    for (const s of stats.data as readonly PlayerStats[]) {
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
