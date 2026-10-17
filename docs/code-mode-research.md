# Code Mode Research

This research, completed on 2026-10-17, compares the AFL-MCP `code` tool with
Cloudflare's own Code Mode implementations. A production failure triggered it.
The tool description says "Execute TypeScript code", but the sandbox runs plain
JavaScript. A call such as `const f = (x: number) => x` fails with
`Unexpected token ':'`.

The note relies on primary sources only: Cloudflare blog posts, Cloudflare
developer docs, and source code pinned to a commit. The AFL-MCP side comes from
the `release/v5.0.0` branch at `92dd43d`.

---

## Summary and Recommendation

**TypeScript describes the API. JavaScript runs in the sandbox.** Cloudflare
uses TypeScript declarations to tell the model what it can call. Every shipped
Cloudflare Code Mode tool asks the model to write JavaScript. The original blog
post says the tool "executes some TypeScript code", and that phrase causes the
confusion. Cloudflare's own SDK hit the same TypeScript syntax failures and
tightened its prompts twice ([#961][pr961], [#1760][pr1760]).

Recommendation for v5.0.0:

- Change the `code` tool description and its `code` parameter to say
  JavaScript, and add one line that forbids type annotations, interfaces and
  generics. This matches Cloudflare's wording and adds no bundle weight.
- Add a short TypeScript `declare const db` block to the `code` tool
  description, so the model sees the real four-method surface.
- Return a hint with syntax errors that points at TypeScript syntax.
- Defer type stripping. If logs later show repeated TypeScript failures, strip
  types with `sucrase`, the transformer in Cloudflare's own
  `@cloudflare/worker-bundler`. It adds about 46 KB gzipped to a 448 KiB
  gzipped bundle.

The three highest-impact gaps:

1. The tool advertises the wrong language. (Gap 1)
2. The `code` tool carries no typed API declaration, and its parameter calls
   `db` a `D1Database`, which overstates what exists. (Gap 2)
3. Common code shapes fail with misleading errors. An `async () => {}`
   payload, or a body without `return`, yields
   `Unexpected end of JSON input`. (Gap 3)

---

## Sources

| Ref  | Source                                                                 | Date or pin         |
| ---- | ---------------------------------------------------------------------- | ------------------- |
| [B1] | [Code Mode: the better way to use MCP][b1]                             | 2025-09-26          |
| [B2] | [Code Mode: give agents an entire API in 1,000 tokens][b2]             | 2026-02-20          |
| [B3] | [`Sandboxing AI agents, 100x faster`][b3]                              | 2026-03-24          |
| [D1] | [Dynamic Workers: Getting started][d1]                                 | fetched 2026-10-17  |
| [D2] | [Dynamic Workers: API reference][d2]                                   | updated 2026-10-12  |
| [D3] | [Dynamic Workers: Bindings][d3]                                        | fetched 2026-10-17  |
| [D4] | [Dynamic Workers: Pricing][d4]                                         | fetched 2026-10-17  |
| [D5] | [Dynamic Workers: Custom resource limits][d5]                          | updated 2026-10-12  |
| [D6] | [Dynamic Workers: Observability][d6]                                   | fetched 2026-10-17  |
| [D7] | [Dynamic Workers: Platform limits][d7]                                 | updated 2026-08-27  |
| [S1] | `cloudflare/agents` `packages/codemode` (`@cloudflare/codemode` 0.5.4) | [`7dd51c5`][agents] |
| [S2] | `cloudflare/mcp`, the Cloudflare API MCP server                        | [`e857379`][cfmcp]  |
| [S3] | `cloudflare/agents` `packages/worker-bundler` (npm 0.2.6)              | [`7dd51c5`][agents] |

---

## How Cloudflare's Code Mode Works

This section draws on the blog posts, the Dynamic Workers docs and the
pinned source code.

### The Idea

[B1] argues that models write code against an API better than they emit tool
calls. Their training data holds far more code than tool-call transcripts. The
agent sees one tool that runs code. The SDK converts each MCP tool's JSON
Schema into a TypeScript interface with doc comments. The model calls those
methods from its code.

In the current SDK, `generateTypesFromJsonSchema` and
`jsonSchemaToTypeString` in [`json-schema-types.ts`][s1-types] do this
conversion. [#1074][pr1074] dropped the `zod-to-ts` dependency in favour of
that converter, to cut bundle size.

[B3] repeats the point for API descriptions. It calls the TypeScript form
fewer tokens and easier to understand than OpenAPI. [D3] states the split
plainly. TypeScript declarations "work even if the agent is writing plain
JavaScript."

### The Language Executed

The Worker Loader has no build step. [D1] says code in languages like
TypeScript needs compiling to JavaScript before it reaches `load()` or
`get()`. Module types in [D2] cover `js`, `cjs`, `py`, `text`, `data`, `json`
and `wasm`, with no TypeScript type. [B3] adds: "your agent needs to write JavaScript."

Every Cloudflare Code Mode tool that ships today asks for JavaScript:

- `DEFAULT_DESCRIPTION` in [`packages/codemode/src/shared.ts`][s1-shared] says
  "Write an async arrow function in JavaScript" and "Do NOT use TypeScript
  syntax - no type annotations, interfaces, or generics."
- `codeMcpServer` in [`packages/codemode/src/mcp.ts`][s1-mcp] uses the same
  text, and describes its `code` parameter as "JavaScript async arrow function
  to execute".
- The durable runtime tool in
  [`packages/codemode/src/proxy-tool.ts`][s1-proxy] opens with "Execute
  JavaScript in a sandbox", followed by a note on connector access.
- The Cloudflare API server in [`src/tools/execute.ts`][s2-exec] opens with
  "Execute JavaScript code that can read, create, update, or delete
  resources".

The `@cloudflare/codemode` README lists "Limited to JavaScript execution" under
Limitations. Its CHANGELOG records two fixes for this exact problem:

- [#961][pr961] updated the default tool prompt to request JavaScript
  explicitly, to prevent TypeScript syntax errors in the Dynamic Worker
  executor.
- [#1760][pr1760] changed the runtime tool description from "Execute
  TypeScript" to "Execute JavaScript", because the sandbox executes JavaScript
  only.

Cloudflare's narrative docs still say the model writes TypeScript
(`docs/codemode/index.md` at [S1]), so the inconsistency persists upstream.

### Code Normalisation

`normalizeCode` in [`packages/codemode/src/normalize.ts`][s1-norm] parses the
submission with `acorn` before execution. It strips Markdown code fences
labelled `js`, `ts` and similar. It passes an arrow function through, unwraps
`export default`, and calls a lone named function. It adds `return` before a
trailing expression. Code that fails to parse, including a body with a top-level
`return`, goes into a function body. `acorn` parses JavaScript only, so
TypeScript still fails after normalisation.

### Sandbox Configuration

`DynamicWorkerExecutor` in [`packages/codemode/src/executor.ts`][s1-exec]:

- Calls `LOADER.load()`, not `get()`, because "every run produces a unique
  generated module".
- Sets `compatibilityDate: "2025-06-01"` and the `nodejs_compat` flag.
- Defaults `globalOutbound` to `null`, so `fetch()` and `connect()` throw.
- Runs code inside a `WorkerEntrypoint` method, `evaluate()`, called over RPC.
  Tool calls go back to the host through an `RpcTarget` dispatcher.
- Races the code against a timeout inside the sandbox. The default rose from
  30 to 60 seconds in [#1806][pr1806].
- Sets no `limits` for CPU time or subrequests.
- Disposes the loaded Worker and its entrypoint stub after each run.

The Cloudflare API server [S2] differs in a few places. It calls
`LOADER.get()` with a random UUID per call. Its `search` tool sets
`globalOutbound: null`. Its `execute` tool routes outbound requests through a
`GlobalOutbound` entrypoint that allows one host and injects the API token, so
the token never enters the sandbox. It also sets no `limits`.

### Output, Logs and Errors

The SDK executor replaces `console.log`, `console.warn` and `console.error`
inside the sandbox and collects the lines. It returns them with the result and
also on error. `runCode` in [`packages/codemode/src/run-code.ts`][s1-run]
appends "Console output:" to the error message when logs exist. The
`codeMcpServer` wrapper returns only the error message, without logs.

On error, the SDK returns `err.message`. The Cloudflare API server also
captures `err.stack` in the sandbox. Both return MCP `isError` results.

Both caps sit near 6,000 tokens. `mcp.ts` sets `MAX_RESPONSE_CHARS = 24_000`
(about 6,000 tokens), and [S2] `src/truncate.ts` uses the same budget.
Truncation works structurally. Output stays valid JSON, the largest values go
first, and each cut carries a `--- TRUNCATED ---` marker. The [S2] README notes
that clients can turn the cap off with `?truncateToolResult=false`.

### Tool Count and Discovery

[B2] describes the Cloudflare API server as exposing "just two" tools,
`search()` and `execute()`, at about 1,000 tokens for some 2,500 endpoints. The
[S2] README lists `docs`, `search`, `execute` and `whoami`. The model writes
JavaScript against the OpenAPI spec to find endpoints, then writes JavaScript
to call them. The newer durable runtime [S1] goes further. The model calls
`codemode.search()` and `codemode.describe()` from inside the sandbox, so type
information enters the context only when needed.

### TypeScript Tooling Cloudflare Ships

`@cloudflare/worker-bundler` [S3] exists for Dynamic Workers that need
TypeScript or npm packages. [D1] shows it compiling `src/index.ts` before
`load()`. Its transform-only path, `transformCode` in
[`packages/worker-bundler/src/transformer.ts`][s3-transform], uses `sucrase`
(`import { transform } from "sucrase"`). Its full bundling path uses
`esbuild-wasm`. Its npm dependencies include `sucrase`, `esbuild-wasm`,
`typescript` and `@typescript/vfs`, with an unpacked size of about 26 MB. The
Code Mode packages do not use it.

---

## Side-by-Side Comparison

| Aspect                  | Cloudflare Code Mode                                                                 | AFL-MCP                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Tools exposed           | SDK: 1 (`code`). API server: `search`, `execute` (+ `docs`, `whoami`)                | 2: `schema`, `code`                                                                              |
| Language in description | "JavaScript", with an explicit no-TypeScript line                                    | "Execute TypeScript code" and "standard TypeScript/JavaScript only"                              |
| API presentation        | Generated `declare const codemode: {...}` with doc comments, in the tool description | Two prose lines under `query_api` in the `schema` output, and `db` (D1Database) in the parameter |
| Accepted code shape     | Arrow function, body, last expression, `export default`, fenced                      | Function body with explicit `return` only                                                        |
| Entry into sandbox      | `WorkerEntrypoint.evaluate()` over RPC, structured result                            | `fetch()` handler, `JSON.stringify` to a `Response`, `JSON.parse` in the parent                  |
| Loader call             | SDK `load()`. API server `get(randomUUID)`                                           | `load()`                                                                                         |
| `globalOutbound`        | `null` by default (SDK, `search`). Allow-list gateway (`execute`)                    | `null`                                                                                           |
| Resource `limits` [D5]  | None set                                                                             | `cpuMs: 10_000`, `subRequests: 100`                                                              |
| Timeout                 | 60 s race inside the sandbox                                                         | 30 s race in the parent                                                                          |
| Console output          | Captured and returned, also on error                                                 | Not captured. The runtime discards it without a Tail Worker [D6]                                 |
| Error text              | `err.message` (+ logs in SDK `runCode`, stack captured, not returned, in API server) | First line of the message, at most 500 characters                                                |
| Result cap              | 24,000 characters (about 6,000 tokens), structural, valid JSON                       | 1,000,000 characters, sliced into a plain string                                                 |
| Disposal                | Explicit `Symbol.dispose` on Worker and stub                                         | None                                                                                             |
| Data access             | Host functions over `RpcTarget`, or connector bindings                               | `DbProxy` `WorkerEntrypoint` over RPC, read-only SQL guard                                       |

AFL-MCP already matches Cloudflare on the core shape. It splits discovery and
execution across two tools like [S2], and uses a fresh isolate per call. It
blocks the network and reaches data through an RPC binding, not credentials.
AFL-MCP is stricter than both Cloudflare implementations on resource limits. Neither
official executor sets `cpuMs` or `subRequests`.

---

## Gaps, Ranked by Impact

The first gap matters most. None of these gaps affects read-only enforcement
or network isolation.

### 1. The Tool Advertises the Wrong Language

`src/mcp/protocol.ts` describes the tool as "Execute TypeScript code" and the
parameter as "TypeScript code to execute". The sandbox runs JavaScript, so any
annotation fails. Models follow the description, so this gap causes most
avoidable failures.

Official approach: say JavaScript, and forbid TypeScript syntax in so many
words ([S1] `shared.ts`, `mcp.ts`, [S2] `execute.ts`). Cloudflare tightened its
own prompts twice for this ([#961][pr961], [#1760][pr1760]).

### 2. No Typed API Declaration in the Code Tool

The `code` tool description never shows the `db` interface. The `schema` tool
lists it as two prose strings under `query_api`. The parameter description
calls `db` a `D1Database`, but the wrapper exposes only `prepare`, `bind`,
`all` and `first`. A model that trusts the `D1Database` label may reach for
`run`, `raw`, `batch` or `exec`, and none of them exists.

Official approach: inline a TypeScript declaration with doc comments into the
tool description ([B1], [D3], [S1] `createCodeTool`, [S2] `CLOUDFLARE_TYPES`).
A sketch for AFL-MCP:

```ts
interface D1Result<Row> { results: Row[]; success: boolean }
interface Statement {
  /** Bind positional values to ? placeholders. */
  bind(...values: unknown[]): Statement;
  /** Run the read-only statement and return every row. */
  all<Row = Record<string, unknown>>(): Promise<D1Result<Row>>;
  /** Run the read-only statement and return the first row, or null. */
  first<Row = Record<string, unknown>>(): Promise<Row | null>;
}
declare const db: { prepare(sql: string): Statement };
```

The declaration costs about 120 tokens and states the contract exactly.

### 3. Common Code Shapes Fail with Misleading Errors

The executor splices the submission into `async () => { ${code} }`. A local
replica of that wrapper in Node gave these results:

| Submission                                        | Result                         |
| ------------------------------------------------- | ------------------------------ |
| Body with `return ...`                            | Rows returned                  |
| `async () => { return ... }` (Cloudflare's shape) | `Unexpected end of JSON input` |
| Body ending in an expression, no `return`         | `Unexpected end of JSON input` |
| Code wrapped in a fenced `js` block               | `"" is not a function`         |
| `const f = (x: number) => x`                      | `Unexpected token ':'`         |

The JSON error appears because a missing return value serialises to nothing,
and the parent then parses an empty body. Models trained on Cloudflare's
examples send the arrow shape, so the second row matters.

Official approach: `normalizeCode` [S1] handles all of these shapes except
TypeScript. AFL-MCP could adopt the cheap parts without `acorn`. It could strip
fences, detect a leading `async () =>`, and report "the code returned no
value" instead of a JSON error. `acorn` measured about 34 KB gzipped
(built with `--minify`, this research).

### 4. Console Output Disappears

AFL-MCP neither captures `console.log` nor attaches a Tail Worker. [D6] states
that the runtime discards Dynamic Worker logs unless a Tail Worker keeps them.
Models often debug with `console.log`, so they see nothing back.

Official approach: override the console methods inside the sandbox and return
the lines with the result and with errors ([S1] `executor.ts`, `run-code.ts`).
[B1] describes the same behaviour.

Status: closed in v5.0.0. The sandbox captures the console methods. It
returns up to 100 lines and 10,000 characters in a separate text block, both
with results and with errors.

### 5. The Result Cap Allows Very Large Outputs

AFL-MCP returns up to 1,000,000 characters, roughly 250,000 tokens. Past the
cap it slices the JSON text, so the model receives an invalid fragment as a
string.

Official approach: cap near 6,000 tokens and truncate structurally, with
markers ([S1] `truncate.ts`, [S2] `src/truncate.ts`). Analytic queries return wide
tables, so AFL-MCP may want a larger cap than 6,000 tokens. Structural
truncation still applies at any size and keeps the output valid JSON.

Status: closed in v5.0.0. The cap is 100,000 characters, about 25,000
tokens, so a wide analytic table still returns a few hundred rows. Results
past it shrink structurally, with notices that give the full counts.

### 6. Errors Carry Little Context

AFL-MCP returns the first line of the message, at most 500 characters. That
choice keeps internal detail out of a public tool. It also drops the line and
column that would help a model fix a syntax error.

Official approach: return `err.message`, plus logs in the SDK. Neither
official server adds a language hint. AFL-MCP can add one cheaply: when a
`SyntaxError` mentions `:`, `interface` or `<`, append "The sandbox runs
JavaScript. Remove type annotations."

### 7. Smaller Structural Differences

These differences carry little user-facing impact:

- Timeout placement. AFL-MCP races the call in the parent. On a timeout the
  parent returns, and the isolate may keep running until its `cpuMs` limit.
  The SDK races inside the sandbox instead.
- Entry style. An RPC `evaluate()` method returns a structured value and
  avoids the extra JSON round trip through a `Response`.
- Disposal. The SDK disposes the Worker and its stub after each run, citing a
  `workerd` teardown assertion under `vitest-pool-workers`.

### Pricing Note

[D4] bills each unique Dynamic Worker per day, and `load()` counts as one per
invocation. The plan includes 1,000 per month, then $0.002 each. Billing for
this dimension started on 2026-05-26 [D4]. Both Cloudflare implementations
create one per call as well, so AFL-MCP matches the official pattern. The per-IP
rate limit of 60 calls a minute bounds the exposure per client, not overall.

Separately, [D7] allows four distinct Dynamic Workers in flight per Worker
request. AFL-MCP runs one per `code` call, so that limit does not bind.

---

## The TypeScript Question

The sandbox can only run JavaScript, so AFL-MCP must either ask for JavaScript
or strip types before loading the code.

### Options

All sizes come from ESM bundles built with `esbuild --minify` in this research,
then compressed with `gzip -9`. The AFL-MCP Worker currently uploads
2,066 KiB, or 448 KiB gzipped (`wrangler deploy --dry-run`).

| Option                                    | Added size (gzip)                   | Per call     | Notes                                                     |
| ----------------------------------------- | ----------------------------------- | ------------ | --------------------------------------------------------- |
| A. Say JavaScript (Cloudflare's choice)   | 0                                   | 0            | Description change only                                   |
| B. `sucrase` `transforms: ["typescript"]` | about 46 KB (204 KB raw)            | under 1 ms   | Transformer behind `worker-bundler`'s transform path [S3] |
| C. `typescript` `transpileModule`         | about 1,019 KB (3.6 MB raw)         | not measured | More than doubles the bundle                              |
| D. `ts-blank-space`                       | about 1,022 KB                      | under 1 ms   | Depends on the `typescript` package, so same weight as C  |
| E. `esbuild-wasm` `transform`             | about 20 KB JS + 3.7 MB WebAssembly | not measured | 14 MB raw WebAssembly, built for bundling, not stripping  |

`sucrase` output for a typical AFL-MCP body, with an annotated arrow function, an
interface and an `as` cast, kept the top-level `await` and `return` intact. It
removed the types without changing line structure. The test used
`disableESTransforms: true` so that `sucrase` leaves modern syntax alone. `sucrase`
strips types and never checks them, which suits a sandbox that only needs
executable code. One run of 100 calls on a 200-line input averaged 0.49 ms for
`sucrase` and 0.42 ms for `ts-blank-space`.

### Recommendation

Adopt option A for v5.0.0. It matches every Cloudflare tool that ships, costs
nothing, and removes the cause of the failure. Pair it with the declaration in
gap 2 and the syntax hint in gap 6.

Keep option B in reserve. It suits a server that wants to accept TypeScript
anyway, because models still slip into annotations after reading TypeScript
declarations. It costs about 10% more gzipped bundle and one dependency. It
also matches the tool Cloudflare itself reaches for when it needs to strip
types. Options C, D and E cost too much for this Worker.

---

## Open Questions

- How often do `code` calls fail on TypeScript syntax? Since v5.0.0 the
  `tool:code` log event records `outcome` and `errorClass`, so the share of
  `SyntaxError` failures is now measurable. That share decides option B.
- How large is a full `schema` response in tokens? Cloudflare keeps discovery
  output small or moves it into the sandbox. A measurement would show whether
  the `schema` tool needs the same treatment.
- Is 100,000 characters the right result cap? v5.0.0 dropped it from
  1,000,000. Observed result sizes would show whether to move it.
- Should AFL-MCP attach a Tail Worker for sandbox logs, or rely on returned
  console output only? Returned output helps the model. A Tail Worker helps
  the operator.
- Does the cost per unique Dynamic Worker matter at current call volumes? The
  [D4] usage query (`distinctDynamicWorkerCount`) would answer this.

[b1]: https://blog.cloudflare.com/code-mode/
[b2]: https://blog.cloudflare.com/code-mode-mcp/
[b3]: https://blog.cloudflare.com/dynamic-workers/
[d1]: https://developers.cloudflare.com/dynamic-workers/getting-started/
[d2]: https://developers.cloudflare.com/dynamic-workers/api-reference/
[d3]: https://developers.cloudflare.com/dynamic-workers/usage/bindings/
[d4]: https://developers.cloudflare.com/dynamic-workers/pricing/
[d5]: https://developers.cloudflare.com/dynamic-workers/usage/limits/
[d6]: https://developers.cloudflare.com/dynamic-workers/usage/observability/
[d7]: https://developers.cloudflare.com/dynamic-workers/platform/limits/
[agents]: https://github.com/cloudflare/agents/tree/7dd51c518c517b0f9f92ec7e2c3ad1004222955e
[cfmcp]: https://github.com/cloudflare/mcp/tree/e85737947299bbb9b5858fc9ae6bc6d1e6f9a3ba
[s1-shared]: https://github.com/cloudflare/agents/blob/7dd51c518c517b0f9f92ec7e2c3ad1004222955e/packages/codemode/src/shared.ts
[s1-mcp]: https://github.com/cloudflare/agents/blob/7dd51c518c517b0f9f92ec7e2c3ad1004222955e/packages/codemode/src/mcp.ts
[s1-proxy]: https://github.com/cloudflare/agents/blob/7dd51c518c517b0f9f92ec7e2c3ad1004222955e/packages/codemode/src/proxy-tool.ts
[s1-norm]: https://github.com/cloudflare/agents/blob/7dd51c518c517b0f9f92ec7e2c3ad1004222955e/packages/codemode/src/normalize.ts
[s1-exec]: https://github.com/cloudflare/agents/blob/7dd51c518c517b0f9f92ec7e2c3ad1004222955e/packages/codemode/src/executor.ts
[s1-run]: https://github.com/cloudflare/agents/blob/7dd51c518c517b0f9f92ec7e2c3ad1004222955e/packages/codemode/src/run-code.ts
[s2-exec]: https://github.com/cloudflare/mcp/blob/e85737947299bbb9b5858fc9ae6bc6d1e6f9a3ba/src/tools/execute.ts
[s3-transform]: https://github.com/cloudflare/agents/blob/7dd51c518c517b0f9f92ec7e2c3ad1004222955e/packages/worker-bundler/src/transformer.ts
[s1-types]: https://github.com/cloudflare/agents/blob/7dd51c518c517b0f9f92ec7e2c3ad1004222955e/packages/codemode/src/json-schema-types.ts
[pr1074]: https://github.com/cloudflare/agents/pull/1074
[pr961]: https://github.com/cloudflare/agents/pull/961
[pr1760]: https://github.com/cloudflare/agents/pull/1760
[pr1806]: https://github.com/cloudflare/agents/pull/1806
