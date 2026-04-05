import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import { FryziggClient, transformFryziggPlayerStats } from "fitzroy";
import type { DataFrame } from "@jackemcpherson/rds-js";

const SQL_DIR = join(__dirname, "..", "data", "sql-enrichment");
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
  let fileIndex = 0;
  for (let i = 0; i < statements.length; i += BATCH_SIZE) {
    const batch = statements.slice(i, i + BATCH_SIZE);
    const sql = batch.join(";\n") + ";\n";
    const path = join(SQL_DIR, `${prefix}_${String(fileIndex).padStart(4, "0")}.sql`);
    writeFileSync(path, sql);
    fileIndex++;
  }
  return fileIndex;
}

// ── D1 queries via wrangler ─────────────────────────────────────────

function queryD1<T>(sql: string): T[] {
  const escaped = sql.replace(/"/g, '\\"');
  const raw = execSync(
    `npx wrangler d1 execute afl-stats --remote --command "${escaped}" --json`,
    { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024 },
  );
  const parsed = JSON.parse(raw);
  return parsed[0]?.results ?? [];
}

// ── Team name normalisation ─────────────────────────────────────────

const FRYZIGG_TEAM_MAP: Record<string, string> = {
  "Adelaide": "Adelaide",
  "Adelaide Crows": "Adelaide",
  "Brisbane Lions": "Brisbane Lions",
  "Brisbane": "Brisbane Lions",
  "Brisbane Bears": "Brisbane Bears",
  "Carlton": "Carlton",
  "Collingwood": "Collingwood",
  "Essendon": "Essendon",
  "Fitzroy": "Fitzroy",
  "Fremantle": "Fremantle",
  "Geelong": "Geelong",
  "Geelong Cats": "Geelong",
  "Gold Coast": "Gold Coast",
  "Gold Coast Suns": "Gold Coast",
  "GWS": "GWS Giants",
  "GWS Giants": "GWS Giants",
  "Greater Western Sydney": "GWS Giants",
  "Hawthorn": "Hawthorn",
  "Melbourne": "Melbourne",
  "North Melbourne": "North Melbourne",
  "Port Adelaide": "Port Adelaide",
  "Richmond": "Richmond",
  "St Kilda": "St Kilda",
  "Sydney": "Sydney",
  "Sydney Swans": "Sydney",
  "West Coast": "West Coast",
  "West Coast Eagles": "West Coast",
  "Western Bulldogs": "Western Bulldogs",
  "Footscray": "Western Bulldogs",
};

function normaliseTeam(name: string): string {
  return FRYZIGG_TEAM_MAP[name] ?? name;
}

// ── DataFrame column accessor ───────────────────────────────────────

function getColumn(frame: DataFrame, name: string): unknown[] | undefined {
  const idx = frame.names.indexOf(name);
  return idx >= 0 ? frame.columns[idx] : undefined;
}

function strAt(col: unknown[] | undefined, i: number): string | null {
  if (!col) return null;
  const v = col[i];
  return typeof v === "string" ? v : null;
}

function numAt(col: unknown[] | undefined, i: number): number | null {
  if (!col) return null;
  const v = col[i];
  return typeof v === "number" ? v : null;
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const startYear = args.includes("--start") ? Number(args[args.indexOf("--start") + 1]) : 1990;
  const endYear = args.includes("--end") ? Number(args[args.indexOf("--end") + 1]) : 2025;
  const dryRun = args.includes("--dry-run");

  console.log(`Fryzigg enrichment: seasons ${startYear}-${endYear}${dryRun ? " (dry run)" : ""}`);

  // Load player mappings from D1
  console.log("Loading player mappings from D1...");
  const playerRows = queryD1<{ id: number; external_id: string }>(
    "SELECT id, external_id FROM players WHERE external_id IS NOT NULL",
  );
  const playerMap = new Map<string, number>();
  for (const r of playerRows) {
    playerMap.set(String(r.external_id), r.id);
  }
  console.log(`  ${playerMap.size} players with fryzigg external_id`);

  // Load team mappings
  const teamRows = queryD1<{ id: number; name: string }>("SELECT id, name FROM teams");
  const teamIdMap = new Map<string, number>();
  for (const t of teamRows) {
    teamIdMap.set(t.name, t.id);
  }

  // Load match mappings for target seasons
  const seasons = Array.from({ length: endYear - startYear + 1 }, (_, i) => startYear + i);
  console.log(`Loading match mappings for ${seasons.length} seasons from D1...`);
  const matchRows = queryD1<{
    id: number;
    date: string;
    home_team_id: number;
    away_team_id: number;
    weather_temp_c: number | null;
    weather_type: string | null;
    local_time: string | null;
    external_fryzigg_id: string | null;
  }>(
    `SELECT m.id, m.date, m.home_team_id, m.away_team_id, m.weather_temp_c, m.weather_type, m.local_time, m.external_fryzigg_id
     FROM matches m JOIN seasons s ON m.season_id = s.id
     WHERE s.year IN (${seasons.join(",")})`,
  );
  const matchMap = new Map<string, typeof matchRows[0]>();
  for (const m of matchRows) {
    matchMap.set(`${m.date}|${m.home_team_id}|${m.away_team_id}`, m);
  }
  console.log(`  ${matchMap.size} matches loaded`);

  // Fetch fryzigg raw DataFrame (full dataset — one download)
  console.log("Fetching fryzigg AFLM dataset...");
  const client = new FryziggClient();
  const rawResult = await client.fetchPlayerStats(COMPETITION);
  if (!rawResult.success) {
    console.error(`Failed to fetch fryzigg data: ${rawResult.error}`);
    process.exit(1);
  }
  const frame = rawResult.data;
  const nRows = frame.columns[0]?.length ?? 0;
  console.log(`  ${nRows} total rows, ${frame.names.length} columns`);

  // Extract columns we need from the raw DataFrame
  const colDate = getColumn(frame, "match_date");
  const colHomeTeam = getColumn(frame, "match_home_team");
  const colAwayTeam = getColumn(frame, "match_away_team");
  const colPlayerId = getColumn(frame, "player_id");
  const colBrownlow = getColumn(frame, "brownlow_votes");
  const colSupercoach = getColumn(frame, "supercoach_score");
  const colWeatherTemp = getColumn(frame, "match_weather_temp_c");
  const colWeatherType = getColumn(frame, "match_weather_type");
  const colLocalTime = getColumn(frame, "match_local_time");
  const colMatchId = getColumn(frame, "match_id");

  const statsUpdates: string[] = [];
  const matchUpdates: string[] = [];
  const matchesProcessed = new Set<number>();
  let unmatchedPlayers = 0;
  let unmatchedMatches = 0;
  let skippedYear = 0;

  for (let i = 0; i < nRows; i++) {
    const dateStr = strAt(colDate, i);
    if (!dateStr) continue;

    // Filter by target season range
    const year = Number(dateStr.slice(0, 4));
    if (year < startYear || year > endYear) {
      skippedYear++;
      continue;
    }

    // Resolve match
    const homeTeam = normaliseTeam(strAt(colHomeTeam, i) ?? "");
    const awayTeam = normaliseTeam(strAt(colAwayTeam, i) ?? "");
    const homeTeamId = teamIdMap.get(homeTeam);
    const awayTeamId = teamIdMap.get(awayTeam);
    if (!homeTeamId || !awayTeamId) {
      unmatchedMatches++;
      continue;
    }

    const datePart = dateStr.slice(0, 10);
    const matchKey = `${datePart}|${homeTeamId}|${awayTeamId}`;
    const match = matchMap.get(matchKey);
    if (!match) {
      unmatchedMatches++;
      continue;
    }

    // Player stats enrichment
    const fryziggPlayerId = String(colPlayerId?.[i] ?? "");
    const playerId = playerMap.get(fryziggPlayerId);
    if (!playerId) {
      unmatchedPlayers++;
    } else {
      const brownlow = numAt(colBrownlow, i);
      const supercoach = numAt(colSupercoach, i);
      const setClauses: string[] = [];

      if (brownlow != null) setClauses.push(`brownlow_votes = ${brownlow}`);
      if (supercoach != null) setClauses.push(`supercoach_score = ${supercoach}`);

      if (setClauses.length > 0) {
        const conditions = setClauses.map((c) => `${c.split(" = ")[0]} IS NULL`);
        statsUpdates.push(
          `UPDATE player_match_stats SET ${setClauses.join(", ")} WHERE match_id = ${match.id} AND player_id = ${playerId} AND (${conditions.join(" OR ")})`,
        );
      }
    }

    // Match-level enrichment (once per match)
    if (!matchesProcessed.has(match.id)) {
      matchesProcessed.add(match.id);
      const matchSets: string[] = [];

      const weatherTemp = numAt(colWeatherTemp, i);
      const weatherType = strAt(colWeatherType, i);
      const localTime = strAt(colLocalTime, i);
      const fryziggMatchId = strAt(colMatchId, i);

      if (match.weather_temp_c == null && weatherTemp != null) {
        matchSets.push(`weather_temp_c = ${weatherTemp}`);
      }
      if (match.weather_type == null && weatherType != null) {
        matchSets.push(`weather_type = ${escapeSQL(weatherType)}`);
      }
      if (match.local_time == null && localTime != null) {
        matchSets.push(`local_time = ${escapeSQL(localTime)}`);
      }
      if (match.external_fryzigg_id == null && fryziggMatchId != null) {
        matchSets.push(`external_fryzigg_id = ${escapeSQL(fryziggMatchId)}`);
      }

      if (matchSets.length > 0) {
        matchUpdates.push(
          `UPDATE matches SET ${matchSets.join(", ")} WHERE id = ${match.id}`,
        );
      }
    }
  }

  console.log(`\nResults:`);
  console.log(`  Stats updates:     ${statsUpdates.length}`);
  console.log(`  Match updates:     ${matchUpdates.length}`);
  console.log(`  Unmatched players: ${unmatchedPlayers}`);
  console.log(`  Unmatched matches: ${unmatchedMatches}`);
  console.log(`  Skipped (outside range): ${skippedYear}`);

  if (dryRun) {
    console.log("\nDry run — no SQL files written.");
    if (statsUpdates.length > 0) console.log("\nSample stats update:", statsUpdates[0]);
    if (matchUpdates.length > 0) console.log("Sample match update:", matchUpdates[0]);
    return;
  }

  let totalFiles = 0;
  if (statsUpdates.length > 0) {
    const files = writeBatchedSQL("enrich_stats", statsUpdates);
    totalFiles += files;
    console.log(`  Wrote ${files} stats SQL files`);
  }
  if (matchUpdates.length > 0) {
    const files = writeBatchedSQL("enrich_matches", matchUpdates);
    totalFiles += files;
    console.log(`  Wrote ${files} match SQL files`);
  }

  console.log(`\nGenerated ${totalFiles} SQL files in ${SQL_DIR}`);
  console.log(
    'Run: for f in data/sql-enrichment/*.sql; do npx wrangler d1 execute afl-stats --remote --file "$f"; done',
  );
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
