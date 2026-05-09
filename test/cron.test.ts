import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isMatchWindow } from "../src/sync/cron";

describe("isMatchWindow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // Helper: set the current time to a specific UTC datetime
  function setUtc(isoString: string) {
    vi.setSystemTime(new Date(isoString));
  }

  it("returns false on Wednesday (outside match window)", () => {
    // Wed 2026-04-01 12:00 UTC = Wed 22:00 AEST
    setUtc("2026-04-01T12:00:00Z");
    expect(isMatchWindow()).toBe(false);
  });

  it("returns false on Thursday before 6pm AEST", () => {
    // Thu 2026-04-02 07:00 UTC = Thu 17:00 AEST (5pm)
    setUtc("2026-04-02T07:00:00Z");
    expect(isMatchWindow()).toBe(false);
  });

  it("returns true on Thursday at 6pm AEST", () => {
    // Thu 2026-04-02 08:00 UTC = Thu 18:00 AEST (6pm)
    setUtc("2026-04-02T08:00:00Z");
    expect(isMatchWindow()).toBe(true);
  });

  it("returns true on Thursday at 11pm AEST", () => {
    // Thu 2026-04-02 13:00 UTC = Thu 23:00 AEST
    setUtc("2026-04-02T13:00:00Z");
    expect(isMatchWindow()).toBe(true);
  });

  it("returns true on Friday", () => {
    // Fri 2026-04-03 10:00 UTC
    setUtc("2026-04-03T10:00:00Z");
    expect(isMatchWindow()).toBe(true);
  });

  it("returns true on Saturday", () => {
    // Sat 2026-04-04 06:00 UTC
    setUtc("2026-04-04T06:00:00Z");
    expect(isMatchWindow()).toBe(true);
  });

  it("returns true on Sunday", () => {
    // Sun 2026-04-05 08:00 UTC
    setUtc("2026-04-05T08:00:00Z");
    expect(isMatchWindow()).toBe(true);
  });

  it("returns false once Monday AEST moves past the Sunday UTC window", () => {
    // Mon 00:30 UTC = Mon 10:30 AEST — UTC day=1, aestHour=10
    // The day===1 branch requires aestHour<=1, so this is outside the window
    setUtc("2026-04-06T00:30:00Z");
    expect(isMatchWindow()).toBe(false);
  });

  it("returns false on Monday afternoon AEST", () => {
    // Mon 2026-04-06 05:00 UTC = Mon 15:00 AEST, day=1, aestHour=15
    setUtc("2026-04-06T05:00:00Z");
    expect(isMatchWindow()).toBe(false);
  });

  it("returns false on Tuesday", () => {
    // Tue 2026-04-07 10:00 UTC
    setUtc("2026-04-07T10:00:00Z");
    expect(isMatchWindow()).toBe(false);
  });
});

// These cases pin the *current* fixed-UTC+10 behaviour. The function ignores
// AEDT (Melbourne summer time, UTC+11), so the window opens an hour late by
// Melbourne local time during pre-season + early rounds. The shouldRunNow
// rewrite that replaces this function should flip the marked expectations.
describe("isMatchWindow during AEDT (current buggy behaviour, to be flipped)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function setUtc(isoString: string) {
    vi.setSystemTime(new Date(isoString));
  }

  it("treats Thu 6pm AEDT as outside the window — bug, should be true", () => {
    // Thu 2026-03-26 07:00 UTC = Thu 18:00 AEDT (Melbourne local 6pm)
    //                          = Thu 17:00 by UTC+10 (what the code computes)
    // Window should open at Melbourne 6pm; current code says no.
    setUtc("2026-03-26T07:00:00Z");
    expect(isMatchWindow()).toBe(false);
  });

  it("treats Thu 7pm AEDT as inside the window — passes by accident", () => {
    // Thu 2026-03-26 08:00 UTC = Thu 19:00 AEDT (Melbourne local 7pm)
    //                          = Thu 18:00 by UTC+10
    // Right answer for the wrong reason.
    setUtc("2026-03-26T08:00:00Z");
    expect(isMatchWindow()).toBe(true);
  });

  it("treats Mon 1am AEDT (Melbourne midnight) as inside the window — bug, should be false", () => {
    // Mon 2026-03-30 14:00 UTC = Mon 01:00 AEDT (Melbourne local midnight)
    //                          = Mon 00:00 by UTC+10
    // Code's UTC+10 hour = 0, day === 1, branch allows hour <= 1 → true.
    // Melbourne local is 1am Mon, which the AFL still treats as Sunday-night —
    // the intended cutoff is 1am Melbourne, so this should be false.
    setUtc("2026-03-30T14:00:00Z");
    expect(isMatchWindow()).toBe(true);
  });
});

describe("isMatchWindow during AEST (mid/late season, no DST)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function setUtc(isoString: string) {
    vi.setSystemTime(new Date(isoString));
  }

  it("returns true at Thu 6pm AEST in mid-season", () => {
    // Thu 2026-06-25 08:00 UTC = Thu 18:00 AEST
    setUtc("2026-06-25T08:00:00Z");
    expect(isMatchWindow()).toBe(true);
  });

  it("returns false at Thu 5pm AEST in mid-season", () => {
    // Thu 2026-06-25 07:00 UTC = Thu 17:00 AEST
    setUtc("2026-06-25T07:00:00Z");
    expect(isMatchWindow()).toBe(false);
  });

  it("returns true at Mon 0:30am AEST (still in the Sunday-night tail)", () => {
    // Mon 2026-06-29 14:30 UTC = Mon 00:30 AEST
    setUtc("2026-06-29T14:30:00Z");
    expect(isMatchWindow()).toBe(true);
  });
});
