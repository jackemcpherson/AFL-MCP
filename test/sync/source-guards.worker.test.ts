import { env } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { requestUrl } from "#test/fixtures";
import { sync } from "../../src/sync/sync";
import matchItem from "../fixtures/fixture-only-match.json";

afterEach(() => {
  vi.unstubAllGlobals();
});

const API = "https://aflapi.afl.com.au/afl/v2";
const CFS = "https://api.afl.com.au/cfs/afl";

/** Serve one 2026 AFLM season whose only round returns `items`. */
function stubProvider(compSeasons: readonly { id: number; name: string }[], items: unknown[]) {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = requestUrl(input);
    if (url === `${CFS}/WMCTok`) return Response.json({ token: "fixture-token" });
    if (url === `${API}/competitions/1/compseasons?pageSize=100`)
      return Response.json({ compSeasons });
    if (url === `${API}/compseasons/85/rounds?pageSize=50`)
      return Response.json({
        rounds: [
          {
            id: 1,
            providerId: "TEST-R1",
            name: "Round 1",
            roundNumber: 1,
            utcStartTime: "2026-03-19T08:30:00Z",
          },
        ],
      });
    if (url === `${CFS}/matchItems/round/TEST-R1`) return Response.json({ items });
    return new Response("unexpected", { status: 404, statusText: "Not Found" });
  });
}

async function count(table: "matches" | "season_provider_inventory"): Promise<unknown> {
  return env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first("n");
}

it("rejects a provider season that lists the same match ID twice before writing it", async () => {
  stubProvider([{ id: 85, name: "2026 Toyota AFL Premiership" }], [matchItem, matchItem]);

  await expect(sync(env, ["AFLM"], { season: 2026, skipShouldRunNow: true })).rejects.toThrow(
    "Provider season inventory contains duplicate match IDs",
  );
  expect(await count("season_provider_inventory")).toBe(0);
  expect(await count("matches")).toBe(0);
});

it("rejects a season the provider does not list exactly before fetching its matches", async () => {
  stubProvider([{ id: 85, name: "2026 Toyota AFL Premiership" }], [matchItem]);

  await expect(sync(env, ["AFLM"], { season: 2025, skipShouldRunNow: true })).rejects.toThrow(
    "No exact AFLM season 2025; use season discovery",
  );
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM seasons").first("n")).toBe(0);
});
