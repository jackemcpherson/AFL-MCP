import { Predicate } from "effect";
import { describe, expect, it } from "vitest";
import { seasonKey } from "../src/db/seasons";

function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("seasonKey", () => {
  it("rejects AFLW 2022 with a tagged error listing the exact keys", () => {
    const error = thrownBy(() => seasonKey("AFLW", 2022));
    expect(error).toBeInstanceOf(Error);
    expect(Predicate.isTagged(error, "SeasonSelectionError")).toBe(true);
    expect(error).toMatchObject({
      message: "Ambiguous AFLW season 2022; choose 2022-S6 or 2022-S7",
      code: "AMBIGUOUS_SEASON",
      validSelectors: ["2022-S6", "2022-S7"],
    });
  });

  it("rejects a malformed selector with no suggested keys", () => {
    const error = thrownBy(() => seasonKey("AFLM", "20x5"));
    expect(Predicate.isTagged(error, "SeasonSelectionError")).toBe(true);
    expect(error).toMatchObject({ code: "INVALID_SEASON", validSelectors: [] });
  });
});
