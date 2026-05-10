import { execSync } from "node:child_process";
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetchMatches } from "fitzroy";
import { normaliseTeam } from "../src/lib/normalise";

const SQL_DIR = join(__dirname, "..", "data", "sql-rounds");
mkdirSync(SQL_DIR, { recursive: true });

const BATCH_SIZE = 200;
const COMPETITION = "AFLM" as const;

interface DbMatch {
  id: number;
  date: string;
  home: string;
  away: string;
  round: string | null;
  round_number: number | null;
  round_type: string | null;
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

function key(date: string, home: string, away: string): string {
  return `${date}|${normaliseTeam(home)}|${normaliseTeam(away)}`;
}

function deriveRound(roundCode: string | null, roundNumber: number, roundType: string): string {
  if (roundCode) return roundCode;
  if (roundNumber === 0) return "Opening Round";
  if (roundType === "Finals") return `F${roundNumber}`;
  return `R${roundNumber}`;
}

function deriveRoundType(roundType: string): string {
  if (roundType === "HomeAndAway") return "Regular";
  return roundType;
}

function escapeSqlString(s: string): string {
  return s.replace(/'/g, "''");
}

async function runSeason(year: number, dryRun: boolean): Promise<number> {
  process.stdout.write(`  ${year}: `);

  const dbRows = queryD1<DbMatch>(
    `SELECT m.id, m.date, t1.name AS home, t2.name AS away, m.round, m.round_number, m.round_type
     FROM matches m
     JOIN seasons s ON s.id = m.season_id
     JOIN teams t1 ON t1.id = m.home_team_id
     JOIN teams t2 ON t2.id = m.away_team_id
     WHERE s.year = ${year}`,
  );
  const dbByKey = new Map<string, DbMatch>();
  for (const r of dbRows) dbByKey.set(key(r.date, r.home, r.away), r);

  const fz = await fetchMatches({ source: "afl-api", season: year, competition: COMPETITION });
  if (!fz.success) {
    console.log(`fitzroy failed (${fz.error.message}), skipping`);
    return 0;
  }

  let updates = 0;
  let unmatched = 0;
  const statements: string[] = [];
  for (const m of fz.data) {
    const dateStr = new Date(m.date).toISOString().slice(0, 10);
    const k = key(dateStr, m.homeTeam, m.awayTeam);
    const dbMatch = dbByKey.get(k);
    if (!dbMatch) {
      unmatched++;
      continue;
    }
    const newRound = deriveRound(m.roundCode, m.roundNumber, m.roundType);
    const newType = deriveRoundType(m.roundType);
    if (
      dbMatch.round === newRound &&
      dbMatch.round_number === m.roundNumber &&
      dbMatch.round_type === newType
    ) {
      continue;
    }
    statements.push(
      `UPDATE matches SET round = '${escapeSqlString(newRound)}', round_number = ${m.roundNumber}, round_type = '${escapeSqlString(newType)}' WHERE id = ${dbMatch.id}`,
    );
    updates++;
  }

  console.log(`updates=${updates} unmatched_in_fitzroy=${unmatched} db_matches=${dbRows.length}`);
  if (statements.length === 0) return 0;

  const fileCount = writeBatched(`rounds_${year}`, statements);
  if (dryRun) {
    console.log(`    dry-run: wrote ${fileCount} SQL files (not applied)`);
    return updates;
  }
  const files = readdirSync(SQL_DIR)
    .filter((f) => f.startsWith(`rounds_${year}_`) && f.endsWith(".sql"))
    .sort();
  for (const f of files) {
    process.stdout.write(`    ${f} `);
    executeSQL(join(SQL_DIR, f));
    console.log("✓");
  }
  return updates;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const startYear = args.includes("--start") ? Number(args[args.indexOf("--start") + 1]) : 2024;
  const endYear = args.includes("--end")
    ? Number(args[args.indexOf("--end") + 1])
    : new Date().getFullYear() - 1;
  console.log(`Round backfill: AFLM seasons ${startYear}-${endYear}${dryRun ? " (dry run)" : ""}`);
  let total = 0;
  for (let y = startYear; y <= endYear; y++) total += await runSeason(y, dryRun);
  console.log(`\nTotal updates: ${total}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
