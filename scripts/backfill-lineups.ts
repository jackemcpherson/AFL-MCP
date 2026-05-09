import { execSync } from "node:child_process";
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Lineup } from "fitzroy";
import { fetchLineup } from "fitzroy";

const SQL_DIR = join(__dirname, "..", "data", "sql-lineups");
mkdirSync(SQL_DIR, { recursive: true });

const BATCH_SIZE = 200;
const COMPETITION = "AFLM" as const;
const MIN_LINEUP_YEAR = 2015;

// ── Helpers ──────────────────────────────────────────────────────────

function escapeSQL(value: string | number | null | undefined): string {
  if (value == null) return "NULL";
  if (typeof value === "number") return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
}

function writeBatchedSQL(prefix: string, statements: string[]): number {
  // Clean old files for this prefix
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

// ── Team name normalisation (matches constants.ts) ──────────────────

const TEAM_NAME_MAP: Record<string, string> = {
  "Greater Western Sydney": "GWS Giants",
  GWS: "GWS Giants",
  "GWS GIANTS": "GWS Giants",
  "Brisbane Bears": "Brisbane Lions",
  Brisbane: "Brisbane Lions",
  Footscray: "Western Bulldogs",
  "Sydney Swans": "Sydney",
  "Geelong Cats": "Geelong",
  "Adelaide Crows": "Adelaide",
  "West Coast Eagles": "West Coast",
  "Gold Coast SUNS": "Gold Coast",
  "Gold Coast Suns": "Gold Coast",
};

function normaliseTeam(name: string): string {
  return TEAM_NAME_MAP[name.trim()] ?? name.trim();
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const startYear = args.includes("--start")
    ? Number(args[args.indexOf("--start") + 1])
    : MIN_LINEUP_YEAR;
  const endYear = args.includes("--end")
    ? Number(args[args.indexOf("--end") + 1])
    : new Date().getFullYear() - 1;
  const dryRun = args.includes("--dry-run");

  console.log(`Lineup backfill: seasons ${startYear}-${endYear}${dryRun ? " (dry run)" : ""}`);

  // Load lookup maps from D1
  console.log("Loading team mappings from D1...");
  const teamRows = queryD1<{ id: number; name: string }>("SELECT id, name FROM teams");
  const teamMap = new Map<string, number>();
  for (const r of teamRows) teamMap.set(r.name, r.id);
  console.log(`  ${teamMap.size} teams loaded`);

  console.log("Loading player mappings from D1...");
  const playerRows = queryD1<{ id: number; external_afl_player_id: string }>(
    "SELECT id, external_afl_player_id FROM players WHERE external_afl_player_id IS NOT NULL",
  );
  const playerMap = new Map<string, number>();
  for (const r of playerRows) playerMap.set(r.external_afl_player_id, r.id);
  console.log(`  ${playerMap.size} players loaded`);

  console.log("Loading match mappings from D1...");
  const matchRows = queryD1<{ id: number; external_afl_id: string }>(
    "SELECT id, external_afl_id FROM matches WHERE external_afl_id IS NOT NULL",
  );
  const matchMap = new Map<string, number>();
  for (const r of matchRows) matchMap.set(r.external_afl_id, r.id);
  console.log(`  ${matchMap.size} matches loaded`);

  // Phase 1: Fetch all lineup data from API and cache in memory
  console.log("\nFetching lineup data from AFL API...");
  const allLineups: Lineup[] = [];
  let fetchErrors = 0;

  for (let year = startYear; year <= endYear; year++) {
    const seasonRounds = queryD1<{ round_number: number }>(
      `SELECT DISTINCT round_number FROM matches m
       JOIN seasons s ON m.season_id = s.id
       WHERE s.year = ${year} AND round_number IS NOT NULL
       ORDER BY round_number`,
    );

    if (seasonRounds.length === 0) {
      console.log(`  ${year}: no matches found, skipping`);
      continue;
    }

    process.stdout.write(`  ${year}: ${seasonRounds.length} rounds `);

    for (const { round_number } of seasonRounds) {
      const result = await fetchLineup({
        source: "afl-api",
        season: year,
        round: round_number,
        competition: COMPETITION,
      });

      if (!result.success) {
        process.stdout.write("x");
        fetchErrors++;
        continue;
      }

      allLineups.push(...result.data);
      process.stdout.write(".");
    }
    console.log();
  }

  console.log(`\nFetched ${allLineups.length} match lineups (${fetchErrors} round errors)`);

  // Phase 2: Identify new players
  const newPlayers = new Map<string, { givenName: string; surname: string }>();
  for (const lineup of allLineups) {
    for (const p of [...lineup.homePlayers, ...lineup.awayPlayers]) {
      if (!playerMap.has(p.playerId) && !newPlayers.has(p.playerId)) {
        newPlayers.set(p.playerId, { givenName: p.givenName, surname: p.surname });
      }
    }
  }

  console.log(`Found ${newPlayers.size} players not in DB`);

  // Phase 3: Insert new players if needed
  if (newPlayers.size > 0) {
    const playerStmts: string[] = [];
    for (const [playerId, { givenName, surname }] of newPlayers) {
      playerStmts.push(
        `INSERT INTO players (first_name, surname, external_afl_player_id)
         VALUES (${escapeSQL(givenName)}, ${escapeSQL(surname)}, ${escapeSQL(playerId)})
         ON CONFLICT (external_afl_player_id) WHERE external_afl_player_id IS NOT NULL
         DO UPDATE SET first_name = excluded.first_name, surname = excluded.surname`,
      );
    }

    const playerFiles = writeBatchedSQL("players", playerStmts);
    console.log(`Wrote ${playerFiles} player SQL files`);

    if (!dryRun) {
      console.log("Executing player inserts...");
      for (const f of readdirSync(SQL_DIR)
        .filter((f) => f.startsWith("players_"))
        .sort()) {
        console.log(`  ${f}`);
        executeSQL(join(SQL_DIR, f));
      }

      // Reload player map
      console.log("Reloading player mappings...");
      const freshPlayerRows = queryD1<{ id: number; external_afl_player_id: string }>(
        "SELECT id, external_afl_player_id FROM players WHERE external_afl_player_id IS NOT NULL",
      );
      playerMap.clear();
      for (const r of freshPlayerRows) playerMap.set(r.external_afl_player_id, r.id);
      console.log(`  ${playerMap.size} players loaded`);
    }
  }

  // Phase 4: Generate lineup SQL from cached data
  console.log("\nGenerating lineup SQL...");
  const lineupStmts: string[] = [];
  let skippedPlayers = 0;
  let skippedMatches = 0;

  for (const lineup of allLineups) {
    const matchId = matchMap.get(lineup.matchId);
    if (!matchId) {
      skippedMatches++;
      continue;
    }

    const homeTeamId = teamMap.get(normaliseTeam(lineup.homeTeam));
    const awayTeamId = teamMap.get(normaliseTeam(lineup.awayTeam));

    const sides = [
      { players: lineup.homePlayers, teamId: homeTeamId },
      { players: lineup.awayPlayers, teamId: awayTeamId },
    ] as const;

    for (const { players, teamId } of sides) {
      if (!teamId) continue;
      for (const p of players) {
        const playerId = playerMap.get(p.playerId);
        if (!playerId) {
          skippedPlayers++;
          continue;
        }

        lineupStmts.push(
          `INSERT INTO match_lineups (match_id, player_id, team_id, guernsey_number, position, is_emergency, is_substitute)
           VALUES (${matchId}, ${playerId}, ${teamId}, ${p.jumperNumber ?? "NULL"}, ${escapeSQL(p.matchPosition)}, ${p.isEmergency ? 1 : 0}, ${p.isSubstitute ? 1 : 0})
           ON CONFLICT (match_id, player_id) DO UPDATE SET
             team_id = excluded.team_id,
             guernsey_number = excluded.guernsey_number,
             position = excluded.position,
             is_emergency = excluded.is_emergency,
             is_substitute = excluded.is_substitute`,
        );
      }
    }
  }

  console.log(`Generated ${lineupStmts.length} lineup statements`);
  if (skippedPlayers > 0) console.log(`Skipped ${skippedPlayers} players (still not in DB)`);
  if (skippedMatches > 0)
    console.log(`Skipped ${skippedMatches} matches (no external_afl_id match)`);

  const lineupFiles = writeBatchedSQL("lineups", lineupStmts);
  console.log(`Wrote ${lineupFiles} lineup SQL files`);

  if (dryRun) {
    console.log(`\nDry run complete. SQL files written to: ${SQL_DIR}`);
    return;
  }

  // Phase 5: Execute lineup inserts
  console.log("\nExecuting lineup inserts...");
  const lineupSqlFiles = readdirSync(SQL_DIR)
    .filter((f) => f.startsWith("lineups_"))
    .sort();
  for (const f of lineupSqlFiles) {
    console.log(`  ${f}`);
    executeSQL(join(SQL_DIR, f));
  }

  console.log("\nDone!");
}

main().catch(console.error);
