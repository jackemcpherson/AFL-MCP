import { env } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import worker from "../../src/index";

// Model the production D1 subrequest budget around the real endpoint and DB.
function budgetDatabase(db: D1Database, limit: number) {
  let calls = 0;
  const charge = () => {
    if (++calls > limit) throw new Error("D1 subrequest budget exceeded");
  };
  function wrap(statement: D1PreparedStatement): D1PreparedStatement {
    return new Proxy(statement, {
      get(target, key) {
        if (key === "bind") return (...values: unknown[]) => wrap(target.bind(...values));
        const method = Reflect.get(target, key);
        if (typeof method !== "function") return method;
        return (...args: unknown[]) => {
          charge();
          return Reflect.apply(method, target, args);
        };
      },
    });
  }
  return {
    db: new Proxy(db, {
      get(target, key) {
        if (key === "prepare") return (sql: string) => wrap(target.prepare(sql));
        const method = Reflect.get(target, key);
        if (typeof method !== "function") return method;
        return (...args: unknown[]) => {
          charge();
          return Reflect.apply(method, target, args);
        };
      },
    }),
    calls: () => calls,
  };
}

afterEach(() => vi.unstubAllGlobals());

it("imports a complete season inside the production D1 request budget", async () => {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO seasons(id,competition_id,year,season_key) VALUES(800,1,2024,'2024')",
    ),
    env.DB.prepare(
      "INSERT INTO teams(id,competition_id,name) VALUES(801,1,'Carlton'),(802,1,'Richmond')",
    ),
  ]);
  const rows: string[] = [];
  for (let offset = 0; offset < 322; offset++) {
    const date = new Date(Date.UTC(2024, 0, offset + 1)).toISOString().slice(0, 10);
    const game = `0303${date.replaceAll("-", "")}`;
    await env.DB.prepare(
      "INSERT INTO matches(id,season_id,round,date,home_team_id,away_team_id,home_points,away_points,status,external_afltables_id) VALUES(?1,800,'Round 1',?2,801,802,81,74,'Complete',?3)",
    )
      .bind(900 + offset, date, game)
      .run();
    rows.push(
      `<tr><td>${offset + 1}</td><td><a href="../../stats/games/2024/${game}.html">R1,2024</a></td><td>W</td><td>Carlton</td><td></td><td>81</td><td>Richmond</td><td></td><td>74</td></tr>`,
    );
  }
  vi.stubGlobal(
    "fetch",
    async (url: RequestInfo | URL) =>
      new Response(
        String(url).endsWith("coaches_idx.html")
          ? '<a href="Coach_A.html">Coach A</a>'
          : `<h2>Games Coached</h2><table>${rows.join("")}</table>`,
      ),
  );
  const budget = budgetDatabase(env.DB, 1000);
  const response = await worker.fetch(
    new Request("https://afl.test/mcp/admin/backfill-coaches", {
      method: "POST",
      headers: { Authorization: "Bearer budget-test", "Content-Type": "application/json" },
      body: JSON.stringify({ fromYear: 2024, toYear: 2024, source: "afl-tables", dryRun: false }),
    }),
    { ...env, DB: budget.db, ADMIN_TOKEN: "budget-test" },
    { waitUntil: () => {} } as unknown as ExecutionContext,
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    complete: true,
    resolved: 322,
    unresolved: 0,
    failures: 0,
  });
  expect(budget.calls()).toBeLessThan(1000);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM match_coaches").first("n")).toBe(322);
  expect(
    await env.DB.prepare("SELECT in_progress FROM public_input_revision WHERE id=1").first(
      "in_progress",
    ),
  ).toBe(0);
});
