import { Effect, Predicate, Schema } from "effect";
import { AflApi, fetchSeasons } from "fitzroy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestUrl } from "#test/fixtures";

type FitzroyModule = typeof import("../../src/lib/fitzroy");

class ProviderDown extends Schema.TaggedError<ProviderDown>()("ProviderDown", {
  message: Schema.String,
}) {}

const COMPSEASONS = "https://aflapi.afl.com.au/afl/v2/competitions/1/compseasons?pageSize=100";
const TOKEN = "https://api.afl.com.au/cfs/afl/WMCTok";

// The adapter keeps one runtime, and so one cached AFL API token, per module
// instance. A fresh import per test gives each test its own runtime.
let adapter: FitzroyModule;

beforeEach(async () => {
  vi.resetModules();
  adapter = await import("../../src/lib/fitzroy");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function compseasons(...names: string[]): Response {
  return Response.json({
    compSeasons: names.map((name, id) => ({ id, name })),
  });
}

describe("runFitzroy", () => {
  it("returns the call's tagged failure unchanged", async () => {
    const failure = new ProviderDown({ message: "AFL API 503" });
    const outcome = await adapter.runFitzroy(Effect.fail(failure));
    expect(outcome).toEqual({ success: false, error: failure });
  });

  it("returns a fitzroy HTTP failure as a tagged error with the v6 message", async () => {
    vi.stubGlobal(
      "fetch",
      async () => new Response("missing", { status: 404, statusText: "Not Found" }),
    );
    const outcome = await adapter.runFitzroy(fetchSeasons("AFLM"));
    if (outcome.success) throw new Error("expected a failure");
    expect(outcome.error).toBeInstanceOf(Error);
    expect(Predicate.isTagged(outcome.error, "AflApiError")).toBe(true);
    expect(outcome.error.message).toBe("Request failed: 404 Not Found");
  });

  it("returns a fetch that throws as a tagged failure with the thrown message", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("network down");
    });
    const outcome = await adapter.runFitzroy(fetchSeasons("AFLM"));
    if (outcome.success) throw new Error("expected a failure");
    expect(Predicate.isTagged(outcome.error, "AflApiError")).toBe(true);
    expect(outcome.error.message).toBe("Request failed: network down");
  });

  it("returns a fetch that rejects with a non-Error as a tagged failure", async () => {
    vi.stubGlobal("fetch", () => Promise.reject("socket hang up"));
    const outcome = await adapter.runFitzroy(fetchSeasons("AFLM"));
    if (outcome.success) throw new Error("expected a failure");
    expect(outcome.error).toBeInstanceOf(Error);
    expect(outcome.error.message).toBe("Request failed: socket hang up");
  });

  it("settles a crash inside fitzroy as a FitzroyDefectError instead of throwing", async () => {
    // A fetch that resolves to no Response makes fitzroy itself throw.
    vi.stubGlobal("fetch", async () => undefined);
    const outcome = await adapter.runFitzroy(fetchSeasons("AFLM"));
    if (outcome.success) throw new Error("expected a failure");
    expect(outcome.error).toBeInstanceOf(adapter.FitzroyDefectError);
    expect(Predicate.isTagged(outcome.error, "FitzroyDefectError")).toBe(true);
    expect(outcome.error.message).not.toBe("");
  });

  it("wraps a defect in a tagged FitzroyDefectError that keeps its message", async () => {
    const outcome = await adapter.runFitzroy(Effect.die(new TypeError("cannot read rounds")));
    expect(outcome.success).toBe(false);
    if (outcome.success) return;
    expect(outcome.error).toBeInstanceOf(Error);
    expect(Predicate.isTagged(outcome.error, "FitzroyDefectError")).toBe(true);
    expect(outcome.error.message).toBe("cannot read rounds");
  });

  it("wraps a non-Error defect with its string form", async () => {
    const outcome = await adapter.runFitzroy(Effect.die("bad state"));
    if (outcome.success) throw new Error("expected a failure");
    expect(Predicate.isTagged(outcome.error, "FitzroyDefectError")).toBe(true);
    expect(outcome.error.message).toBe("bad state");
  });

  it("uses a fetch stub swapped in after the runtime was built", async () => {
    vi.stubGlobal("fetch", async () => compseasons("2025 Toyota AFL Premiership"));
    const first = await adapter.runFitzroy(fetchSeasons("AFLM"));
    vi.stubGlobal("fetch", async () => compseasons("2026 Toyota AFL Premiership"));
    const second = await adapter.runFitzroy(fetchSeasons("AFLM"));
    expect(first).toMatchObject({
      success: true,
      data: [{ seasonKey: "2025" }],
    });
    expect(second).toMatchObject({
      success: true,
      data: [{ seasonKey: "2026" }],
    });
  });

  it("requests one AFL API token and reuses it across calls", async () => {
    const tokensSent: (string | null)[] = [];
    let tokenRequests = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url === TOKEN) {
        tokenRequests += 1;
        return Response.json({ token: `token-${tokenRequests}` });
      }
      tokensSent.push(new Headers(init?.headers).get("x-media-mis-token"));
      return Response.json({ items: [] });
    });
    const roundItems = AflApi.use((api) => api.fetchRoundMatchItems("CD_R202601401"));
    expect(await adapter.runFitzroy(roundItems)).toEqual({
      success: true,
      data: [],
    });
    expect(await adapter.runFitzroy(roundItems)).toEqual({
      success: true,
      data: [],
    });
    expect(tokenRequests).toBe(1);
    expect(tokensSent).toEqual(["token-1", "token-1"]);
  });

  it("starts each test without a cached token", async () => {
    let tokenRequests = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (requestUrl(input) === TOKEN) tokenRequests += 1;
      return requestUrl(input) === TOKEN
        ? Response.json({ token: "fresh" })
        : Response.json({ items: [] });
    });
    await adapter.runFitzroy(AflApi.use((api) => api.fetchRoundMatchItems("CD_R202601401")));
    expect(tokenRequests).toBe(1);
  });
});

describe("runFitzroyOrThrow", () => {
  it("returns the data of a successful call", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) =>
      requestUrl(input) === COMPSEASONS
        ? compseasons("2026 Toyota AFL Premiership")
        : new Response(null, { status: 404 }),
    );
    await expect(adapter.runFitzroyOrThrow(fetchSeasons("AFLM"))).resolves.toMatchObject([
      { seasonKey: "2026", year: 2026 },
    ]);
  });

  it("throws the tagged failure", async () => {
    await expect(
      adapter.runFitzroyOrThrow(Effect.fail(new ProviderDown({ message: "down" }))),
    ).rejects.toBeInstanceOf(ProviderDown);
  });

  it("throws a fitzroy HTTP failure with the v6 message", async () => {
    vi.stubGlobal(
      "fetch",
      async () => new Response("missing", { status: 404, statusText: "Not Found" }),
    );
    await expect(adapter.runFitzroyOrThrow(fetchSeasons("AFLM"))).rejects.toThrow(
      "Request failed: 404 Not Found",
    );
  });
});
