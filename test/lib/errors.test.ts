import { afterEach, describe, expect, it, vi } from "vitest";
import { OperationConflictError } from "../../src/admin/errors";
import { describeError, errorType, logError } from "../../src/lib/errors";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("describeError", () => {
  it("reads an Error's message and stringifies anything else", () => {
    expect(describeError(new Error("boom"))).toBe("boom");
    expect(describeError("plain")).toBe("plain");
    expect(describeError(42)).toBe("42");
  });
});

describe("errorType", () => {
  it.each([
    [new OperationConflictError({ message: "stale" }), "OperationConflictError"],
    [new TypeError("x"), "TypeError"],
    [new RangeError("x"), "Error"],
    [new Error("x"), "Error"],
    ["thrown string", "Error"],
    [{ _tag: 7 }, "Error"],
  ])("names %o as %s", (error, expected) => {
    expect(errorType(error)).toBe(expected);
  });
});

describe("logError", () => {
  it("writes one JSON line with the event, fields, tag and src frames but never the message", () => {
    const lines: unknown[] = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      lines.push(line);
    });
    const error = new Error("secret https://token@upstream.test");
    error.stack = [
      "Error: secret https://token@upstream.test",
      "    at run (src/sync/sync.ts:161:12)",
      "    at node_modules/fitzroy/dist/index.js:1:1",
      "    at main (/worker/src/index.ts:9:3)",
    ].join("\n");

    logError("sync_fatal", error, { path: "/mcp/admin/sync" });

    expect(lines).toHaveLength(1);
    expect(JSON.parse(String(lines[0]))).toEqual({
      event: "sync_fatal",
      path: "/mcp/admin/sync",
      errorType: "Error",
      frames: ["src/sync/sync.ts:161:12", "src/index.ts:9:3"],
    });
    expect(String(lines[0])).not.toContain("secret");
  });

  it("logs no frames for a non-Error value", () => {
    const lines: unknown[] = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      lines.push(line);
    });
    logError("event", "thrown text");
    expect(JSON.parse(String(lines[0]))).toEqual({
      event: "event",
      errorType: "Error",
      frames: [],
    });
    expect(String(lines[0])).not.toContain("thrown text");
  });
});
