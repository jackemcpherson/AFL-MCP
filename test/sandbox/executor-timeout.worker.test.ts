/**
 * Wall-clock timeouts through a real Dynamic Worker: the sandbox stops
 * waiting just inside the budget, so console output written before the
 * timeout still reaches the model.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { testCtx } from "#test/fixtures";
import { executeCode } from "../../src/sandbox/executor";

const ctx = testCtx({ DbProxy: () => ({}) });

describe("executeCode timeout in the sandbox", () => {
  it("returns console lines written before the timeout", async () => {
    const code =
      "console.log('waiting')\nawait new Promise((r) => setTimeout(r, 30_000))\nreturn 1";
    const result = await executeCode(code, env, ctx, 5_000);
    expect(result.result).toBeNull();
    expect(result.error).toBe("Execution timed out after 5s");
    expect(result.errorClass).toBe("SandboxTimeoutError");
    expect(result.logs).toEqual(["waiting"]);
  });
});
