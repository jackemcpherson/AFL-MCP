import { describe, expect, it } from "vitest";
import { TypeScriptSyntaxError, transpileAgentCode } from "../src/sandbox/transpile";

/** Evaluates transpiled output with a stub `db`, mirroring the sandbox wrapper. */
async function run(code: string, db: unknown = {}): Promise<unknown> {
  const js = transpileAgentCode(code);
  const factory = new Function("db", `${js}\nreturn __agent();`) as (
    db: unknown,
  ) => Promise<unknown>;
  return await factory(db);
}

describe("transpileAgentCode", () => {
  it("strips type annotations", async () => {
    expect(await run("const answer: number = 42;\nreturn { answer };")).toEqual({ answer: 42 });
  });

  it("strips interfaces, type aliases, assertions, generics and satisfies", async () => {
    const code = [
      "interface Row { id: number }",
      "type Rows = Row[];",
      "const rows = [{ id: 7 }] as Rows;",
      "const first = rows[0]!;",
      "const cfg = { a: 1 } satisfies Record<string, number>;",
      "function id<T>(v: T): T { return v }",
      "return { id: first.id, a: cfg.a, s: id<string>('s') };",
    ].join("\n");
    expect(await run(code)).toEqual({ id: 7, a: 1, s: "s" });
  });

  it("supports enums", async () => {
    expect(await run("enum E { A, B }\nreturn E.B;")).toBe(1);
  });

  it("keeps top-level await and plain JavaScript working", async () => {
    const db = { value: async () => 3 };
    expect(await run("const v = await db.value();\nreturn v * 2;", db)).toBe(6);
  });

  it("tolerates a trailing line comment", async () => {
    expect(await run("return 1 // done")).toBe(1);
  });

  it("reports syntax errors at the caller's line and column", () => {
    expect(() => transpileAgentCode("const a = 1;\nreturn a +")).toThrow(TypeScriptSyntaxError);
    expect(() => transpileAgentCode("const a = 1;\nreturn a +")).toThrow(/\(3:\d+\)/);
    expect(() => transpileAgentCode("return )")).toThrow(/TypeScript syntax error: .*\(1:8\)/);
  });
});
