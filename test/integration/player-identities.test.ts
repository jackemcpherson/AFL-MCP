import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import {
  IdentityRepairRequestSchema,
  repairPlayerIdentity,
} from "../../src/admin/player-identities";
import {
  ensureCompetition,
  ensureSeason,
  ensureTeams,
  ensureVenues,
  upsertMatches,
} from "../../src/sync/upserts";
import { makeMatch } from "./_fixtures";

const request = IdentityRepairRequestSchema.parse({
  playerIds: [10974, 712],
  providerIdentities: [
    {
      provider: "fryzigg",
      providerId: "12527",
      evidence: {
        url: "https://example.org/captured-provider",
        sha256: "b".repeat(64),
        explanation: "Captured legacy provider ID evidence for this verified person",
      },
    },
  ],
  evidence: [
    {
      url: "https://www.afl.com.au/players/verified-fixture",
      sha256: "a".repeat(64),
      explanation: "Captured provider identity evidence for this test group",
    },
  ],
});
async function seed() {
  const competition = await ensureCompetition(env, "AFLM");
  const season = await ensureSeason(env, competition, 2026);
  const matches = [makeMatch()];
  const teamMap = await ensureTeams(env, competition, "AFLM", matches);
  const venueMap = await ensureVenues(env, matches);
  await upsertMatches(env, matches, { seasonId: season, teamMap, venueMap });
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO players(id,surname) VALUES(712,'Verified player'),(10974,'Provider variant'),(11000,'Verified player')",
    ),
    env.DB.prepare(
      "INSERT INTO player_provider_ids(provider,provider_id,player_id,evidence_json) VALUES('afl-api','A',712,'{}'),('afl-api','B',10974,'{}')",
    ),
    env.DB.prepare(`INSERT INTO player_match_stats(match_id,player_id,team_id,kicks,marks)
      SELECT m.id,p.id,m.home_team_id,7,CASE WHEN p.id=10974 THEN 3 ELSE NULL END
      FROM matches m CROSS JOIN players p WHERE p.id IN (712,10974)`),
    env.DB.prepare(`INSERT INTO player_season_pav(player_id,season_id,team_id,total_pav)
      SELECT 10974,season_id,home_team_id,99 FROM matches`),
  ]);
}
async function preview() {
  const result = await repairPlayerIdentity(env, request);
  if (!("manifestDigest" in result) || !result.manifestDigest) throw new Error("Preview missing");
  return result.manifestDigest;
}

it("merges verified appearances, redirects both provider identities and leaves homonyms separate", async () => {
  await seed();
  await env.DB.prepare("UPDATE players SET date_of_birth='1998-12-12' WHERE id=10974").run();
  const digest = await preview();
  await repairPlayerIdentity(env, { ...request, dryRun: false, manifestDigest: digest });
  expect(
    (await env.DB.prepare("SELECT player_id,kicks,marks FROM player_match_stats").all()).results,
  ).toEqual([{ player_id: 712, kicks: 7, marks: 3 }]);
  expect(
    (await env.DB.prepare("SELECT DISTINCT player_id FROM player_provider_ids").all()).results,
  ).toEqual([{ player_id: 712 }]);
  expect(
    await env.DB.prepare(
      "SELECT player_id FROM player_provider_ids WHERE provider='fryzigg' AND provider_id='12527'",
    ).first("player_id"),
  ).toBe(712);
  expect(
    await env.DB.prepare("SELECT date_of_birth FROM players WHERE id=712").first("date_of_birth"),
  ).toBe("1998-12-12");
  expect(
    await env.DB.prepare(
      "SELECT canonical_id FROM player_id_redirects WHERE retired_id=10974",
    ).first("canonical_id"),
  ).toBe(712);
  expect(await env.DB.prepare("SELECT id FROM players WHERE id=11000").first("id")).toBe(11000);
  expect(
    await env.DB.prepare("SELECT count(*) AS n FROM player_season_pav WHERE player_id=10974").first(
      "n",
    ),
  ).toBe(0);
  const revision = await env.DB.prepare("SELECT revision FROM public_input_revision").first(
    "revision",
  );
  expect(
    await repairPlayerIdentity(env, { ...request, dryRun: false, manifestDigest: digest }),
  ).toMatchObject({ idempotent: true });
  expect(await env.DB.prepare("SELECT revision FROM public_input_revision").first("revision")).toBe(
    revision,
  );
});

it("rejects a stale preview before any appearance write", async () => {
  await seed();
  const digest = await preview();
  await env.DB.prepare("UPDATE player_match_stats SET kicks=8").run();
  await expect(
    repairPlayerIdentity(env, { ...request, dryRun: false, manifestDigest: digest }),
  ).rejects.toThrow("stale");
  expect(await env.DB.prepare("SELECT count(*) AS n FROM player_match_stats").first("n")).toBe(2);
});

it("keeps failed PAV replacement atomic and resumes from the repaired identity checkpoint", async () => {
  await seed();
  const digest = await preview();
  await env.DB.prepare(
    "CREATE TRIGGER fail_pav_delete BEFORE DELETE ON player_season_pav BEGIN SELECT RAISE(ABORT,'injected PAV failure'); END",
  ).run();
  try {
    await expect(
      repairPlayerIdentity(env, { ...request, dryRun: false, manifestDigest: digest }),
    ).rejects.toThrow("injected PAV failure");
    expect(
      await env.DB.prepare("SELECT status FROM identity_repair_operations").first("status"),
    ).toBe("reparented");
    expect(
      await env.DB.prepare("SELECT total_pav FROM player_season_pav WHERE player_id=10974").first(
        "total_pav",
      ),
    ).toBe(99);
    expect(
      await env.DB.prepare("SELECT in_progress FROM public_input_revision").first("in_progress"),
    ).toBe(1);
  } finally {
    await env.DB.prepare("DROP TRIGGER fail_pav_delete").run();
  }
  await repairPlayerIdentity(env, {
    ...request,
    dryRun: false,
    manifestDigest: digest,
    resume: true,
  });
  expect(
    await env.DB.prepare("SELECT status FROM identity_repair_operations").first("status"),
  ).toBe("complete");
  expect(
    await env.DB.prepare("SELECT in_progress FROM public_input_revision").first("in_progress"),
  ).toBe(0);
  expect(await env.DB.prepare("SELECT count(*) AS n FROM pav_rebuild_queue").first("n")).toBe(0);
});

it("rejects provider IDs already assigned outside the verified group", async () => {
  await seed();
  await env.DB.prepare(
    "INSERT INTO player_provider_ids VALUES('fryzigg','12527',11000,'{}')",
  ).run();
  await expect(repairPlayerIdentity(env, request)).rejects.toThrow("different player group");
  expect(
    await env.DB.prepare("SELECT in_progress FROM public_input_revision").first("in_progress"),
  ).toBe(0);
});

it("blocks conflicting birth dates without reparenting appearances", async () => {
  await seed();
  await env.DB.prepare(
    "UPDATE players SET date_of_birth=CASE id WHEN 712 THEN '1998-12-12' ELSE '1997-01-01' END WHERE id IN (712,10974)",
  ).run();
  const result = await repairPlayerIdentity(env, request);
  expect(result).toMatchObject({
    biographyConflicts: [{ field: "date_of_birth", values: ["1998-12-12", "1997-01-01"] }],
  });
  if (!("manifestDigest" in result)) throw new Error("Expected preview");
  await expect(
    repairPlayerIdentity(env, { ...request, dryRun: false, manifestDigest: result.manifestDigest }),
  ).rejects.toThrow("dates of birth");
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM player_match_stats").first("n")).toBe(2);
});

it("reassigns exact appearances between separate people without merging their historical identities", async () => {
  await seed();
  const selected = await env.DB.prepare("SELECT id FROM matches LIMIT 1").first<number>("id");
  if (!selected) throw new Error("Missing fixture");
  const competition = await ensureCompetition(env, "AFLM");
  const oldSeason = await ensureSeason(env, competition, 1990);
  const oldMatch = makeMatch({
    matchId: "SEPARATE-HISTORICAL-PERSON",
    season: 1990,
    date: new Date("1990-06-01T04:00:00Z"),
  });
  const teamMap = await ensureTeams(env, competition, "AFLM", [oldMatch]);
  const venueMap = await ensureVenues(env, [oldMatch]);
  await upsertMatches(env, [oldMatch], { seasonId: oldSeason, teamMap, venueMap });
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE players SET date_of_birth=CASE id WHEN 712 THEN '1984-05-14' ELSE '1961-10-01' END WHERE id IN (712,10974)",
    ),
    env.DB.prepare("UPDATE players SET external_afl_player_id='B' WHERE id=10974"),
    env.DB.prepare(
      "INSERT INTO player_provider_ids(provider,provider_id,player_id,evidence_json) VALUES('fryzigg','historical-person',10974,'{}')",
    ),
    env.DB.prepare(
      "INSERT INTO player_match_stats(match_id,player_id,team_id,kicks) SELECT id,10974,home_team_id,11 FROM matches WHERE season_id=?1",
    ).bind(oldSeason),
  ]);
  const scoped = IdentityRepairRequestSchema.parse({
    ...request,
    kind: "reassign-appearances",
    matchIds: [selected],
    providerIdentities: [{ provider: "afl-api", providerId: "B", evidence: request.evidence[0] }],
  });
  const preview = await repairPlayerIdentity(env, scoped);
  if (!("manifestDigest" in preview) || !preview.manifestDigest) throw new Error("Missing preview");
  expect(preview).toMatchObject({ biographyConflicts: [] });
  await repairPlayerIdentity(env, {
    ...scoped,
    dryRun: false,
    manifestDigest: preview.manifestDigest,
  });
  expect(await env.DB.prepare("SELECT COUNT(*) FROM player_id_redirects").first("COUNT(*)")).toBe(
    0,
  );
  expect(
    await env.DB.prepare("SELECT player_id FROM player_match_stats WHERE match_id=?1")
      .bind(selected)
      .first("player_id"),
  ).toBe(712);
  expect(
    await env.DB.prepare(
      "SELECT p.player_id FROM player_match_stats p JOIN matches m ON m.id=p.match_id WHERE m.season_id=?1",
    )
      .bind(oldSeason)
      .first("player_id"),
  ).toBe(10974);
  expect(
    await env.DB.prepare(
      "SELECT player_id FROM player_provider_ids WHERE provider_id='historical-person'",
    ).first("player_id"),
  ).toBe(10974);
  expect(
    await env.DB.prepare("SELECT external_afl_player_id FROM players WHERE id=10974").first(
      "external_afl_player_id",
    ),
  ).toBeNull();
  expect(
    await env.DB.prepare("SELECT external_afl_player_id FROM players WHERE id=712").first(
      "external_afl_player_id",
    ),
  ).toBe("B");
  expect(
    await repairPlayerIdentity(env, {
      ...scoped,
      dryRun: false,
      manifestDigest: preview.manifestDigest,
    }),
  ).toMatchObject({ idempotent: true });
});
