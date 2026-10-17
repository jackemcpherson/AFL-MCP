import { Effect, Predicate, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { runFitzroy, runFitzroyOrThrow } from "../src/lib/fitzroy";

class ProviderDown extends Schema.TaggedError<ProviderDown>()("ProviderDown", {
  message: Schema.String,
}) {}

describe("runFitzroy", () => {
  it("returns the call's tagged failure unchanged", async () => {
    const failure = new ProviderDown({ message: "AFL API 503" });
    const outcome = await runFitzroy(Effect.fail(failure));
    expect(outcome).toEqual({ success: false, error: failure });
  });

  it("wraps a defect in a tagged FitzroyDefectError that keeps its message", async () => {
    const outcome = await runFitzroy(Effect.die(new TypeError("cannot read rounds")));
    expect(outcome.success).toBe(false);
    if (outcome.success) return;
    expect(outcome.error).toBeInstanceOf(Error);
    expect(Predicate.isTagged(outcome.error, "FitzroyDefectError")).toBe(true);
    expect(outcome.error.message).toBe("cannot read rounds");
  });

  it("wraps a non-Error defect with its string form", async () => {
    const outcome = await runFitzroy(Effect.die("bad state"));
    if (outcome.success) throw new Error("expected a failure");
    expect(Predicate.isTagged(outcome.error, "FitzroyDefectError")).toBe(true);
    expect(outcome.error.message).toBe("bad state");
  });
});

describe("runFitzroyOrThrow", () => {
  it("throws the tagged failure", async () => {
    await expect(
      runFitzroyOrThrow(Effect.fail(new ProviderDown({ message: "down" }))),
    ).rejects.toBeInstanceOf(ProviderDown);
  });
});
