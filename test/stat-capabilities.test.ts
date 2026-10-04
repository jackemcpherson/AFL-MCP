import { describe, expect, it } from "vitest";
import { statFieldCapabilities } from "../src/sync/stat-capabilities";

describe("source-backed field capabilities", () => {
  it("preserves the distinct AFLW 2022 source samples", () => {
    const six = statFieldCapabilities("AFLW", "2022-S6");
    const seven = statFieldCapabilities("AFLW", "2022-S7");
    expect(six.evidence).not.toBeNull();
    expect(seven.evidence).not.toBeNull();
    expect(six.evidence?.url).not.toBe(seven.evidence?.url);
    expect(six.notApplicable).toContain("brownlow_votes");
  });
  it("does not extrapolate current support to unverified historical eras", () => {
    const historical = statFieldCapabilities("AFLM", "1990");
    expect(historical.supported).toEqual([]);
    expect(historical.evidence).toBeNull();
    expect(statFieldCapabilities("AFLM", "2026").supported).toContain("kicks");
  });
});
