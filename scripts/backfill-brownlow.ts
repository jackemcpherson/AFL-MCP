import { execSync } from "node:child_process";
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PlayerStats } from "fitzroy";
import { fetchPlayerStats } from "fitzroy";
import { normaliseTeam } from "../src/lib/normalise";

const SQL_DIR = join(__dirname, "..", "data", "sql-brownlow");
mkdirSync(SQL_DIR, { recursive: true });

const BATCH_SIZE = 200;
const COMPETITION = "AFLM" as const;
const MIN_BROWNLOW_YEAR = 1990;

function writeBatchedSQL(prefix: string, statements: string[]): number {
  for (const f of readdirSync(SQL_DIR).filter((f) => f.startsWith(`${prefix}_`))) {
    unlinkSync(join(SQL_DIR, f));
  }
  let fileIndex = 0;
  for (let i = 0; i < statements.length; i += BATCH_SIZE) {
    const batch = statements.slice(i, i + BATCH_SIZE);
    const sql = `${batch.join(";\n")};\n`;
    const path = join(SQL_DIR, `${prefix}_${String(fileIndex).padStart(4, "0")}.sql`);
    writeFileSync(path, sql);
    fileIndex++;
  }
  return fileIndex;
}

function queryD1<T>(sql: string): T[] {
  const escaped = sql.replace(/"/g, '\\"');
  const raw = execSync(`npx wrangler d1 execute afl-stats --remote --command "${escaped}" --json`, {
    encoding: "utf-8",
    maxBuffer: 50 * 1024 * 1024,
  });
  const parsed = JSON.parse(raw);
  return parsed[0]?.results ?? [];
}

function executeSQL(filePath: string): void {
  execSync(`npx wrangler d1 execute afl-stats --remote --file "${filePath}"`, {
    encoding: "utf-8",
    maxBuffer: 50 * 1024 * 1024,
  });
}

function teamDateKey(date: string, team: string): string {
  return `${date}|${normaliseTeam(team)}`;
}

function playerKey(matchId: number, team: string, first: string, surname: string): string {
  return `${matchId}|${normaliseTeam(team)}|${first.trim()}|${surname.trim()}`;
}

/** Lowercase and strip non-alphanumerics — collapses apostrophes, hyphens, dots, spaces. */
function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Stats matchIds from fitzroy's afl-tables source are 15-char fixed-width:
 * `AT_<4-digit-team-pair-code><YYYYMMDD>`. The trailing 8 chars are the local
 * match date. fetchMatches uses a different matchId format (`AT_<season>_<n>`),
 * so we bridge stats → DB by (date, team) instead — a team plays at most once
 * per day.
 */
function extractStatsDate(statsMatchId: string): string | null {
  const yyyymmdd = statsMatchId.slice(-8);
  if (!/^\d{8}$/.test(yyyymmdd)) return null;
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

interface DbMatch {
  id: number;
  date: string;
  home: string;
  away: string;
}

interface DbPlayerRoster {
  match_id: number;
  player_id: number;
  first_name: string | null;
  surname: string;
  team: string;
}

async function main() {
  const args = process.argv.slice(2);
  const startYear = args.includes("--start")
    ? Number(args[args.indexOf("--start") + 1])
    : MIN_BROWNLOW_YEAR;
  const endYear = args.includes("--end")
    ? Number(args[args.indexOf("--end") + 1])
    : new Date().getFullYear() - 1;
  const dryRun = args.includes("--dry-run");

  console.log(
    `Brownlow backfill: AFLM seasons ${startYear}-${endYear}${dryRun ? " (dry run)" : ""}`,
  );

  let totalUpdates = 0;
  let totalUnresolvedMatch = 0;
  let totalUnresolvedPlayer = 0;
  const sqlStatements: string[] = [];

  for (let year = startYear; year <= endYear; year++) {
    const seasonResult = await runSeason(year);
    if (seasonResult === null) continue;
    sqlStatements.push(...seasonResult.statements);
    totalUpdates += seasonResult.statements.length;
    totalUnresolvedMatch += seasonResult.unresolvedMatch;
    totalUnresolvedPlayer += seasonResult.unresolvedPlayer;
  }

  console.log(
    `\nTotals: ${totalUpdates} updates, ${totalUnresolvedMatch} unresolved matches, ${totalUnresolvedPlayer} unresolved players`,
  );

  if (sqlStatements.length === 0) {
    console.log("Nothing to write.");
    return;
  }

  const fileCount = writeBatchedSQL("brownlow", sqlStatements);
  console.log(`\nWrote ${fileCount} SQL files to ${SQL_DIR}`);

  if (dryRun) {
    console.log("Dry run: skipping execution. Inspect the SQL files and re-run without --dry-run.");
    return;
  }

  console.log("\nApplying SQL files to remote D1...");
  const files = readdirSync(SQL_DIR)
    .filter((f) => f.startsWith("brownlow_") && f.endsWith(".sql"))
    .sort();
  for (const f of files) {
    process.stdout.write(`  ${f} `);
    executeSQL(join(SQL_DIR, f));
    console.log("✓");
  }
  console.log("\nDone.");
}

interface SeasonResult {
  statements: string[];
  unresolvedMatch: number;
  unresolvedPlayer: number;
}

async function runSeason(year: number): Promise<SeasonResult | null> {
  process.stdout.write(`  ${year}: `);

  const dbMatchRows = queryD1<DbMatch>(
    `SELECT m.id, m.date, t1.name AS home, t2.name AS away
     FROM matches m
     JOIN seasons s ON s.id = m.season_id
     JOIN teams t1 ON t1.id = m.home_team_id
     JOIN teams t2 ON t2.id = m.away_team_id
     WHERE s.year = ${year}`,
  );
  if (dbMatchRows.length === 0) {
    console.log("no DB matches, skipping");
    return null;
  }
  const dbMatchByTeamDate = new Map<string, number>();
  for (const r of dbMatchRows) {
    dbMatchByTeamDate.set(teamDateKey(r.date, r.home), r.id);
    dbMatchByTeamDate.set(teamDateKey(r.date, r.away), r.id);
  }

  const dbRosterRows = queryD1<DbPlayerRoster>(
    `SELECT pms.match_id, pms.player_id, p.first_name, p.surname, t.name AS team
     FROM player_match_stats pms
     JOIN matches m ON m.id = pms.match_id
     JOIN seasons s ON s.id = m.season_id
     JOIN players p ON p.id = pms.player_id
     JOIN teams t ON t.id = pms.team_id
     WHERE s.year = ${year}`,
  );
  const rosterMap = new Map<string, number>();
  const rosterMapNorm = new Map<string, number>();
  const teamSurnameRoster = new Map<string, Array<{ playerId: number; normFirst: string }>>();
  const seasonFallback = new Map<string, number[]>();
  for (const r of dbRosterRows) {
    const first = (r.first_name ?? "").trim();
    rosterMap.set(playerKey(r.match_id, r.team, first, r.surname), r.player_id);
    const normFirst = normalizeName(first);
    const normSurname = normalizeName(r.surname);
    const teamNorm = normaliseTeam(r.team);
    rosterMapNorm.set(`${r.match_id}|${teamNorm}|${normFirst}|${normSurname}`, r.player_id);
    const teamSurnameKey = `${r.match_id}|${teamNorm}|${normSurname}`;
    const list = teamSurnameRoster.get(teamSurnameKey) ?? [];
    list.push({ playerId: r.player_id, normFirst });
    teamSurnameRoster.set(teamSurnameKey, list);
    const fallbackKey = `${r.surname.trim()}|${first}`;
    const list2 = seasonFallback.get(fallbackKey) ?? [];
    if (!list2.includes(r.player_id)) list2.push(r.player_id);
    seasonFallback.set(fallbackKey, list2);
  }

  const statsResult = await fetchPlayerStats({
    source: "afl-tables",
    season: year,
    competition: COMPETITION,
  });
  if (!statsResult.success) {
    console.log(`fetchPlayerStats failed (${statsResult.error.message}), skipping`);
    return null;
  }

  const statements: string[] = [];
  let unresolvedMatch = 0;
  let unresolvedPlayer = 0;

  for (const s of statsResult.data as readonly PlayerStats[]) {
    if (s.brownlowVotes === null) continue;

    const date = extractStatsDate(s.matchId);
    if (!date) {
      unresolvedMatch++;
      continue;
    }
    const dbMatchId = dbMatchByTeamDate.get(teamDateKey(date, s.team));
    if (!dbMatchId) {
      unresolvedMatch++;
      continue;
    }

    let dbPlayerId = rosterMap.get(playerKey(dbMatchId, s.team, s.givenName, s.surname));
    if (!dbPlayerId) {
      // Normalised exact match — handles apostrophes (O'Brien/OBrien) and case (de Goey/De Goey).
      const normFirst = normalizeName(s.givenName);
      const normSurname = normalizeName(s.surname);
      const teamNorm = normaliseTeam(s.team);
      dbPlayerId = rosterMapNorm.get(`${dbMatchId}|${teamNorm}|${normFirst}|${normSurname}`);
      if (!dbPlayerId) {
        // Surname-on-team match — disambiguate by first-name prefix or 3-char stem.
        // Handles nickname differences (Matt/Matthew, Josh/Joshua, Harry/Harrison)
        // and ambiguous surnames within a team (Bailey Williams vs Jack Williams).
        const candidates = teamSurnameRoster.get(`${dbMatchId}|${teamNorm}|${normSurname}`) ?? [];
        if (candidates.length === 1) {
          dbPlayerId = candidates[0]?.playerId;
        } else if (candidates.length > 1) {
          const prefixMatch = candidates.find(
            (c) => c.normFirst.startsWith(normFirst) || normFirst.startsWith(c.normFirst),
          );
          if (prefixMatch) {
            dbPlayerId = prefixMatch.playerId;
          } else {
            const stem = normFirst.slice(0, 3);
            const stemMatches = candidates.filter((c) => c.normFirst.startsWith(stem));
            if (stemMatches.length === 1) dbPlayerId = stemMatches[0]?.playerId;
          }
        }
      }
    }
    if (!dbPlayerId) {
      const fallback = seasonFallback.get(`${s.surname.trim()}|${s.givenName.trim()}`);
      if (fallback && fallback.length === 1) dbPlayerId = fallback[0];
    }
    if (!dbPlayerId) {
      unresolvedPlayer++;
      continue;
    }

    statements.push(
      `UPDATE player_match_stats SET brownlow_votes = ${s.brownlowVotes} WHERE match_id = ${dbMatchId} AND player_id = ${dbPlayerId} AND (brownlow_votes IS NULL OR brownlow_votes = 0)`,
    );
  }

  console.log(
    `votes=${statements.length} unresolved_match=${unresolvedMatch} unresolved_player=${unresolvedPlayer}`,
  );
  return { statements, unresolvedMatch, unresolvedPlayer };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
