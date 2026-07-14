import { execSync } from "node:child_process";
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DataFrame } from "@jackemcpherson/rds-js";
import { AflTablesClient, FryziggClient, normaliseTeamName } from "fitzroy";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = join(__dirname, "..", "data", "sql-dob");
mkdirSync(SQL_DIR, { recursive: true });

const BATCH_SIZE = 200;
const MIN_BIRTH_YEAR = 1940;
const MIN_DEBUT_AGE = 16;
const MAX_DEBUT_AGE = 45;

// ── Shared plumbing (backfill-brownlow pattern) ─────────────────────

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

function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// ── DOB parsing ──────────────────────────────────────────────────────

const MONTHS: Record<string, string> = {
  jan: "01",
  feb: "02",
  mar: "03",
  apr: "04",
  may: "05",
  jun: "06",
  jul: "07",
  aug: "08",
  sep: "09",
  oct: "10",
  nov: "11",
  dec: "12",
};

/** Normalise a DOB to ISO YYYY-MM-DD without going through Date (no tz drift). */
function toIsoDob(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = String(raw).trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dmy = s.match(/^(\d{1,2})[-/ ]([A-Za-z]{3})[A-Za-z]*[-/ ](\d{4})$/);
  if (dmy?.[1] && dmy[2] && dmy[3]) {
    const month = MONTHS[dmy[2].toLowerCase()];
    if (month) return `${dmy[3]}-${month}-${dmy[1].padStart(2, "0")}`;
  }
  return null;
}

function dobIsSane(isoDob: string, firstSeasonYear: number): boolean {
  const birthYear = Number(isoDob.slice(0, 4));
  const age = firstSeasonYear - birthYear;
  return birthYear >= MIN_BIRTH_YEAR && age >= MIN_DEBUT_AGE && age <= MAX_DEBUT_AGE;
}

// ── DataFrame helpers (enrich-fryzigg pattern) ──────────────────────

function getColumn(frame: DataFrame, name: string): unknown[] | undefined {
  const idx = frame.names.indexOf(name);
  return idx >= 0 ? frame.columns[idx] : undefined;
}

// ── D1 row shapes ────────────────────────────────────────────────────

interface DbPlayer {
  id: number;
  external_id: string | null;
  first_name: string | null;
  surname: string;
  date_of_birth: string | null;
}

interface DbPlayerStint {
  id: number;
  first_name: string | null;
  surname: string;
  team: string;
  first_year: number;
  last_year: number;
}

// ── Stage 0/1: fryzigg ──────────────────────────────────────────────

async function fetchFryziggFrame(): Promise<DataFrame> {
  console.log("Fetching fryzigg AFLM dataset (large download)...");
  const client = new FryziggClient();
  const result = await client.fetchPlayerStats("AFLM");
  if (!result.success) {
    console.error(`Failed to fetch fryzigg data: ${result.error}`);
    process.exit(1);
  }
  const nRows = result.data.columns[0]?.length ?? 0;
  console.log(`  ${nRows} rows, ${result.data.names.length} columns`);
  return result.data;
}

function findDobColumn(frame: DataFrame): string | null {
  return frame.names.find((n) => /dob|birth/i.test(n)) ?? null;
}

function probe(frame: DataFrame): void {
  console.log("\nColumns:");
  console.log(`  ${frame.names.join(", ")}`);
  const dobCol = findDobColumn(frame);
  if (!dobCol) {
    console.log("\nNo DOB-ish column found — Stage 1 (fryzigg) unavailable, use --stage afltables");
    return;
  }
  console.log(`\nDOB column: ${dobCol}`);
  const col = getColumn(frame, dobCol);
  const colDate = getColumn(frame, "match_date");
  const bySeason = new Map<number, { n: number; withDob: number }>();
  const nRows = frame.columns[0]?.length ?? 0;
  for (let i = 0; i < nRows; i++) {
    const dateStr = colDate?.[i];
    if (typeof dateStr !== "string") continue;
    const year = Number(dateStr.slice(0, 4));
    const s = bySeason.get(year) ?? { n: 0, withDob: 0 };
    s.n++;
    if (toIsoDob(col?.[i] as string | null) !== null) s.withDob++;
    bySeason.set(year, s);
  }
  console.log("Row-level DOB coverage by season:");
  for (const [year, s] of [...bySeason.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`  ${year}: ${s.withDob}/${s.n} (${((100 * s.withDob) / s.n).toFixed(0)}%)`);
  }
}

function stageFryzigg(frame: DataFrame, players: DbPlayer[]): string[] {
  const dobColName = findDobColumn(frame);
  if (!dobColName) {
    console.log("Stage 1: no DOB column in fryzigg frame — skipping");
    return [];
  }
  console.log(`Stage 1 (fryzigg): using column '${dobColName}'`);

  const colDob = getColumn(frame, dobColName);
  const colPlayerId = getColumn(frame, "player_id");
  const nRows = frame.columns[0]?.length ?? 0;

  // One DOB per fryzigg player id; conflicting values disqualify the player.
  const dobByFryziggId = new Map<string, string>();
  const conflicted = new Set<string>();
  for (let i = 0; i < nRows; i++) {
    const fid = String(colPlayerId?.[i] ?? "");
    if (!fid || conflicted.has(fid)) continue;
    const iso = toIsoDob(colDob?.[i] as string | null);
    if (!iso) continue;
    const existing = dobByFryziggId.get(fid);
    if (existing && existing !== iso) {
      conflicted.add(fid);
      dobByFryziggId.delete(fid);
    } else {
      dobByFryziggId.set(fid, iso);
    }
  }
  console.log(
    `  ${dobByFryziggId.size} fryzigg players with a DOB, ${conflicted.size} conflicting (skipped)`,
  );

  const statements: string[] = [];
  let alreadySet = 0;
  let noExternalMatch = 0;
  for (const p of players) {
    if (p.date_of_birth !== null) {
      alreadySet++;
      continue;
    }
    const iso = p.external_id ? dobByFryziggId.get(String(p.external_id)) : undefined;
    if (!iso) {
      noExternalMatch++;
      continue;
    }
    statements.push(
      `UPDATE players SET date_of_birth = '${iso}' WHERE id = ${p.id} AND date_of_birth IS NULL`,
    );
  }
  console.log(
    `  updates=${statements.length} already_set=${alreadySet} no_external_match=${noExternalMatch}`,
  );
  return statements;
}

// ── Stage 2: AFL Tables all-time team lists ─────────────────────────

async function stageAflTables(startYear: number, endYear: number): Promise<string[]> {
  console.log("Stage 2 (AFL Tables): loading NULL-DOB players with club stints from D1...");
  const stints = queryD1<DbPlayerStint>(
    `SELECT p.id, p.first_name, p.surname, t.name AS team,
            MIN(s.year) AS first_year, MAX(s.year) AS last_year
     FROM players p
     JOIN player_match_stats pms ON pms.player_id = p.id
     JOIN teams t ON t.id = pms.team_id
     JOIN matches m ON m.id = pms.match_id
     JOIN seasons s ON s.id = m.season_id
     JOIN competitions c ON c.id = s.competition_id
     WHERE c.code = 'AFLM' AND p.date_of_birth IS NULL
       AND s.year BETWEEN ${startYear} AND ${endYear}
     GROUP BY p.id, t.name`,
  );
  const byTeam = new Map<string, DbPlayerStint[]>();
  for (const s of stints) {
    const list = byTeam.get(s.team) ?? [];
    list.push(s);
    byTeam.set(s.team, list);
  }
  const playerIds = new Set(stints.map((s) => s.id));
  console.log(`  ${playerIds.size} players missing DOB across ${byTeam.size} teams`);

  const client = new AflTablesClient();
  const dobByPlayerId = new Map<number, string>();
  const ambiguous: string[] = [];
  const unmatched: string[] = [];

  for (const [team, teamStints] of [...byTeam.entries()].sort()) {
    const canonical = normaliseTeamName(team);
    const listResult = await client.fetchPlayerList(canonical);
    if (!listResult.success) {
      console.log(
        `  ${team} (-> ${canonical}): fetchPlayerList FAILED: ${listResult.error.message}`,
      );
      continue;
    }
    const roster = listResult.data;
    const byName = new Map<string, typeof roster>();
    for (const r of roster) {
      const key = `${normalizeName(r.surname)}|${normalizeName(r.givenName)}`;
      const list = byName.get(key) ?? [];
      list.push(r);
      byName.set(key, list);
    }

    let resolved = 0;
    for (const stint of teamStints) {
      if (dobByPlayerId.has(stint.id)) continue;
      const key = `${normalizeName(stint.surname)}|${normalizeName(stint.first_name ?? "")}`;
      let candidates = (byName.get(key) ?? []).filter((c) => {
        const iso = toIsoDob(c.dateOfBirth);
        return iso !== null && dobIsSane(iso, stint.first_year);
      });
      if (candidates.length > 1) {
        // Disambiguate by debut year vs the player's first season at this club.
        // Our DB starts at 1990, so earlier debuts are allowed (<=), with a
        // one-year grace for late-season list additions.
        const byDebut = candidates.filter(
          (c) => c.debutYear !== null && c.debutYear <= stint.first_year + 1,
        );
        if (byDebut.length === 1) candidates = byDebut;
      }
      if (candidates.length === 1 && candidates[0]) {
        const iso = toIsoDob(candidates[0].dateOfBirth);
        if (iso) {
          dobByPlayerId.set(stint.id, iso);
          resolved++;
        }
      } else if (candidates.length > 1) {
        ambiguous.push(`${stint.first_name} ${stint.surname} (${team}, ${stint.first_year})`);
      } else {
        unmatched.push(`${stint.first_name} ${stint.surname} (${team}, ${stint.first_year})`);
      }
    }
    console.log(`  ${team}: roster ${roster.length}, resolved ${resolved}/${teamStints.length}`);
  }

  console.log(
    `  Stage 2 totals: resolved=${dobByPlayerId.size} ambiguous=${ambiguous.length} unmatched=${unmatched.length}`,
  );
  if (ambiguous.length > 0) {
    console.log(
      `  ambiguous (skipped): ${ambiguous.slice(0, 10).join("; ")}${ambiguous.length > 10 ? " ..." : ""}`,
    );
  }
  if (unmatched.length > 0) {
    console.log(
      `  unmatched (skipped): ${unmatched.slice(0, 10).join("; ")}${unmatched.length > 10 ? " ..." : ""}`,
    );
  }

  return [...dobByPlayerId.entries()].map(
    ([id, iso]) =>
      `UPDATE players SET date_of_birth = '${iso}' WHERE id = ${id} AND date_of_birth IS NULL`,
  );
}

// ── Coverage report ──────────────────────────────────────────────────

function printCoverage(label: string): void {
  console.log(`\nDOB coverage by AFLM PAV season (${label}):`);
  const rows = queryD1<{ year: number; players: number; with_dob: number }>(
    `SELECT s.year, COUNT(DISTINCT psp.player_id) AS players,
            COUNT(DISTINCT CASE WHEN p.date_of_birth IS NOT NULL THEN psp.player_id END) AS with_dob
     FROM player_season_pav psp
     JOIN players p ON p.id = psp.player_id
     JOIN seasons s ON s.id = psp.season_id
     JOIN competitions c ON c.id = s.competition_id
     WHERE c.code = 'AFLM'
     GROUP BY s.year ORDER BY s.year`,
  );
  for (const r of rows) {
    console.log(
      `  ${r.year}: ${r.with_dob}/${r.players} (${((100 * r.with_dob) / r.players).toFixed(0)}%)`,
    );
  }
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const probeOnly = args.includes("--probe");
  const dryRun = args.includes("--dry-run");
  const stage = args.includes("--stage") ? args[args.indexOf("--stage") + 1] : "all";
  const startYear = args.includes("--start") ? Number(args[args.indexOf("--start") + 1]) : 1990;
  const endYear = args.includes("--end") ? Number(args[args.indexOf("--end") + 1]) : 2025;

  if (probeOnly) {
    probe(await fetchFryziggFrame());
    return;
  }

  console.log(
    `DOB backfill: stage=${stage} seasons ${startYear}-${endYear}${dryRun ? " (dry run)" : ""}`,
  );

  const statements: string[] = [];

  if (stage === "all" || stage === "fryzigg") {
    const players = queryD1<DbPlayer>(
      "SELECT id, external_id, first_name, surname, date_of_birth FROM players",
    );
    console.log(`  ${players.length} players loaded from D1`);
    statements.push(...stageFryzigg(await fetchFryziggFrame(), players));
  }

  if (stage === "all" || stage === "afltables") {
    if (stage === "all" && statements.length > 0 && !dryRun) {
      // Apply fryzigg updates first so the AFL Tables stage only sees true leftovers.
      const files = writeBatchedSQL("dob_fryzigg", statements);
      console.log(`\nApplying ${files} fryzigg SQL files before Stage 2...`);
      applyFiles("dob_fryzigg");
      statements.length = 0;
    }
    statements.push(...(await stageAflTables(startYear, endYear)));
  }

  if (statements.length === 0) {
    console.log("Nothing to write.");
    if (!dryRun) {
      printCoverage("after");
      printAgeOutliers();
    }
    return;
  }

  const prefix = stage === "all" ? "dob_afltables" : `dob_${stage}`;
  const fileCount = writeBatchedSQL(prefix, statements);
  console.log(`\nWrote ${fileCount} SQL files to ${SQL_DIR}`);

  if (dryRun) {
    console.log(`Sample: ${statements[0]}`);
    console.log("Dry run: inspect the SQL files and re-run without --dry-run.");
    return;
  }

  console.log("Applying SQL files to remote D1...");
  applyFiles(prefix);
  printCoverage("after");
  printAgeOutliers();
}

function printAgeOutliers(): void {
  const rows = queryD1<{
    id: number;
    first_name: string | null;
    surname: string;
    dob: string;
    min_age: number;
    max_age: number;
  }>(
    `SELECT p.id, p.first_name, p.surname, p.date_of_birth AS dob,
            MIN((julianday(m.date) - julianday(p.date_of_birth)) / 365.25) AS min_age,
            MAX((julianday(m.date) - julianday(p.date_of_birth)) / 365.25) AS max_age
     FROM players p JOIN player_match_stats pms ON pms.player_id = p.id
     JOIN matches m ON m.id = pms.match_id
     WHERE p.date_of_birth IS NOT NULL
     GROUP BY p.id
     HAVING max_age > ${MAX_DEBUT_AGE} OR min_age < ${MIN_DEBUT_AGE}`,
  );
  if (rows.length === 0) {
    console.log("\nAge outlier check: clean.");
    return;
  }
  console.log(
    `\nAge outlier check: ${rows.length} player(s) with implausible age range — likely DB Sr/Jr merges (existing data-quality, not backfill bug):`,
  );
  for (const r of rows) {
    console.log(
      `  id=${r.id} ${r.first_name} ${r.surname} DOB=${r.dob} age=[${r.min_age.toFixed(1)}, ${r.max_age.toFixed(1)}]`,
    );
  }
  console.log("Consider: UPDATE players SET date_of_birth = NULL WHERE id IN (...)");
}

function applyFiles(prefix: string): void {
  const files = readdirSync(SQL_DIR)
    .filter((f) => f.startsWith(`${prefix}_`) && f.endsWith(".sql"))
    .sort();
  for (const f of files) {
    process.stdout.write(`  ${f} `);
    executeSQL(join(SQL_DIR, f));
    console.log("✓");
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
