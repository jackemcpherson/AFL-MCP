import { describe, expect, it } from "vitest";
import { normalizeCode, normalizeSubmission } from "../../src/sandbox/normalize";

describe("normalizeCode", () => {
  it("leaves a plain function body unchanged", () => {
    const body = "const r = await db.prepare('SELECT 1').all()\nreturn r.results";
    expect(normalizeCode(body)).toBe(body);
  });

  it.each(["js", "ts", "javascript", "typescript", ""])(
    "strips a surrounding ```%s fence",
    (label) => {
      expect(normalizeCode(`\`\`\`${label}\nreturn 1\n\`\`\``)).toBe("return 1");
    },
  );

  it("strips a fence with surrounding whitespace", () => {
    expect(normalizeCode("\n  ```js\nreturn 1\n```\n  ")).toBe("return 1");
  });

  it("keeps backticks inside the body", () => {
    expect(normalizeCode("```js\nreturn `x`\n```")).toBe("return `x`");
  });

  it("invokes a lone async arrow function", () => {
    expect(normalizeCode("async () => {\n  return 1\n}")).toBe(
      "return await (\nasync () => {\n  return 1\n}\n)();",
    );
  });

  it("drops a trailing semicolon from a lone async arrow function", () => {
    expect(normalizeCode("async () => { return 1 };")).toBe(
      "return await (\nasync () => { return 1 }\n)();",
    );
  });

  it("invokes an anonymous async function expression", () => {
    expect(normalizeCode("async function () { return 1 }")).toBe(
      "return await (\nasync function () { return 1 }\n)();",
    );
  });

  it("invokes a fenced async arrow function", () => {
    expect(normalizeCode("```js\nasync () => { return 1 }\n```")).toBe(
      "return await (\nasync () => { return 1 }\n)();",
    );
  });

  it("leaves a named async function declaration as body code", () => {
    const body = "async function load() { return 1 }\nreturn load()";
    expect(normalizeCode(body)).toBe(body);
  });
});

describe("normalizeSubmission", () => {
  it.each([
    ["a plain body", "const a = 1\nreturn a", "const a = 1\nreturn a"],
    ["a fenced body", "  ```ts\n  const a = 1\nreturn a\n```", "const a = 1\nreturn a"],
    [
      "a lone async arrow",
      "```js\nasync () => {\n  return 1\n};\n```",
      "async () => {\n  return 1\n}",
    ],
  ])("locates the submitted text of %s in the body", (_shape, code, kept) => {
    const { body, bodyStart, sourceStart, length } = normalizeSubmission(code);
    expect(body.slice(bodyStart, bodyStart + length)).toBe(kept);
    expect(code.slice(sourceStart, sourceStart + length)).toBe(kept);
  });
});
