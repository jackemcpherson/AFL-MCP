import { execSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";

const EXPORT_DIR = join(__dirname, "..", "data", "export");

const TABLES = [
  "competitions",
  "seasons",
  "teams",
  "venues",
  "players",
  "matches",
  "player_match_stats",
  "player_season_pav",
];

console.log("Verifying data integrity: CSV vs D1\n");
console.log("Table".padEnd(25), "CSV".padEnd(10), "D1".padEnd(10), "Status");
console.log("-".repeat(60));

let allMatch = true;

for (const table of TABLES) {
  const csvContent = readFileSync(join(EXPORT_DIR, `${table}.csv`), "utf-8");
  const csvCount = csvContent.split("\n").filter((l) => l.trim()).length - 1;

  const d1Output = execSync(
    `npx wrangler d1 execute afl-stats --command "SELECT COUNT(*) as count FROM ${table}" --json`,
    { encoding: "utf-8" }
  );
  const d1Result = JSON.parse(d1Output);
  const d1Count = d1Result[0]?.results?.[0]?.count ?? 0;

  const match = csvCount === d1Count;
  if (!match) allMatch = false;

  const status = match
    ? "OK"
    : `MISMATCH (diff: ${d1Count - csvCount})`;
  console.log(
    table.padEnd(25),
    String(csvCount).padEnd(10),
    String(d1Count).padEnd(10),
    status
  );
}

// Spot checks
console.log("\nSpot checks:");

const playerCheck = execSync(
  `npx wrangler d1 execute afl-stats --command "SELECT first_name, surname FROM players WHERE surname = 'Petracca' AND first_name = 'Christian' LIMIT 1" --json`,
  { encoding: "utf-8" }
);
console.log(
  "Christian Petracca:",
  JSON.parse(playerCheck)[0]?.results?.length > 0 ? "Found" : "Missing"
);

const matchCheck = execSync(
  `npx wrangler d1 execute afl-stats --command "SELECT m.date, t1.name as home, t2.name as away, m.home_points, m.away_points FROM matches m JOIN teams t1 ON m.home_team_id = t1.id JOIN teams t2 ON m.away_team_id = t2.id WHERE m.round_type != 'Regular' AND m.date LIKE '2024-09%' ORDER BY m.date DESC LIMIT 1" --json`,
  { encoding: "utf-8" }
);
console.log(
  "2024 Grand Final:",
  JSON.parse(matchCheck)[0]?.results?.[0] ? "Found" : "Missing"
);

const pavCheck = execSync(
  `npx wrangler d1 execute afl-stats --command "SELECT COUNT(*) as count, MIN(s.year) as min_year, MAX(s.year) as max_year FROM player_season_pav psp JOIN seasons s ON psp.season_id = s.id" --json`,
  { encoding: "utf-8" }
);
const pavResult = JSON.parse(pavCheck)[0]?.results?.[0];
console.log(
  `PAV data: ${pavResult?.count ?? 0} rows, years ${pavResult?.min_year}-${pavResult?.max_year}`
);

if (!allMatch) {
  console.log("\nSome tables have mismatched row counts.");
  process.exit(1);
}

console.log("\nAll checks passed.");
