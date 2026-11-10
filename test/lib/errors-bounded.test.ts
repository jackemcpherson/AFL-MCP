import { describe, expect, it } from "vitest";
import { boundedErrorText } from "../../src/lib/errors";

describe("boundedErrorText", () => {
  it("keeps the first line, strips URL queries and caps the length", () => {
    expect(boundedErrorText(new Error("GET https://x.test/a?key=s#f failed\nstack"))).toBe(
      "GET https://x.test/a failed",
    );
    expect(boundedErrorText("x".repeat(600))).toHaveLength(501);
    expect(boundedErrorText("")).toBe("sync failed");
  });
});
