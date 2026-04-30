import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const EXPORT_DIR = join(__dirname, "..", "data", "export");
const SQL_DIR = join(__dirname, "..", "data", "sql");
mkdirSync(SQL_DIR, { recursive: true });

const BATCH_SIZE = 200;

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

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

function parseCSV(content: string): { headers: string[]; rows: string[][] } {
  const lines = content
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((l) => l.trim());
  const headers = parseCSVLine(lines[0]);
  const rows = lines.slice(1).map(parseCSVLine);
  return { headers, rows };
}

function escapeSQL(value: string): string {
  if (value === "" || value === "\\N") return "NULL";
  if (value === "t" || value === "true") return "1";
  if (value === "f" || value === "false") return "0";
  if (/^-?\d+(\.\d+)?$/.test(value)) return value;
  return `'${value.replace(/'/g, "''")}'`;
}

let totalFiles = 0;

for (const table of TABLES) {
  const csvPath = join(EXPORT_DIR, `${table}.csv`);
  const start = Date.now();
  console.log(`Processing ${table}...`);

  const content = readFileSync(csvPath, "utf-8");
  const { headers, rows } = parseCSV(content);

  let fileIndex = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const values = batch.map((row) => `(${row.map(escapeSQL).join(", ")})`).join(",\n");

    const sql = `INSERT OR REPLACE INTO ${table} (${headers.join(", ")}) VALUES\n${values};\n`;

    const sqlPath = join(SQL_DIR, `${table}_${String(fileIndex).padStart(4, "0")}.sql`);
    writeFileSync(sqlPath, sql);
    fileIndex++;
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(2);
  console.log(`  ${rows.length} rows -> ${fileIndex} SQL files (${elapsed}s)`);
  totalFiles += fileIndex;
}

console.log(`\nGenerated ${totalFiles} SQL files in ${SQL_DIR}`);
console.log('Run: for f in data/sql/*.sql; do npx wrangler d1 execute afl-stats --file "$f"; done');
