import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  ensureCompetition,
  ensureSeason,
  ensureTeams,
  ensureVenues,
  upsertMatches,
} from "../../src/sync/upserts";
import { makeMatch } from "./_fixtures";

describe("multi-competition isolation", () => {
  it("creates distinct competition rows for AFLM, AFLW, VFL, and VFLW", async () => {
    const ids = await Promise.all([
      ensureCompetition(env, "AFLM"),
      ensureCompetition(env, "AFLW"),
      ensureCompetition(env, "VFL"),
      ensureCompetition(env, "VFLW"),
    ]);
    expect(new Set(ids).size).toBe(4);

    const rows = await env.DB.prepare("SELECT code, name FROM competitions ORDER BY code").all<{
      code: string;
      name: string;
    }>();
    expect(rows.results).toEqual([
      { code: "AFLM", name: "AFL Men's" },
      { code: "AFLW", name: "AFL Women's" },
      { code: "VFL", name: "Victorian Football League" },
      { code: "VFLW", name: "VFL Women's" },
    ]);
  });

  it("scopes teams per competition: same name in two competitions yields distinct team_ids", async () => {
    const aflmId = await ensureCompetition(env, "AFLM");
    const vflId = await ensureCompetition(env, "VFL");
    const aflmSeason = await ensureSeason(env, aflmId, 2026);
    const vflSeason = await ensureSeason(env, vflId, 2026);

    const aflmMatch = makeMatch({
      competition: "AFLM",
      matchId: "AFLM-1",
      homeTeam: "Carlton",
      awayTeam: "Richmond",
      date: new Date("2026-03-19T08:30:00Z"),
    });
    const vflMatch = makeMatch({
      competition: "VFL",
      matchId: "VFL-1",
      homeTeam: "Carlton",
      awayTeam: "Richmond",
      // Same date as AFLM match — would collide on (date, home_team_id, away_team_id)
      // if team_ids weren't competition-scoped.
      date: new Date("2026-03-19T08:30:00Z"),
    });

    const aflmTeams = await ensureTeams(env, aflmId, "AFLM", [aflmMatch]);
    const vflTeams = await ensureTeams(env, vflId, "VFL", [vflMatch]);

    expect(aflmTeams.get("Carlton")).toBeDefined();
    expect(vflTeams.get("Carlton")).toBeDefined();
    expect(aflmTeams.get("Carlton")).not.toBe(vflTeams.get("Carlton"));

    const aflmVenues = await ensureVenues(env, [aflmMatch]);
    const vflVenues = await ensureVenues(env, [vflMatch]);

    // Both upserts succeed — no UNIQUE collision because team_ids differ.
    await upsertMatches(env, [aflmMatch], {
      seasonId: aflmSeason,
      teamMap: aflmTeams,
      venueMap: aflmVenues,
    });
    await upsertMatches(env, [vflMatch], {
      seasonId: vflSeason,
      teamMap: vflTeams,
      venueMap: vflVenues,
    });

    const counts = await env.DB.prepare(
      `SELECT c.code, COUNT(m.id) AS n
         FROM competitions c
         JOIN seasons s ON s.competition_id = c.id
         JOIN matches m ON m.season_id = s.id
         WHERE c.code IN ('AFLM', 'VFL')
         GROUP BY c.code
         ORDER BY c.code`,
    ).all<{ code: string; n: number }>();
    expect(counts.results).toEqual([
      { code: "AFLM", n: 1 },
      { code: "VFL", n: 1 },
    ]);
  });

  it("shares the venues table across competitions (intentional)", async () => {
    const aflmId = await ensureCompetition(env, "AFLM");
    const aflwId = await ensureCompetition(env, "AFLW");
    const aflmMatch = makeMatch({ competition: "AFLM", matchId: "AFLM-V" });
    const aflwMatch = makeMatch({
      competition: "AFLW",
      matchId: "AFLW-V",
      homeTeam: "Geelong",
      awayTeam: "Melbourne",
      date: new Date("2025-08-22T08:30:00Z"),
    });

    await ensureTeams(env, aflmId, "AFLM", [aflmMatch]);
    await ensureTeams(env, aflwId, "AFLW", [aflwMatch]);
    const aflmVenues = await ensureVenues(env, [aflmMatch]);
    const aflwVenues = await ensureVenues(env, [aflwMatch]);

    // Both matches play at MCG (the default in the fixture). The venue is
    // shared — same venue_id across both competitions.
    expect(aflmVenues.get("MCG")).toBe(aflwVenues.get("MCG"));

    const venueCount = await env.DB.prepare("SELECT COUNT(*) AS n FROM venues").first<{
      n: number;
    }>();
    expect(venueCount?.n).toBe(1);
  });
});
