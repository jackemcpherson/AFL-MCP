import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import type { Env } from "../../src/types";

const adminEnv: Env = { ...(env as Env), ADMIN_TOKEN: "coaching-test-token" };
const context = { waitUntil: () => {} } as unknown as ExecutionContext;
const profileUrl = "https://afltables.com/afl/stats/coaches/Coach_A.html";

function request(token = "coaching-test-token", dryRun = false): Request {
  return new Request("https://afl.test/mcp/admin/backfill-coaches", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fromYear: 2024, toYear: 2024, source: "afl-tables", dryRun }),
  });
}

// Synthetic reconciliation inputs, not historical attribution evidence.
function profile(opponent = "Richmond", reversed = false): string {
  const teams = reversed ? [opponent, "Carlton", 74, 81] : ["Carlton", opponent, 81, 74];
  return `<h2>Games Coached</h2><table><tr><td>1</td><td><a href="../../stats/games/2024/030320240316.html">R1,2024</a></td><td>W</td><td>${teams[0]}</td><td></td><td>${teams[2]}</td><td>${teams[1]}</td><td></td><td>${teams[3]}</td></tr></table>`;
}

async function seed(): Promise<void> {
  await adminEnv.DB.batch([
    adminEnv.DB.prepare("INSERT INTO seasons (id, competition_id, year) VALUES (900, 1, 2024)"),
    adminEnv.DB.prepare(
      "INSERT INTO teams (id, competition_id, name) VALUES (901, 1, 'Carlton'), (902, 1, 'Richmond')",
    ),
    adminEnv.DB.prepare(
      "INSERT INTO matches (id, season_id, round, date, home_team_id, away_team_id, home_points, away_points, status) VALUES (903, 900, 'Round 1', '2024-03-16', 901, 902, 81, 74, 'Complete')",
    ),
  ]);
}

function upstream(html: string, count = 1): string[] {
  const calls: string[] = [];
  const index = Array.from(
    { length: count },
    (_, i) => `<a href="Coach_${i === 0 ? "A" : i}.html">Coach ${i}</a>`,
  ).join("");
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response(String(input).endsWith("coaches_idx.html") ? index : html);
  });
  return calls;
}

async function count(
  table: "match_coaches" | "coach_external_match_ids" | "coaches",
): Promise<number> {
  return (
    (await adminEnv.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())?.n ??
    -1
  );
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await adminEnv.DB.prepare(
    "UPDATE sync_lease SET holder = NULL, acquired_at = NULL WHERE id = 1",
  ).run();
});

describe("authenticated coaching backfill on local D1", () => {
  it("repairs Bears references once while preserving match IDs and post-1996 Lions facts", async () => {
    await adminEnv.DB.batch([
      adminEnv.DB.prepare(
        "INSERT INTO seasons (id, competition_id, year) VALUES (910, 1, 1996), (911, 1, 1997)",
      ),
      adminEnv.DB.prepare(
        "INSERT INTO teams (id, competition_id, name) VALUES (912, 1, 'Brisbane Lions'), (913, 1, 'Carlton')",
      ),
      adminEnv.DB.prepare("INSERT INTO players (id, surname) VALUES (914, 'Example')"),
      adminEnv.DB.prepare(
        "INSERT INTO coaches (id, display_name, created_at) VALUES ('bears-coach', 'Example coach', '2026-10-03')",
      ),
      ...[1996, 1997].flatMap((year, offset) => {
        const match = 915 + offset;
        const season = 910 + offset;
        return [
          adminEnv.DB.prepare(
            "INSERT INTO matches (id, season_id, round, date, home_team_id, away_team_id) VALUES (?1, ?2, 'Round 1', ?3, 912, 913)",
          ).bind(match, season, `${year}-03-16`),
          adminEnv.DB.prepare(
            "INSERT INTO player_match_stats (match_id, player_id, team_id) VALUES (?1, 914, 912)",
          ).bind(match),
          adminEnv.DB.prepare(
            "INSERT INTO match_lineups (match_id, player_id, team_id) VALUES (?1, 914, 912)",
          ).bind(match),
          adminEnv.DB.prepare(
            "INSERT INTO player_season_pav (player_id, season_id, team_id, total_pav) VALUES (914, ?1, 912, 2.5)",
          ).bind(season),
          adminEnv.DB.prepare(
            "INSERT INTO coach_observations (id, provider, external_coach_id, external_match_id, coach_id, match_id, team_id, season, source_url, retrieved_at, display_name, raw_team) VALUES (?1, 'afl-tables', 'example', ?2, 'bears-coach', ?1, 912, ?3, 'https://afltables.com/example', '2026-10-03', 'Example coach', 'Brisbane')",
          ).bind(match, `external-${match}`, year),
          adminEnv.DB.prepare(
            "INSERT INTO match_coaches (match_id, team_id, coach_id, observation_id, updated_at) VALUES (?1, 912, 'bears-coach', ?1, '2026-10-03')",
          ).bind(match),
          adminEnv.DB.prepare(
            "INSERT INTO coach_external_match_ids (provider, external_match_id, match_id) VALUES ('afl-tables', ?1, ?2)",
          ).bind(`external-${match}`, match),
        ];
      }),
    ]);
    await adminEnv.DB.batch([
      adminEnv.DB.prepare(
        "INSERT INTO tipper_runs(id,competition,season,round,started_at,source_revision,model_version) VALUES(919,'AFLM',1996,1,'2026-10-04','test','test')",
      ),
      adminEnv.DB.prepare(
        "INSERT INTO tipper_predictions(run_id,match_id,season_id,round_number,home_team_id,away_team_id,kickoff_at,margin,home_probability,winner,issued_margin,issued_probability,provisional,evidence,observed_at,published_at) VALUES(919,915,910,1,912,913,'1996-03-16',12,.7,'home',12,.7,0,'{}','2026-10-04','2026-10-04')",
      ),
      adminEnv.DB.prepare(
        "INSERT INTO tipper_game_ids(match_id,game_id,year,round,home_team_id,away_team_id,squiggle_home_id,squiggle_away_id,home_name,away_name,observed_at) VALUES(915,915,1996,1,912,913,1,2,'Brisbane Lions','Carlton','2026-10-04')",
      ),
      adminEnv.DB.prepare(
        "INSERT INTO match_predictions(match_id,home_win_prob,predicted_margin,model_version,generated_at) VALUES(915,.7,12,'test','2026-10-04')",
      ),
    ]);
    const repair = (dryRun: boolean, manifestDigest?: string) =>
      worker.fetch(
        new Request("https://afl.test/mcp/admin/reconcile-bears", {
          method: "POST",
          headers: {
            Authorization: "Bearer coaching-test-token",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ dryRun, manifestDigest }),
        }),
        adminEnv,
        context,
      );
    const preview = await (await repair(true)).json<{ manifestDigest: string }>();
    expect(preview).toMatchObject({
      affectedMatches: 1,
      playerStats: 1,
      lineups: 1,
      pavRows: 1,
      canonicalCoaches: 1,
      observations: 1,
    });
    expect(
      await adminEnv.DB.prepare(
        "SELECT COUNT(*) AS n FROM teams WHERE name = 'Brisbane Bears'",
      ).first(),
    ).toEqual({ n: 0 });
    expect(
      await (
        await repair(
          false,
          (
            await (await repair(true)).json<{ manifestDigest: string }>()
          ).manifestDigest,
        )
      ).json(),
    ).toMatchObject({ affectedMatches: 1 });
    const bears = await adminEnv.DB.prepare(
      "SELECT id FROM teams WHERE name = 'Brisbane Bears'",
    ).first<{ id: number }>();
    expect(bears).not.toBeNull();
    for (const table of [
      "player_match_stats",
      "match_lineups",
      "match_coaches",
      "coach_observations",
    ]) {
      expect(
        (
          await adminEnv.DB.prepare(
            `SELECT match_id, team_id FROM ${table} ORDER BY match_id`,
          ).all()
        ).results,
      ).toEqual([
        { match_id: 915, team_id: bears?.id },
        { match_id: 916, team_id: 912 },
      ]);
    }
    expect(
      (await adminEnv.DB.prepare("SELECT id, home_team_id FROM matches ORDER BY id").all()).results,
    ).toEqual([
      { id: 915, home_team_id: bears?.id },
      { id: 916, home_team_id: 912 },
    ]);
    expect(
      (
        await adminEnv.DB.prepare(
          "SELECT season_id, team_id, total_pav FROM player_season_pav ORDER BY season_id",
        ).all()
      ).results,
    ).toEqual([
      { season_id: 910, team_id: bears?.id, total_pav: 2.5 },
      { season_id: 911, team_id: 912, total_pav: 2.5 },
    ]);
    expect(
      (
        await adminEnv.DB.prepare(
          "SELECT external_match_id, match_id FROM coach_external_match_ids ORDER BY match_id",
        ).all()
      ).results,
    ).toEqual([
      { external_match_id: "external-915", match_id: 915 },
      { external_match_id: "external-916", match_id: 916 },
    ]);
    expect(await adminEnv.DB.prepare("SELECT COUNT(*) AS n FROM tipper_game_ids").first()).toEqual({
      n: 0,
    });
    expect(
      await adminEnv.DB.prepare("SELECT COUNT(*) AS n FROM match_predictions").first(),
    ).toEqual({ n: 0 });
    expect(
      await adminEnv.DB.prepare(
        "SELECT home_team_id,away_team_id FROM tipper_predictions WHERE match_id=915",
      ).first(),
    ).toEqual({ home_team_id: 912, away_team_id: 913 });
    const before = await adminEnv.DB.prepare(
      "SELECT revision FROM public_input_revision WHERE id = 1",
    ).first();
    expect(
      await (
        await repair(
          false,
          (
            await (await repair(true)).json<{ manifestDigest: string }>()
          ).manifestDigest,
        )
      ).json(),
    ).toMatchObject({
      affectedMatches: 0,
      playerStats: 0,
      canonicalCoaches: 0,
    });
    expect(
      await adminEnv.DB.prepare("SELECT revision FROM public_input_revision WHERE id = 1").first(),
    ).toEqual(before);
  });

  it("previews a correction without changing facts, then replaces and removes stale credits", async () => {
    await seed();
    upstream(profile());
    expect(await (await worker.fetch(request(), adminEnv, context)).json()).toMatchObject({
      complete: true,
      changed: 1,
    });
    const original = await adminEnv.DB.prepare("SELECT * FROM match_coaches").first();
    const revision = await adminEnv.DB.prepare(
      "SELECT revision FROM public_input_revision WHERE id = 1",
    ).first();
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL) =>
        new Response(
          String(input).endsWith("coaches_idx.html")
            ? '<a href="Coach_B.html">Replacement coach</a>'
            : profile("Richmond", true),
        ),
    );
    expect(
      await (await worker.fetch(request("coaching-test-token", true), adminEnv, context)).json(),
    ).toMatchObject({ complete: true, resolved: 1, changed: 0 });
    expect(await adminEnv.DB.prepare("SELECT * FROM match_coaches").first()).toEqual(original);
    expect(
      await adminEnv.DB.prepare("SELECT revision FROM public_input_revision WHERE id = 1").first(),
    ).toEqual(revision);
    expect(await count("coaches")).toBe(1);

    expect(await (await worker.fetch(request(), adminEnv, context)).json()).toMatchObject({
      complete: true,
      changed: 2,
    });
    expect(
      await adminEnv.DB.prepare(
        "SELECT mc.match_id, mc.team_id, c.display_name FROM match_coaches mc JOIN coaches c ON c.id = mc.coach_id",
      ).all(),
    ).toMatchObject({
      results: [{ match_id: 903, team_id: 902, display_name: "Replacement coach" }],
    });
    expect(await count("match_coaches")).toBe(1);
    expect(await count("coach_external_match_ids")).toBe(1);
  });

  it("keeps canonical facts during a failed profile and resumes that page before removal", async () => {
    await seed();
    upstream(profile());
    await worker.fetch(request(), adminEnv, context);
    const original = await adminEnv.DB.prepare("SELECT * FROM match_coaches").first();
    let failed = true;
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("coaches_idx.html"))
        return new Response('<a href="Coach_A.html">Coach 0</a><a href="Coach_B.html">Coach B</a>');
      if (url.endsWith("Coach_B.html") && failed)
        return new Response("Unavailable", { status: 503 });
      return new Response(
        url.endsWith("Coach_A.html")
          ? profile().replaceAll("2024", "2023")
          : profile("Richmond", true),
      );
    });
    expect(await (await worker.fetch(request(), adminEnv, context)).json()).toMatchObject({
      pending: true,
      complete: false,
      failures: 1,
      changed: 0,
    });
    expect(await adminEnv.DB.prepare("SELECT * FROM match_coaches").first()).toEqual(original);
    failed = false;
    expect(await (await worker.fetch(request(), adminEnv, context)).json()).toMatchObject({
      complete: true,
      changed: 2,
    });
    expect(calls.filter((url) => url.endsWith("coaches_idx.html"))).toHaveLength(1);
    expect(calls.filter((url) => url.endsWith("Coach_A.html"))).toHaveLength(1);
    expect(await adminEnv.DB.prepare("SELECT team_id FROM match_coaches").first()).toEqual({
      team_id: 902,
    });
    expect(
      await adminEnv.DB.prepare("SELECT COUNT(*) AS n FROM coach_backfill_progress").first(),
    ).toEqual({ n: 0 });
  });

  it("rejects unauthorized requests and a held operation lease", async () => {
    expect((await worker.fetch(request("wrong"), adminEnv, context)).status).toBe(401);
    await adminEnv.DB.prepare(
      "UPDATE sync_lease SET holder = 'other', acquired_at = datetime('now') WHERE id = 1",
    ).run();
    expect((await worker.fetch(request(), adminEnv, context)).status).toBe(409);
    expect(await count("match_coaches")).toBe(0);
  });

  it("rejects a wrong opponent without creating coach or match mappings", async () => {
    await seed();
    upstream(profile("Geelong"));
    const response = await worker.fetch(request(), adminEnv, context);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ complete: false, unresolved: 1, changed: 0 });
    expect(await count("match_coaches")).toBe(0);
    expect(await count("coach_external_match_ids")).toBe(0);
    expect(await count("coaches")).toBe(0);
  });

  it("resolves reversed participant scores and preserves verified person identity", async () => {
    await seed();
    upstream(profile("Richmond", true));
    await adminEnv.DB.batch([
      adminEnv.DB.prepare(
        "INSERT INTO coaches (id, display_name, created_at) VALUES ('verified-person', 'Coach 0', '2026-10-03')",
      ),
      adminEnv.DB.prepare(
        "INSERT INTO coach_external_ids (provider, external_coach_id, coach_id, display_name, profile_url, verified) VALUES ('afl-tables', ?1, 'verified-person', 'Coach 0', ?2, 1)",
      ).bind(`afl-tables:${profileUrl}`, profileUrl),
    ]);
    const response = await worker.fetch(request(), adminEnv, context);
    expect(await response.json()).toMatchObject({ resolved: 1, unresolved: 0, complete: true });
    const row = await adminEnv.DB.prepare(
      "SELECT match_id, team_id, coach_id FROM match_coaches",
    ).first();
    expect(row).toEqual({ match_id: 903, team_id: 902, coach_id: "verified-person" });
    expect(await count("coaches")).toBe(1);
  });

  it("rejects conflicting primary assignments before any canonical or mapping write", async () => {
    await seed();
    upstream(profile(), 2);
    const response = await worker.fetch(request(), adminEnv, context);
    expect(await response.json()).toMatchObject({ complete: false, unresolved: 2, changed: 0 });
    expect(await count("match_coaches")).toBe(0);
    expect(await count("coach_external_match_ids")).toBe(0);
    expect(await count("coaches")).toBe(0);
  });

  it("resumes a bounded source batch without treating it as a complete season", async () => {
    await seed();
    const calls = upstream(profile(), 6);
    const first = await worker.fetch(request(), adminEnv, context);
    expect(await first.json()).toMatchObject({ complete: false, pending: true, changed: 0 });
    expect(calls).toHaveLength(6);
    expect(await count("match_coaches")).toBe(0);
    const progress = await adminEnv.DB.prepare("SELECT cursor FROM coach_backfill_progress").first<{
      cursor: string;
    }>();
    expect(progress?.cursor).toBeTruthy();
    const next = await worker.fetch(request(), adminEnv, context);
    expect(await next.json()).toMatchObject({ complete: false, unresolved: 6, changed: 0 });
    expect(calls).toHaveLength(7);
    expect(await count("match_coaches")).toBe(0);
  });

  it("advances publisher revision for completion and chronology changes, but not unchanged polls", async () => {
    await seed();
    upstream(profile());
    await worker.fetch(request(), adminEnv, context);
    const revision = async () =>
      (
        await adminEnv.DB.prepare("SELECT revision FROM public_input_revision WHERE id = 1").first<{
          revision: number;
        }>()
      )?.revision ?? -1;
    const before = await revision();
    await worker.fetch(request(), adminEnv, context);
    expect(await revision()).toBe(before);
    await adminEnv.DB.prepare("UPDATE matches SET status = 'Cancelled' WHERE id = 903").run();
    expect(await revision()).toBe(before + 1);
    await adminEnv.DB.prepare("UPDATE matches SET local_time = '20:00:00' WHERE id = 903").run();
    expect(await revision()).toBe(before + 2);
  });
});
