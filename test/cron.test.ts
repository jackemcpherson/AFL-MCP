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
