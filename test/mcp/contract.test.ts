/**
 * Golden tests pinning the public MCP contract (#214).
 *
 * Every response a Claude client can observe from `/mcp` is serialised to a
 * golden file under `test/fixtures/golden/mcp/`. A diff in one of those files
 * is a deliberate contract change. Collaborators are injected through the
 * `deps` argument of `handleMcpRequest`, so this file uses no module mocks.
 * Only the sandbox executor is faked: the schema goldens run the real
 * `getSchemaInfo`, because faking it would pin nothing.
 */
import { Predicate } from "effect";
import { describe, expect, it } from "vitest";
import { testCtx, testEnv } from "#test/fixtures";
import pkg from "../../package.json";
import { defaultDeps, handleMcpRequest, type McpDeps } from "../../src/mcp/protocol";
import type { ExecuteResult } from "../../src/sandbox/executor";
import { assertReadOnlySql } from "../../src/sandbox/sql-guard";
import { truncateResult } from "../../src/sandbox/truncate";
import type { Env } from "../../src/types";

const GOLDEN_DIR = "../fixtures/golden/mcp";

/** Placeholder for `serverInfo.version`, which changes every release. */
const VERSION_PLACEHOLDER = "<package.json version>";

const stubEnv = testEnv();
const stubCtx = testCtx();

/** Headers a client can act on. The rest of the header bag is not contract. */
const PINNED_HEADERS = [
  "content-type",
  "retry-after",
  "allow",
  "access-control-allow-origin",
] as const;

interface GoldenResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

function rpc(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://afl.test/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: Predicate.isString(body) ? body : JSON.stringify(body),
  });
}

function toolCall(name: string, args?: Record<string, unknown>): Request {
  return rpc({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: args === undefined ? { name } : { name, arguments: args },
  });
}

function withExecutor(result: ExecuteResult): McpDeps {
  return { ...defaultDeps, executeCode: async () => result };
}

/** Deps with a faked executor, plus how many times it ran. */
interface CountingExecutor {
  readonly deps: McpDeps;
  readonly calls: () => number;
}

/** An executor fake that counts its calls, to prove a request never ran. */
function countingExecutor(): CountingExecutor {
  let count = 0;
  return {
    deps: {
      ...defaultDeps,
      executeCode: async () => {
        count += 1;
        return { result: count, execution_time_ms: 1 };
      },
    },
    calls: () => count,
  };
}

async function capture(res: Response): Promise<GoldenResponse> {
  const headers: Record<string, string> = {};
  for (const name of PINNED_HEADERS) {
    const value = res.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  const text = await res.text();
  // SAFETY: widens JSON.parse's `any` to `unknown`; goldens compare it as data.
  return {
    status: res.status,
    headers,
    body: text === "" ? null : (JSON.parse(text) as unknown),
  };
}

async function expectGolden(name: string, value: unknown): Promise<void> {
  await expect(`${JSON.stringify(value, null, 2)}\n`).toMatchFileSnapshot(
    `${GOLDEN_DIR}/${name}.json`,
  );
}

async function serve(
  request: Request,
  options: { env?: Env; deps?: McpDeps } = {},
): Promise<GoldenResponse> {
  return capture(await handleMcpRequest(request, options.env ?? stubEnv, stubCtx, options.deps));
}

describe("MCP contract: lifecycle", () => {
  it("initialize returns the pinned server capabilities and protocol version", async () => {
    const golden = await serve(rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));
    // SAFETY: an initialize reply always carries result.serverInfo.version.
    const body = golden.body as { result: { serverInfo: { version: string } } };
    expect(body.result.serverInfo.version).toBe(pkg.version);
    body.result.serverInfo.version = VERSION_PLACEHOLDER;
    await expectGolden("initialize", golden);
  });

  it.each([
    ["2025-11-25", "2025-11-25"],
    ["2025-06-18", "2025-06-18"],
    ["2025-03-26", "2025-03-26"],
    ["2024-11-05", "2025-11-25"],
    ["2026-07-28", "2025-11-25"],
  ])("initialize requesting %s negotiates %s", async (requested, negotiated) => {
    const res = await handleMcpRequest(
      rpc({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: requested },
      }),
      stubEnv,
      stubCtx,
    );
    const body = await res.json<{ result: { protocolVersion: string } }>();
    expect(res.status).toBe(200);
    expect(body.result.protocolVersion).toBe(negotiated);
  });

  it("tools/list returns the pinned tool definitions", async () => {
    await expectGolden(
      "tools-list",
      await serve(rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" })),
    );
  });

  it("ping returns an empty result", async () => {
    await expectGolden("ping", await serve(rpc({ jsonrpc: "2.0", id: 3, method: "ping" })));
  });
});

describe("MCP contract: schema tool", () => {
  it("returns the full schema when called with no arguments", async () => {
    await expectGolden("schema-full", await serve(toolCall("schema")));
  });

  it("returns the competition-filtered schema for competition alone", async () => {
    await expectGolden(
      "schema-competition-aflw",
      await serve(toolCall("schema", { competition: "AFLW" })),
    );
  });

  const argumentErrors: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ["unknown-key", { table: "matches" }],
    ["bad-competition", { competition: "NRL" }],
    ["bad-include-observed-type", { includeObserved: "yes" }],
    ["season-without-include-observed", { competition: "AFLM", season: 2025 }],
    ["include-observed-without-season", { competition: "AFLM", includeObserved: true }],
    ["include-observed-without-competition", { season: 2025, includeObserved: true }],
    ["aflw-2022-ambiguous", { competition: "AFLW", season: 2022, includeObserved: true }],
    [
      "split-season-outside-aflw",
      { competition: "AFLM", season: "2022-S6", includeObserved: true },
    ],
    ["season-before-coverage", { competition: "AFLM", season: 1900, includeObserved: true }],
  ];

  it.each(argumentErrors)("returns pinned error text for %s", async (name, args) => {
    await expectGolden(`schema-error-${name}`, await serve(toolCall("schema", args)));
  });
});

describe("MCP contract: code tool", () => {
  it("pretty-prints an object result and adds it as structured content", async () => {
    const deps = withExecutor({
      result: { results: [{ team: "Carlton", wins: 12 }], success: true },
      execution_time_ms: 5,
    });
    await expectGolden(
      "code-object-result",
      await serve(toolCall("code", { code: "return 1" }), { deps }),
    );
  });

  it("passes a string result through as raw text", async () => {
    const deps = withExecutor({
      result: "plain text result",
      execution_time_ms: 5,
    });
    await expectGolden(
      "code-string-result",
      await serve(toolCall("code", { code: "return 'x'" }), { deps }),
    );
  });

  it("returns an array result as text only, with no structured content", async () => {
    const deps = withExecutor({
      result: [{ team: "Carlton", wins: 12 }],
      execution_time_ms: 5,
    });
    await expectGolden(
      "code-array-result",
      await serve(toolCall("code", { code: "return []" }), { deps }),
    );
  });

  it("reports executor errors with the execution time", async () => {
    const deps = withExecutor({
      result: null,
      error: "Execution timed out after 30s",
      execution_time_ms: 30_000,
    });
    await expectGolden(
      "code-execution-error",
      await serve(toolCall("code", { code: "while(true){}" }), { deps }),
    );
  });

  it("returns console output in a second text block after the result", async () => {
    const deps = withExecutor({
      result: { results: [{ team: "Carlton", wins: 12 }], success: true },
      logs: ["rows: 1", "[warn] slow query"],
      execution_time_ms: 5,
    });
    await expectGolden(
      "code-console-output",
      await serve(toolCall("code", { code: "console.log('rows: 1'); return r" }), { deps }),
    );
  });

  it("returns console output with an execution error", async () => {
    const deps = withExecutor({
      result: null,
      error: "x is not a function",
      errorClass: "TypeError",
      logs: ["before the failure"],
      execution_time_ms: 3,
    });
    await expectGolden(
      "code-console-error",
      await serve(toolCall("code", { code: "console.log('before the failure'); x()" }), { deps }),
    );
  });

  it("returns a structurally truncated result as valid structured content", async () => {
    const results = Array.from({ length: 50 }, (_, id) => ({ id, team: `Team ${id}` }));
    const deps = withExecutor({
      result: truncateResult({ results, success: true }, 400),
      execution_time_ms: 5,
    });
    await expectGolden(
      "code-truncated-result",
      await serve(toolCall("code", { code: "return big" }), { deps }),
    );
  });

  it("adds the JavaScript hint to a syntax error in TypeScript code", async () => {
    const deps = withExecutor({
      result: null,
      error: "SyntaxError: Unexpected token ':'",
      errorClass: "SyntaxError",
      execution_time_ms: 1,
    });
    await expectGolden(
      "code-typescript-syntax-error",
      await serve(toolCall("code", { code: "const f = (x: number) => x\nreturn f(1)" }), { deps }),
    );
  });

  it("surfaces the read-only SQL guard message as an execution error", async () => {
    // The sandbox RPC boundary prefixes the message with the error's class name,
    // as `test/sandbox/security.worker.test.ts` verifies against the real executor.
    let guardMessage = "";
    try {
      assertReadOnlySql("DELETE FROM matches");
    } catch (err) {
      guardMessage = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    }
    const deps = withExecutor({
      result: null,
      error: guardMessage,
      execution_time_ms: 2,
    });
    await expectGolden(
      "code-sql-guard-error",
      await serve(
        toolCall("code", {
          code: "return db.prepare('DELETE FROM matches').all()",
        }),
        {
          deps,
        },
      ),
    );
  });

  it("rejects an empty code argument", async () => {
    await expectGolden("code-empty", await serve(toolCall("code", { code: "  " })));
  });

  it("rejects a missing code argument", async () => {
    await expectGolden("code-missing", await serve(toolCall("code", {})));
  });

  it("rejects an unknown argument without running the code", async () => {
    const { deps, calls } = countingExecutor();
    await expectGolden(
      "code-unknown-argument",
      await serve(toolCall("code", { code: "return 1", table: "matches" }), {
        deps,
      }),
    );
    expect(calls()).toBe(0);
  });

  it("rejects an unknown argument alongside an empty code argument", async () => {
    await expectGolden(
      "code-unknown-argument-empty-code",
      await serve(toolCall("code", { code: "", extra: 1 })),
    );
  });

  it("rejects an unrecognised competition", async () => {
    const deps = withExecutor({ result: 1, execution_time_ms: 1 });
    await expectGolden(
      "code-invalid-competition",
      await serve(toolCall("code", { code: "return 1", competition: "NRL" }), {
        deps,
      }),
    );
  });

  it("treats a null competition as omitted", async () => {
    const deps = withExecutor({ result: 1, execution_time_ms: 1 });
    await expectGolden(
      "code-null-competition",
      await serve(toolCall("code", { code: "return 1", competition: null }), {
        deps,
      }),
    );
  });

  it("reports the operator kill switch", async () => {
    const env = testEnv({ CODE_TOOL_DISABLED: "true" });
    await expectGolden(
      "code-disabled",
      await serve(toolCall("code", { code: "return 1" }), { env }),
    );
  });
});

describe("MCP contract: read-only SQL guard", () => {
  const statements: ReadonlyArray<readonly [string, string]> = [
    ["leading-keyword", "DELETE FROM matches"],
    ["forbidden-keyword-behind-cte", "WITH x AS (SELECT 1) DELETE FROM matches"],
    ["pragma", "SELECT 1; PRAGMA table_info(matches)"],
  ];

  it("pins each ReadOnlySqlError message", async () => {
    const messages: Record<string, string> = {};
    for (const [name, sql] of statements) {
      try {
        assertReadOnlySql(sql);
        messages[name] = "<accepted>";
      } catch (err) {
        messages[name] = `${err instanceof Error ? err.name : "unknown"}: ${String(
          err instanceof Error ? err.message : err,
        )}`;
      }
    }
    await expectGolden("sql-guard-errors", messages);
  });
});

describe("MCP contract: transport", () => {
  it("answers OPTIONS with 204 and no body", async () => {
    await expectGolden(
      "transport-options-204",
      await serve(new Request("https://afl.test/mcp", { method: "OPTIONS" })),
    );
  });

  it("rejects GET with 405", async () => {
    await expectGolden(
      "transport-get-405",
      await serve(new Request("https://afl.test/mcp", { method: "GET" })),
    );
  });

  it("rejects rate-limited callers with 429 and Retry-After", async () => {
    const env = testEnv({
      MCP_RATE_LIMIT: { limit: async () => ({ success: false }) },
    });
    await expectGolden(
      "transport-rate-limited-429",
      await serve(rpc({ jsonrpc: "2.0", id: 1, method: "ping" }), { env }),
    );
  });

  it("rejects a non-JSON media type with 415", async () => {
    await expectGolden(
      "transport-media-type-415",
      await serve(rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, { "Content-Type": "text/plain" })),
    );
  });

  it("rejects a media type that only mentions application/json with 415", async () => {
    await expectGolden(
      "transport-media-type-parameter-415",
      await serve(
        rpc(
          { jsonrpc: "2.0", id: 1, method: "ping" },
          { "Content-Type": "text/plain;x=application/json" },
        ),
      ),
    );
  });

  it("accepts application/json with a charset parameter", async () => {
    await expectGolden(
      "transport-media-type-charset-200",
      await serve(
        rpc(
          { jsonrpc: "2.0", id: 1, method: "ping" },
          { "Content-Type": "application/json; charset=utf-8" },
        ),
      ),
    );
  });

  it("rejects malformed JSON with 400", async () => {
    await expectGolden("transport-parse-error-400", await serve(rpc("{not json")));
  });

  it("rejects an invalid JSON-RPC envelope with 400, echoing its id", async () => {
    await expectGolden(
      "transport-invalid-envelope-400",
      await serve(rpc({ jsonrpc: "1.0", id: 7, method: "ping" })),
    );
  });

  it("rejects an invalid JSON-RPC envelope without an id with 400", async () => {
    // Under 2025-03-26 (no header) an array is a batch, so pin a revision
    // that has no batching to keep this a single invalid envelope.
    await expectGolden(
      "transport-invalid-envelope-no-id-400",
      await serve(rpc([1, 2, 3], { "MCP-Protocol-Version": "2025-06-18" })),
    );
  });

  it("serves a request carrying a supported MCP-Protocol-Version header", async () => {
    await expectGolden(
      "transport-protocol-header-200",
      await serve(
        rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, { "MCP-Protocol-Version": "2025-06-18" }),
      ),
    );
  });

  it("rejects an unsupported MCP-Protocol-Version header with 400", async () => {
    await expectGolden(
      "transport-protocol-header-unsupported-400",
      await serve(
        rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, { "MCP-Protocol-Version": "2024-11-05" }),
      ),
    );
  });

  it("rejects a 2026-07-28 request with 400 and plain -32600", async () => {
    await expectGolden(
      "transport-modern-request-400",
      await serve(
        rpc(
          {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/list",
            params: {
              _meta: {
                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                "io.modelcontextprotocol/clientInfo": {
                  name: "probe",
                  version: "1.0.0",
                },
                "io.modelcontextprotocol/clientCapabilities": {},
              },
            },
          },
          { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/list" },
        ),
      ),
    );
  });

  it("rejects modern per-request _meta even without the version header", async () => {
    const res = await handleMcpRequest(
      rpc({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {
          _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
        },
      }),
      stubEnv,
      stubCtx,
    );
    expect(res.status).toBe(400);
    expect((await res.json<{ error: { code: number } }>()).error.code).toBe(-32600);
  });

  it("negotiates initialize even when a 2026-07-28 header is still attached", async () => {
    const res = await handleMcpRequest(
      rpc(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-11-25" },
        },
        { "MCP-Protocol-Version": "2026-07-28" },
      ),
      stubEnv,
      stubCtx,
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ result: { protocolVersion: string } }>();
    expect(body.result.protocolVersion).toBe("2025-11-25");
  });
  it("answers an invalid envelope whose id is not a string or number with id null", async () => {
    await expectGolden(
      "transport-invalid-envelope-object-id-400",
      await serve(rpc({ jsonrpc: "2.0", id: { nested: 1 }, method: "ping" })),
    );
  });
  it("rejects a body over 4 MiB with 413, without relying on Content-Length", async () => {
    const request = rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "code", arguments: { code: "x".repeat(4 * 1024 * 1024) } },
    });
    expect(request.headers.get("content-length")).toBeNull();
    await expectGolden("transport-body-too-large-413", await serve(request));
  });

  it("counts the body cap in bytes, not characters", async () => {
    // 2.1 million two-byte characters: under 4 MiB of characters, over in bytes.
    const res = await handleMcpRequest(
      rpc({
        jsonrpc: "2.0",
        id: 1,
        method: "ping",
        params: { pad: "é".repeat(2_100_000) },
      }),
      stubEnv,
      stubCtx,
    );
    expect(res.status).toBe(413);
  });
  it("rejects a notification with an unsupported header using id null", async () => {
    await expectGolden(
      "transport-notification-unsupported-400",
      await serve(
        rpc(
          { jsonrpc: "2.0", method: "notifications/initialized" },
          { "MCP-Protocol-Version": "2024-11-05" },
        ),
      ),
    );
  });
  it("acknowledges notifications with 202 and no body", async () => {
    await expectGolden(
      "transport-notification-202",
      await serve(rpc({ jsonrpc: "2.0", method: "notifications/initialized" })),
    );
  });

  it("answers unknown methods with -32601", async () => {
    await expectGolden(
      "transport-method-not-found",
      await serve(rpc({ jsonrpc: "2.0", id: 4, method: "resources/list" })),
    );
  });

  it("answers tools/call without a name with -32602", async () => {
    await expectGolden(
      "transport-missing-tool-name",
      await serve(rpc({ jsonrpc: "2.0", id: 5, method: "tools/call", params: {} })),
    );
  });

  it("answers an unknown tool with -32602", async () => {
    await expectGolden("transport-unknown-tool", await serve(toolCall("tools")));
  });

  it("answers -32603 at HTTP 200 when an injected dependency throws", async () => {
    const deps: McpDeps = {
      ...defaultDeps,
      getSchemaInfo: async () => {
        throw new Error("boom");
      },
    };
    await expectGolden("transport-internal-error", await serve(toolCall("schema"), { deps }));
  });
});

describe("MCP contract: JSON-RPC requests without an id", () => {
  it("treats a tools/call without an id as a notification and runs nothing", async () => {
    const { deps, calls } = countingExecutor();
    await expectGolden(
      "transport-request-without-id-202",
      await serve(
        rpc({
          jsonrpc: "2.0",
          method: "tools/call",
          params: { name: "code", arguments: { code: "return 1" } },
        }),
        { deps },
      ),
    );
    expect(calls()).toBe(0);
  });

  it.each(["initialize", "ping", "tools/list", "resources/list"])(
    "answers %s without an id with 202 and no body",
    async (method) => {
      const res = await handleMcpRequest(rpc({ jsonrpc: "2.0", method }), stubEnv, stubCtx);
      expect(res.status).toBe(202);
      expect(await res.text()).toBe("");
    },
  );
});

describe("MCP contract: 2025-03-26 batches", () => {
  const ping = (id: number | string) => ({
    jsonrpc: "2.0",
    id,
    method: "ping",
  });
  const initialized = { jsonrpc: "2.0", method: "notifications/initialized" };

  it("answers each request in order and skips notifications", async () => {
    const { deps, calls } = countingExecutor();
    await expectGolden(
      "transport-batch-200",
      await serve(
        rpc([
          ping(1),
          initialized,
          {
            jsonrpc: "2.0",
            id: "call",
            method: "tools/call",
            params: { name: "code", arguments: { code: "return 1" } },
          },
          {
            jsonrpc: "2.0",
            method: "tools/call",
            params: { name: "code", arguments: { code: "return 2" } },
          },
          { jsonrpc: "2.0", id: 3, method: "resources/list" },
        ]),
        { deps },
      ),
    );
    // The id-less tools/call is a notification, so only one call runs.
    expect(calls()).toBe(1);
  });

  it("accepts a batch carrying an explicit 2025-03-26 header", async () => {
    const res = await handleMcpRequest(
      rpc([ping(1), ping(2)], { "MCP-Protocol-Version": "2025-03-26" }),
      stubEnv,
      stubCtx,
    );
    expect(res.status).toBe(200);
    const body = await res.json<ReadonlyArray<{ id: unknown }>>();
    expect(body.map((response) => response.id)).toEqual([1, 2]);
  });

  it.each(["2025-06-18", "2025-11-25"])("rejects a batch under %s", async (version) => {
    const res = await handleMcpRequest(
      rpc([ping(1), ping(2)], { "MCP-Protocol-Version": version }),
      stubEnv,
      stubCtx,
    );
    expect(res.status).toBe(400);
    const body = await res.json<{ id: unknown; error: { code: number } }>();
    expect(body).toMatchObject({ id: null, error: { code: -32600 } });
  });

  it("acknowledges a batch of only notifications with 202", async () => {
    await expectGolden(
      "transport-batch-notifications-202",
      await serve(rpc([initialized, { jsonrpc: "2.0", method: "notifications/cancelled" }])),
    );
  });

  it("rejects an empty batch with one error object", async () => {
    await expectGolden("transport-batch-empty-400", await serve(rpc([])));
  });

  it("answers each invalid element with its own error", async () => {
    await expectGolden("transport-batch-invalid-elements", await serve(rpc([1, 2, 3])));
  });

  it("rejects initialize inside a batch and still answers the rest", async () => {
    await expectGolden(
      "transport-batch-initialize",
      await serve(
        rpc([
          {
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: { protocolVersion: "2025-03-26" },
          },
          ping(2),
        ]),
      ),
    );
  });

  it("rejects 2026-07-28 request metadata inside a batch", async () => {
    const res = await handleMcpRequest(
      rpc([
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {
            _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
          },
        },
        ping(2),
      ]),
      stubEnv,
      stubCtx,
    );
    expect(res.status).toBe(200);
    const body = await res.json<ReadonlyArray<{ id: unknown; error?: { code: number } }>>();
    expect(body[0]).toMatchObject({ id: 1, error: { code: -32600 } });
    expect(body[1]).toMatchObject({ id: 2, result: {} });
  });

  it("rejects a batch over 20 messages without running any of it", async () => {
    const { deps, calls } = countingExecutor();
    const call = (id: number) => ({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "code", arguments: { code: "return 1" } },
    });
    await expectGolden(
      "transport-batch-too-large-400",
      await serve(rpc(Array.from({ length: 21 }, (_, index) => call(index))), {
        deps,
      }),
    );
    expect(calls()).toBe(0);
  });

  it("charges the rate limit once per message and refuses the whole batch", async () => {
    let remaining = 2;
    const env = testEnv({
      MCP_RATE_LIMIT: {
        limit: async () => {
          remaining -= 1;
          return { success: remaining >= 0 };
        },
      },
    });
    const { deps, calls } = countingExecutor();
    const res = await handleMcpRequest(rpc([ping(1), ping(2), ping(3)]), env, stubCtx, deps);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(calls()).toBe(0);
  });
});
