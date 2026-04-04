export function getToolsInfo() {
  return {
    description:
      "Write TypeScript code that executes in an isolated sandbox with access to the AFL statistics database.",
    environment: {
      db: {
        type: "D1Database",
        description:
          "Cloudflare D1 database containing AFL Men's match results and player statistics from 1990 to the current season.",
        access:
          "Read-only. Use db.prepare(sql).bind(...).all() or .first() to query.",
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
      "30-second execution timeout",
      "Read-only database access",
    ],
    guidance: [
      "Call schema first if you need to inspect table structure",
      "Use parameterised queries with .bind() to avoid SQL injection",
      "For complex analysis, run multiple queries and process results in code",
      "Return your final result as a JSON-serialisable value",
    ],
  }
}
