import { execSync } from "node:child_process";
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetchLineup } from "fitzroy";
import { normaliseTeam } from "../src/lib/normalise";

const SQL_DIR = join(__dirname, "..", "data", "sql-lineups");
mkdirSync(SQL_DIR, { recursive: true });

const BATCH_SIZE = 200;
const COMPETITION = "AFLM" as const;

interface DbMatch {
  id: number;
  external_afl_id: string;
}
interface DbPlayer {
  id: number;
  external_afl_player_id: string;
}
interface DbTeam {
  id: number;
  name: string;
}

function queryD1<T>(sql: string): T[] {
  const escaped = sql.replace(/"/g, '\\"');
  const raw = execSync(`npx wrangler d1 execute afl-stats --remote --command "${escaped}" --json`, {
    encoding: "utf-8",
    maxBuffer: 50 * 1024 * 1024,
  });
  return JSON.parse(raw)[0]?.results ?? [];
}

function executeSQL(filePath: string): void {
  execSync(`npx wrangler d1 execute afl-stats --remote --file "${filePath}"`, {
    encoding: "utf-8",
    maxBuffer: 50 * 1024 * 1024,
  });
}

function writeBatched(prefix: string, statements: string[]): number {
  for (const f of readdirSync(SQL_DIR).filter((f) => f.startsWith(`${prefix}_`))) {
    unlinkSync(join(SQL_DIR, f));
  }
  let i = 0;
  for (let start = 0; start < statements.length; start += BATCH_SIZE) {
    const batch = statements.slice(start, start + BATCH_SIZE);
    writeFileSync(
      join(SQL_DIR, `${prefix}_${String(i).padStart(4, "0")}.sql`),
      `${batch.join(";\n")};\n`,
    );
    i++;
  }
  return i;
}

function escapeSql(s: string | null): string {
  if (s === null) return "NULL";
  return `'${s.replace(/'/g, "''")}'`;
}

interface SeasonStats {
  rounds_fetched: number;
  rounds_failed: number;
  matches_processed: number;
  matches_unmatched: number;
  players_unmatched: number;
  delete_stmts: number;
  insert_stmts: number;
}

async function runSeason(year: number, maxRound: number, dryRun: boolean): Promise<SeasonStats> {
  console.log(`\n=== ${year} ===`);

  const matchRows = queryD1<DbMatch>(
    `SELECT m.id, m.external_afl_id FROM matches m
     JOIN seasons s ON s.id = m.season_id
     WHERE s.year = ${year} AND m.external_afl_id IS NOT NULL`,
  );
  const matchByExternalId = new Map(matchRows.map((r) => [r.external_afl_id, r.id]));

  const playerRows = queryD1<DbPlayer>(
    `SELECT id, external_afl_player_id FROM players WHERE external_afl_player_id IS NOT NULL`,
  );
  const playerByExternalId = new Map(playerRows.map((r) => [r.external_afl_player_id, r.id]));

  const teamRows = queryD1<DbTeam>(`SELECT id, name FROM teams`);
  const teamByName = new Map(teamRows.map((r) => [r.name, r.id]));

  const stats: SeasonStats = {
    rounds_fetched: 0,
    rounds_failed: 0,
    matches_processed: 0,
    matches_unmatched: 0,
    players_unmatched: 0,
    delete_stmts: 0,
    insert_stmts: 0,
  };
  const allStatements: string[] = [];

  for (let round = 1; round <= maxRound; round++) {
    process.stdout.write(`  R${round}: `);
    const r = await fetchLineup({
      source: "afl-api",
      season: year,
      round,
      competition: COMPETITION,
    });
    if (!r.success) {
      console.log(`FAILED (${r.error.message})`);
      stats.rounds_failed++;
      continue;
    }
    stats.rounds_fetched++;

    const roundDeletes: string[] = [];
    const roundInserts: string[] = [];
    for (const lineup of r.data) {
      const matchId = matchByExternalId.get(lineup.matchId);
      if (!matchId) {
        stats.matches_unmatched++;
        continue;
      }
      stats.matches_processed++;
      const homeTeamId = teamByName.get(normaliseTeam(lineup.homeTeam));
      const awayTeamId = teamByName.get(normaliseTeam(lineup.awayTeam));
      if (!homeTeamId || !awayTeamId) {
        stats.matches_unmatched++;
        continue;
      }

      roundDeletes.push(`DELETE FROM match_lineups WHERE match_id = ${matchId}`);

      const sides: Array<{ players: typeof lineup.homePlayers; teamId: number }> = [
        { players: lineup.homePlayers, teamId: homeTeamId },
        { players: lineup.awayPlayers, teamId: awayTeamId },
      ];
      for (const { players, teamId } of sides) {
        for (const p of players) {
          const playerId = playerByExternalId.get(p.playerId);
          if (!playerId) {
            stats.players_unmatched++;
            continue;
          }
          roundInserts.push(
            `INSERT INTO match_lineups (match_id, player_id, team_id, guernsey_number, position, is_emergency, is_substitute) VALUES (${matchId}, ${playerId}, ${teamId}, ${p.jumperNumber ?? "NULL"}, ${escapeSql(p.matchPosition)}, ${p.isEmergency ? 1 : 0}, ${p.isSubstitute ? 1 : 0})`,
          );
        }
      }
    }
    stats.delete_stmts += roundDeletes.length;
    stats.insert_stmts += roundInserts.length;
    // Order matters: deletes for the round must precede the inserts.
    allStatements.push(...roundDeletes, ...roundInserts);
    console.log(`${r.data.length} matches, ${roundInserts.length} inserts`);
  }

  if (allStatements.length === 0) return stats;

  const fileCount = writeBatched(`lineups_${year}`, allStatements);
  if (dryRun) {
    console.log(`  dry-run: wrote ${fileCount} SQL files (not applied)`);
    return stats;
  }
  const files = readdirSync(SQL_DIR)
    .filter((f) => f.startsWith(`lineups_${year}_`) && f.endsWith(".sql"))
    .sort();
  console.log(`  applying ${files.length} SQL files...`);
  for (const f of files) {
    process.stdout.write(`    ${f} `);
    executeSQL(join(SQL_DIR, f));
    console.log("✓");
  }
  return stats;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const startYear = args.includes("--start") ? Number(args[args.indexOf("--start") + 1]) : 2021;
  const endYear = args.includes("--end") ? Number(args[args.indexOf("--end") + 1]) : 2022;
  const maxRound = args.includes("--max-round")
    ? Number(args[args.indexOf("--max-round") + 1])
    : 27;
  console.log(
    `Lineup re-fetch: AFLM seasons ${startYear}-${endYear}, rounds 1-${maxRound}${dryRun ? " (dry run)" : ""}`,
  );
  for (let y = startYear; y <= endYear; y++) {
    const s = await runSeason(y, maxRound, dryRun);
    console.log(`  totals: ${JSON.stringify(s)}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
