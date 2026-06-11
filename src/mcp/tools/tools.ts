export function getToolsInfo() {
  return {
    description:
      "Write TypeScript code that executes in an isolated sandbox with access to the Australian football statistics database (AFLM, AFLW, VFL, VFLW).",
    environment: {
      db: {
        type: "D1Database",
        description:
          "Cloudflare D1 database covering AFL Men's (1990+), AFL Women's (2017+), VFL (2021+), and VFLW (2021+) match results, player statistics, and lineups. PAV is computed for AFLM (1998+) and AFLW (2017+) only.",
        access: "Read-only. Use db.prepare(sql).bind(...).all() or .first() to query.",
      },
    },
    capabilities: [
      "Run multiple queries and combine results in code",
      "Perform calculations, aggregations, and transformations in TypeScript",
      "Return structured JSON results",
    ],
    constraints: [
      "No network access — all data comes from the database",
      "No npm packages — standard TypeScript/JavaScript only",
      "30-second execution timeout (enforced)",
      "Read-only database access — write/DDL statements are rejected (enforced)",
      "Results over 1 MB are truncated — narrow queries with LIMIT or aggregation",
      "Rate limited per IP (60 requests/minute)",
    ],
    guidance: [
      "Call schema first if you need to inspect table structure",
      "ALWAYS filter queries by competition: JOIN seasons → competitions, then WHERE c.code = ? (AFLM/AFLW/VFL/VFLW). Without it, results mix competitions silently.",
      "Use parameterised queries with .bind() to avoid SQL injection",
      "For complex analysis, run multiple queries and process results in code",
      "Return your final result as a JSON-serialisable value",
    ],
  };
}
