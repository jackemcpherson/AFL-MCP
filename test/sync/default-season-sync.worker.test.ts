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

const upcomingItem = {
  ...matchItem,
  match: {
    ...matchItem.match,
    matchId: "M-2027-1",
    status: "UPCOMING",
    date: "2027-03-11T08:30:00.000+0000",
    utcStartTime: "2027-03-11T08:30:00",
    round: "TEST-2027-R1",
  },
  round: { ...matchItem.round, roundId: "TEST-2027-R1" },
  score: null,
};

/** Stub the AFL API with a finished 2026 season and a published 2027 fixture. */
function stubSeasons(options: { readonly datedNextSeason?: boolean } = {}): string[] {
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
            ...(options.datedNextSeason !== false && { utcStartTime: "2027-03-11T08:30:00Z" }),
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
    if (url === `${CFS}/matchItems/round/TEST-2027-R1`)
      return Response.json({ items: [upcomingItem] });
    return new Response("unexpected", { status: 404, statusText: "Not Found" });
  });
  return requested;
}

const storedSeasons = async () =>
  (
    await env.DB.prepare(
      "SELECT s.year, COUNT(m.id) AS matches FROM seasons s JOIN matches m ON m.season_id = s.id GROUP BY s.year ORDER BY s.year",
    ).all()
  ).results;

it("syncs the latest started season when no season is given", async () => {
  const requested = stubSeasons();
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
  expect(await storedSeasons()).toEqual([{ year: 2026, matches: 1 }]);
  // Between hourly ticks an unknown later season costs no provider calls.
  expect(requested).not.toContain(`${CFS}/matchItems/round/TEST-2027-R1`);
});

it("loads the next season's fixture on an hourly tick, before it starts", async () => {
  stubSeasons();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2027-01-15T03:00:00Z"));

  const results = await sync(env, ["AFLM"], { fixturesOnly: true, skipShouldRunNow: true });

  expect(results.map((result) => result.seasonKey)).toEqual(["2026", "2027"]);
  expect(await storedSeasons()).toEqual([
    { year: 2026, matches: 1 },
    { year: 2027, matches: 1 },
  ]);
  expect(
    await env.DB.prepare(
      "SELECT m.status, m.round_number FROM matches m JOIN seasons s ON s.id=m.season_id WHERE s.year=2027",
    ).first(),
  ).toEqual({ status: "Upcoming", round_number: 1 });

  // Once stored, the upcoming season stays in scope on five-minute ticks.
  const requested = stubSeasons();
  vi.setSystemTime(new Date("2027-01-15T03:05:00Z"));
  await sync(env, ["AFLM"], { fixturesOnly: true, skipShouldRunNow: true });
  expect(requested).toContain(`${CFS}/matchItems/round/TEST-2027-R1`);
});

it("falls back to the stored season when a newly listed season has no round dates", async () => {
  stubSeasons();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-15T03:05:00Z"));
  await sync(env, ["AFLM"], { fixturesOnly: true, skipShouldRunNow: true });

  stubSeasons({ datedNextSeason: false });
  const results = await sync(env, ["AFLM"], { fixturesOnly: true, skipShouldRunNow: true });

  expect(results).toEqual([expect.objectContaining({ seasonKey: "2026" })]);
  expect(results[0]).not.toHaveProperty("error");
  expect(
    await env.DB.prepare("SELECT error FROM sync_log WHERE type='sync:season-fallback'").first(
      "error",
    ),
  ).toContain("using stored season 2026");
});
