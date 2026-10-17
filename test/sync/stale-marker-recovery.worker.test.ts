import { env } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { requestUrl } from "#test/fixtures";
import { sync } from "../../src/sync/sync";
import matchItem from "../fixtures/fixture-only-match.json";

const API = "https://aflapi.afl.com.au/afl/v2";
const CFS = "https://api.afl.com.au/cfs/afl";
const SCHEDULED_OPERATION = 'sync:[{"competition":"AFLM","season":2026}]';

beforeEach(() => {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = requestUrl(input);
    if (url === `${CFS}/WMCTok`) return Response.json({ token: "fixture-token" });
    if (url === `${API}/competitions/1/compseasons?pageSize=100`)
      return Response.json({
        compSeasons: [{ id: 85, name: "2026 Toyota AFL Premiership" }],
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
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-17T03:05:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Leave the marker as a crashed writer does: set, owned by a holder with no lease. */
async function strandMarker(operation: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("UPDATE sync_lease SET holder=NULL, acquired_at=NULL WHERE id=1"),
    env.DB.prepare(
      `UPDATE public_input_revision SET in_progress=1, write_started_at='2026-10-17T01:00:28.962Z',
       write_holder='crashed-holder', write_operation=?1 WHERE id=1`,
    ).bind(operation),
  ]);
}

it("recovers a scheduled sync stranded by its own crashed run", async () => {
  await strandMarker(SCHEDULED_OPERATION);

  const results = await sync(env, ["AFLM"], { skipShouldRunNow: true });

  expect(results).toEqual([expect.objectContaining({ competition: "AFLM", matches: 1 })]);
  expect(
    await env.DB.prepare(
      "SELECT in_progress, write_holder, write_operation FROM public_input_revision WHERE id=1",
    ).first(),
  ).toEqual({ in_progress: 0, write_holder: null, write_operation: null });
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM sync_log WHERE type='sync:recovered' AND error LIKE '%crashed-holder%'",
    ).first("n"),
  ).toBe(1);
});

it("still refuses a stranded marker from a different operation", async () => {
  await strandMarker("identity:some-digest");

  await expect(sync(env, ["AFLM"], { skipShouldRunNow: true })).rejects.toThrow(
    "Input write requires an active lease and a recovered public marker",
  );
  expect(
    await env.DB.prepare("SELECT in_progress, write_operation FROM public_input_revision").first(),
  ).toEqual({ in_progress: 1, write_operation: "identity:some-digest" });
});

it("leaves a stranded backfill for explicit operator recovery", async () => {
  await strandMarker(SCHEDULED_OPERATION);

  await expect(sync(env, ["AFLM"], { season: 2026, skipShouldRunNow: true })).rejects.toThrow(
    "Input write requires an active lease and a recovered public marker",
  );
  expect(
    await env.DB.prepare("SELECT in_progress FROM public_input_revision").first("in_progress"),
  ).toBe(1);
});
