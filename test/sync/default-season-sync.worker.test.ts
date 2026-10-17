import { env } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { requestUrl } from "#test/fixtures";
import { sync } from "../../src/sync/sync";
import matchItem from "../fixtures/fixture-only-match.json";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const API = "https://aflapi.afl.com.au/afl/v2";
const CFS = "https://api.afl.com.au/cfs/afl";

it("syncs the latest started season when no season is given", async () => {
  const requested: string[] = [];
  // Any token is accepted, so a token cached by an earlier test changes nothing.
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = requestUrl(input);
    requested.push(url);
    if (url === `${CFS}/WMCTok`) return Response.json({ token: "fixture-token" });
    if (url === `${API}/competitions/1/compseasons?pageSize=100`)
      return Response.json({
        compSeasons: [
          { id: 90, name: "2027 Toyota AFL Premiership" },
          { id: 85, name: "2026 Toyota AFL Premiership" },
        ],
      });
    if (url === `${API}/compseasons/90/rounds?pageSize=50`)
      return Response.json({
        rounds: [
          {
            id: 2,
            providerId: "TEST-2027-R1",
            name: "Round 1",
            roundNumber: 1,
            utcStartTime: "2027-03-11T08:30:00Z",
          },
        ],
      });
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
    if (url === `${CFS}/matchItems/round/TEST-R1`) return Response.json({ items: [matchItem] });
    return new Response("unexpected", { status: 404, statusText: "Not Found" });
  });
  // January 2027: the calendar year has turned but the 2027 season has not started.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2027-01-15T03:05:00Z"));

  const results = await sync(env, ["AFLM"], { skipShouldRunNow: true });

  expect(results).toEqual([
    expect.objectContaining({
      competition: "AFLM",
      year: 2026,
      seasonKey: "2026",
      matches: 1,
    }),
  ]);
  expect(results[0]).not.toHaveProperty("error");
  expect(
    await env.DB.prepare(
      "SELECT s.year, COUNT(m.id) AS matches FROM seasons s JOIN matches m ON m.season_id = s.id GROUP BY s.year",
    ).all(),
  ).toMatchObject({ results: [{ year: 2026, matches: 1 }] });
  expect(requested).not.toContain(`${CFS}/matchItems/round/TEST-2027-R1`);
});
