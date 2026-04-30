/**
 * Deduplicate player records.
 *
 * Problem: Players synced from fryzigg (external_id only) and AFL API
 * (external_afl_player_id only) created separate records for the same person.
 *
 * Strategy: Keep the fryzigg record (lower ID, richer data with brownlow/SC),
 * merge external_afl_player_id onto it, reassign all FK references, delete
 * the AFL-only duplicate.
 *
 * For triples (common names like Tom Lynch), uses team overlap to disambiguate.
 */
import { execSync } from "node:child_process";
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SQL_DIR = join(__dirname, "..", "data", "sql-dedup");
mkdirSync(SQL_DIR, { recursive: true });

const BATCH_SIZE = 200;

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

// ── Types ───────────────────────────────────────────────────────────

interface MergePair {
  keepId: number;
  removeId: number;
  firstName: string;
  surname: string;
  aflPlayerId: string;
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  console.log(`Player deduplication${dryRun ? " (dry run)" : ""}`);

  // Step 1: Find all candidate pairs (fryzigg-only + AFL-only with same name)
  console.log("\nFinding duplicate candidates...");
  const candidates = queryD1<{
    keep_id: number;
    remove_id: number;
    first_name: string;
    surname: string;
    external_afl_player_id: string;
  }>(`
    SELECT p1.id as keep_id, p2.id as remove_id, p1.first_name, p1.surname,
      p2.external_afl_player_id
    FROM players p1
    JOIN players p2 ON p1.first_name = p2.first_name AND p1.surname = p2.surname AND p1.id < p2.id
    WHERE p1.external_id IS NOT NULL AND p1.external_afl_player_id IS NULL
      AND p2.external_afl_player_id IS NOT NULL AND p2.external_id IS NULL
    ORDER BY p1.surname, p1.first_name
  `);
  console.log(`  ${candidates.length} candidate pairs`);

  // Step 2: Check for names that appear in multiple pairs (triples)
  // Group by remove_id — if an AFL-only record matches multiple fryzigg records, disambiguate
  const byRemoveId = new Map<number, typeof candidates>();
  for (const c of candidates) {
    const group = byRemoveId.get(c.remove_id) ?? [];
    group.push(c);
    byRemoveId.set(c.remove_id, group);
  }

  // Also group by keep_id — a fryzigg record might match multiple AFL-only records (rare but check)
  const byKeepId = new Map<number, typeof candidates>();
  for (const c of candidates) {
    const group = byKeepId.get(c.keep_id) ?? [];
    group.push(c);
    byKeepId.set(c.keep_id, group);
  }

  // Step 3: Resolve ambiguous pairs using team overlap
  console.log("\nResolving ambiguous pairs...");
  const mergePairs: MergePair[] = [];
  const skipped: string[] = [];
  const processedRemoveIds = new Set<number>();
  const processedKeepIds = new Set<number>();

  // Load team data for players with stats
  const playerTeams = queryD1<{ player_id: number; teams: string }>(`
    SELECT pms.player_id, GROUP_CONCAT(DISTINCT t.name) as teams
    FROM player_match_stats pms
    JOIN teams t ON pms.team_id = t.id
    GROUP BY pms.player_id
  `);
  const playerTeamMap = new Map<number, Set<string>>();
  for (const pt of playerTeams) {
    playerTeamMap.set(pt.player_id, new Set(pt.teams.split(",")));
  }

  for (const c of candidates) {
    // Skip if we've already assigned this remove or keep ID
    if (processedRemoveIds.has(c.remove_id) || processedKeepIds.has(c.keep_id)) continue;

    const removeGroup = byRemoveId.get(c.remove_id)!;
    const keepGroup = byKeepId.get(c.keep_id)!;

    // Simple case: 1:1 name match
    if (removeGroup.length === 1 && keepGroup.length === 1) {
      mergePairs.push({
        keepId: c.keep_id,
        removeId: c.remove_id,
        firstName: c.first_name,
        surname: c.surname,
        aflPlayerId: c.external_afl_player_id,
      });
      processedRemoveIds.add(c.remove_id);
      processedKeepIds.add(c.keep_id);
      continue;
    }

    // Ambiguous: use team overlap to pick the right fryzigg record for this AFL record
    const removeTeams = playerTeamMap.get(c.remove_id);
    const keepTeams = playerTeamMap.get(c.keep_id);

    if (!removeTeams || removeTeams.size === 0) {
      // AFL-only record has no stats — can't disambiguate by team, but check lineup teams
      const lineupTeams = queryD1<{ team: string }>(`
        SELECT DISTINCT t.name as team FROM match_lineups ml
        JOIN teams t ON ml.team_id = t.id WHERE ml.player_id = ${c.remove_id}
      `);
      const removeLineupTeams = new Set(lineupTeams.map((t) => t.team));

      if (keepTeams && removeLineupTeams.size > 0) {
        const overlap = [...removeLineupTeams].filter((t) => keepTeams.has(t));
        if (overlap.length > 0) {
          mergePairs.push({
            keepId: c.keep_id,
            removeId: c.remove_id,
            firstName: c.first_name,
            surname: c.surname,
            aflPlayerId: c.external_afl_player_id,
          });
          processedRemoveIds.add(c.remove_id);
          processedKeepIds.add(c.keep_id);
          continue;
        }
      }

      // No stats or lineups on remove — safe if it's the only candidate for this keep
      if (keepGroup.length === 1) {
        mergePairs.push({
          keepId: c.keep_id,
          removeId: c.remove_id,
          firstName: c.first_name,
          surname: c.surname,
          aflPlayerId: c.external_afl_player_id,
        });
        processedRemoveIds.add(c.remove_id);
        processedKeepIds.add(c.keep_id);
        continue;
      }

      skipped.push(
        `${c.first_name} ${c.surname} (keep=${c.keep_id}, remove=${c.remove_id}): ambiguous, no team data`,
      );
      continue;
    }

    if (!keepTeams || keepTeams.size === 0) {
      skipped.push(
        `${c.first_name} ${c.surname} (keep=${c.keep_id}, remove=${c.remove_id}): keep has no stats`,
      );
      continue;
    }

    // Check team overlap
    const overlap = [...removeTeams].filter((t) => keepTeams.has(t));
    if (overlap.length > 0) {
      mergePairs.push({
        keepId: c.keep_id,
        removeId: c.remove_id,
        firstName: c.first_name,
        surname: c.surname,
        aflPlayerId: c.external_afl_player_id,
      });
      processedRemoveIds.add(c.remove_id);
      processedKeepIds.add(c.keep_id);
    } else {
      skipped.push(
        `${c.first_name} ${c.surname} (keep=${c.keep_id}, remove=${c.remove_id}): no team overlap (keep=${[...keepTeams].join(",")}, remove=${[...removeTeams].join(",")})`,
      );
    }
  }

  console.log(`  ${mergePairs.length} pairs to merge`);
  if (skipped.length > 0) {
    console.log(`  ${skipped.length} skipped:`);
    for (const s of skipped) console.log(`    ${s}`);
  }

  // Step 4: Generate SQL
  console.log("\nGenerating SQL...");

  const stmts: string[] = [];

  for (const pair of mergePairs) {
    // 4a: Reassign match_lineups (no conflicts since lineups only reference AFL-only records)
    stmts.push(
      `UPDATE match_lineups SET player_id = ${pair.keepId} WHERE player_id = ${pair.removeId}`,
    );

    // 4b: Delete conflicting player_match_stats (keep record already has the row with richer data)
    stmts.push(
      `DELETE FROM player_match_stats WHERE player_id = ${pair.removeId} AND match_id IN (SELECT match_id FROM player_match_stats WHERE player_id = ${pair.keepId})`,
    );
    // Reassign remaining non-conflicting stats
    stmts.push(
      `UPDATE player_match_stats SET player_id = ${pair.keepId} WHERE player_id = ${pair.removeId}`,
    );

    // 4c: Delete conflicting player_season_pav
    stmts.push(
      `DELETE FROM player_season_pav WHERE player_id = ${pair.removeId} AND (season_id, team_id) IN (SELECT season_id, team_id FROM player_season_pav WHERE player_id = ${pair.keepId})`,
    );
    // Reassign remaining non-conflicting PAV
    stmts.push(
      `UPDATE player_season_pav SET player_id = ${pair.keepId} WHERE player_id = ${pair.removeId}`,
    );

    // 4d: Delete the duplicate player record (frees up external_afl_player_id)
    stmts.push(`DELETE FROM players WHERE id = ${pair.removeId}`);

    // 4e: Copy external_afl_player_id to keep record (must be after delete to avoid UNIQUE conflict)
    stmts.push(
      `UPDATE players SET external_afl_player_id = ${escapeSQL(pair.aflPlayerId)} WHERE id = ${pair.keepId}`,
    );
  }

  console.log(`Generated ${stmts.length} SQL statements`);
  const files = writeBatchedSQL("dedup", stmts);
  console.log(`Wrote ${files} SQL files to ${SQL_DIR}`);

  if (dryRun) {
    console.log("\nDry run complete.");
    return;
  }

  // Step 5: Execute
  console.log("\nExecuting...");
  const sqlFiles = readdirSync(SQL_DIR)
    .filter((f) => f.startsWith("dedup_"))
    .sort();
  for (const f of sqlFiles) {
    console.log(`  ${f}`);
    executeSQL(join(SQL_DIR, f));
  }

  // Step 6: Verify
  console.log("\nVerifying...");
  const remaining = queryD1<{ count: number }>(`
    SELECT COUNT(*) as count FROM players p1
    JOIN players p2 ON p1.first_name = p2.first_name AND p1.surname = p2.surname AND p1.id < p2.id
    WHERE p1.external_id IS NOT NULL AND p1.external_afl_player_id IS NULL
      AND p2.external_afl_player_id IS NOT NULL AND p2.external_id IS NULL
  `);
  console.log(`  Remaining duplicate pairs: ${remaining[0]?.count ?? "?"}`);

  const playerCount = queryD1<{ count: number }>("SELECT COUNT(*) as count FROM players");
  console.log(`  Total players: ${playerCount[0]?.count ?? "?"}`);

  const bothIds = queryD1<{ count: number }>(
    "SELECT COUNT(*) as count FROM players WHERE external_id IS NOT NULL AND external_afl_player_id IS NOT NULL",
  );
  console.log(`  Players with both IDs: ${bothIds[0]?.count ?? "?"}`);

  console.log("\nDone!");
}

main().catch(console.error);
