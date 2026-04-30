/**
 * Backfill lineups for 2015-2019 seasons.
 *
 * These seasons lack external_afl_id on matches (loaded from fryzigg).
 * This script matches lineup data to DB records via year + round_number +
 * normalised home team, backfills external_afl_id, then inserts lineups.
 */
import { execSync } from "node:child_process";
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Lineup } from "fitzroy";
import { fetchLineup } from "fitzroy";

const SQL_DIR = join(__dirname, "..", "data", "sql-lineups-early");
mkdirSync(SQL_DIR, { recursive: true });

const BATCH_SIZE = 200;
const COMPETITION = "AFLM" as const;

// ── Helpers ──────────────────────────────────────────────────────────

function escapeSQL(value: string | number | null | undefined): string {
  if (value == null) return "NULL";
  if (typeof value === "number") return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
}

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

// ── Team name normalisation ─────────────────────────────────────────

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
  const startYear = args.includes("--start") ? Number(args[args.indexOf("--start") + 1]) : 2015;
  const endYear = args.includes("--end") ? Number(args[args.indexOf("--end") + 1]) : 2019;
  const dryRun = args.includes("--dry-run");

  console.log(
    `Early lineup backfill: seasons ${startYear}-${endYear}${dryRun ? " (dry run)" : ""}`,
  );

  // Load team map
  console.log("Loading team mappings from D1...");
  const teamRows = queryD1<{ id: number; name: string }>("SELECT id, name FROM teams");
  const teamMap = new Map<string, number>();
  for (const r of teamRows) teamMap.set(r.name, r.id);

  // Load matches for target years — keyed by "year|round_number|home_team_name"
  console.log("Loading match mappings from D1...");
  const matchRows = queryD1<{
    id: number;
    year: number;
    round_number: number;
    home_team: string;
    external_afl_id: string | null;
  }>(
    `SELECT m.id, s.year, m.round_number, t.name as home_team, m.external_afl_id
     FROM matches m
     JOIN seasons s ON m.season_id = s.id
     JOIN teams t ON m.home_team_id = t.id
     WHERE s.year BETWEEN ${startYear} AND ${endYear}`,
  );
  const matchMap = new Map<string, { id: number; hasAflId: boolean }>();
  for (const r of matchRows) {
    const key = `${r.year}|${r.round_number}|${r.home_team}`;
    matchMap.set(key, { id: r.id, hasAflId: r.external_afl_id !== null });
  }
  console.log(`  ${matchMap.size} matches loaded`);

  // Load player map
  console.log("Loading player mappings from D1...");
  const playerRows = queryD1<{ id: number; external_afl_player_id: string }>(
    "SELECT id, external_afl_player_id FROM players WHERE external_afl_player_id IS NOT NULL",
  );
  const playerMap = new Map<string, number>();
  for (const r of playerRows) playerMap.set(r.external_afl_player_id, r.id);
  console.log(`  ${playerMap.size} players loaded`);

  // Phase 1: Fetch all lineup data
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

  // Phase 2: Match lineups to DB records and build AFL ID updates
  const aflIdStmts: string[] = [];
  const matchIdResolved = new Map<string, number>(); // AFL matchId -> DB match id
  let matched = 0;
  let unmatched = 0;

  for (const lineup of allLineups) {
    const homeTeam = normaliseTeam(lineup.homeTeam);
    const key = `${lineup.season}|${lineup.roundNumber}|${homeTeam}`;
    const match = matchMap.get(key);

    if (!match) {
      unmatched++;
      continue;
    }

    matched++;
    matchIdResolved.set(lineup.matchId, match.id);

    if (!match.hasAflId) {
      aflIdStmts.push(
        `UPDATE matches SET external_afl_id = ${escapeSQL(lineup.matchId)} WHERE id = ${match.id}`,
      );
      match.hasAflId = true;
    }
  }

  console.log(`Matched ${matched} lineups to DB matches, ${unmatched} unmatched`);
  console.log(`${aflIdStmts.length} matches need external_afl_id backfill`);

  // Phase 3: Identify new players
  const newPlayers = new Map<string, { givenName: string; surname: string }>();
  for (const lineup of allLineups) {
    if (!matchIdResolved.has(lineup.matchId)) continue;
    for (const p of [...lineup.homePlayers, ...lineup.awayPlayers]) {
      if (!playerMap.has(p.playerId) && !newPlayers.has(p.playerId)) {
        newPlayers.set(p.playerId, { givenName: p.givenName, surname: p.surname });
      }
    }
  }
  console.log(`Found ${newPlayers.size} players not in DB`);

  // Phase 4: Write and execute player inserts + AFL ID updates
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
      // Reload
      const freshPlayerRows = queryD1<{ id: number; external_afl_player_id: string }>(
        "SELECT id, external_afl_player_id FROM players WHERE external_afl_player_id IS NOT NULL",
      );
      playerMap.clear();
      for (const r of freshPlayerRows) playerMap.set(r.external_afl_player_id, r.id);
      console.log(`  ${playerMap.size} players loaded`);
    }
  }

  if (aflIdStmts.length > 0) {
    const aflIdFiles = writeBatchedSQL("afl_ids", aflIdStmts);
    console.log(`Wrote ${aflIdFiles} AFL ID update SQL files`);

    if (!dryRun) {
      console.log("Executing AFL ID updates...");
      for (const f of readdirSync(SQL_DIR)
        .filter((f) => f.startsWith("afl_ids_"))
        .sort()) {
        console.log(`  ${f}`);
        executeSQL(join(SQL_DIR, f));
      }
    }
  }

  // Phase 5: Generate and execute lineup SQL
  console.log("\nGenerating lineup SQL...");
  const lineupStmts: string[] = [];
  let skippedPlayers = 0;

  for (const lineup of allLineups) {
    const matchId = matchIdResolved.get(lineup.matchId);
    if (!matchId) continue;

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
           VALUES (${matchId}, ${playerId}, ${teamId}, ${p.jumperNumber ?? "NULL"}, ${escapeSQL(p.position)}, ${p.isEmergency ? 1 : 0}, ${p.isSubstitute ? 1 : 0})
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
  if (skippedPlayers > 0) console.log(`Skipped ${skippedPlayers} players (not in DB)`);

  const lineupFiles = writeBatchedSQL("lineups", lineupStmts);
  console.log(`Wrote ${lineupFiles} lineup SQL files`);

  if (dryRun) {
    console.log(`\nDry run complete. SQL files in: ${SQL_DIR}`);
    return;
  }

  console.log("\nExecuting lineup inserts...");
  for (const f of readdirSync(SQL_DIR)
    .filter((f) => f.startsWith("lineups_"))
    .sort()) {
    console.log(`  ${f}`);
    executeSQL(join(SQL_DIR, f));
  }

  console.log("\nDone!");
}

main().catch(console.error);
