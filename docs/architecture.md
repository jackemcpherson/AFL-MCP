# Architecture

AFL-MCP is a Cloudflare Worker that serves Australian football data through the
Model Context Protocol. Cloudflare D1 stores AFLM, AFLW, VFL, and VFLW data.

Clients connect to `https://afl.jackemcpherson.com/mcp` through Streamable HTTP.
The server exposes `schema` and `code`. Sandbox constraints travel in the
`code` tool's description.

## MCP Protocol

`src/mcp/protocol.ts` implements the protocol by hand, as recorded in
[ADR 0002](adr/0002-keep-hand-rolled-mcp-protocol.md). Golden files in
`test/fixtures/golden/mcp/` pin every response, so a contract change shows
up as a reviewed test diff.

### Handshake

`initialize` negotiates revisions 2025-11-25, 2025-06-18 and 2025-03-26. It
echoes a supported requested revision and otherwise answers 2025-11-25. The
result carries server `instructions` to call `schema` before the first `code`
call.

Each piece of agent guidance has one home. The instructions hold the
session-wide rules, and each tool description holds what triggers the tool
and what its arguments mean. The competition-filter guardrail sits in the
`code` tool description, where the model writes SQL. The `schema` description
and its argument errors share `SCHEMA_TOOL_CONTRACT`.

### Transport

The handler checks each request in this order:

1. `OPTIONS` returns 204. Other non-POST methods return 405 with
   `Allow: POST, OPTIONS`.
2. The per-IP rate limit returns 429 with `Retry-After`.
3. A media type other than `application/json` returns 415.
4. A body over 4 MiB, counted on the bytes received, returns 413.
5. Invalid JSON or an invalid JSON-RPC envelope returns 400.
6. A request other than `initialize` that carries an unsupported
   `MCP-Protocol-Version` header, or 2026-07-28 request metadata, returns
   400 with error `-32600`. Dual-era clients then fall back to
   `initialize`.
7. Notifications return 202 with no body. A message without an `id` is a
   notification whatever its method, so the server does not run it.

Errors for a request whose id is unknown carry `id: null`.

### Batches

A 2025-03-26 client may send a JSON array of messages. The server takes
the array as a batch when the request has no `MCP-Protocol-Version` header
or the header is 2025-03-26. Later revisions removed batching, so under
any other header an array is an invalid envelope and returns 400.

- The 4 MiB cap applies to the whole body.
- An empty batch returns 400 with one `-32600` error.
- A batch over 20 messages returns 400 with `-32600` and runs nothing.
- Each message after the first takes one more rate-limit token. When the
  limit runs out, the whole batch returns 429 and nothing runs.
- Messages run one at a time, in order. Each request gets its own response,
  invalid messages and 2026-07-28 metadata get `-32600` errors, and
  notifications get none.
- `initialize` inside a batch gets a `-32600` error. The other messages
  still run.
- The reply is 200 with an array of responses in input order, or 202 with
  no body when no message takes a response. The handler logs
the `Origin` and protocol version of each request that passes steps 1 to 5
as an `mcp:client` event. Requests rejected at those steps are not logged.
The event records the `MCP-Protocol-Version` header, the `initialize`
`protocolVersion`, and the 2026-07-28 `_meta` marker as
`metaProtocolVersion`.

### Tools

Both tools carry a `title` (`Database schema`, `Run query code`) and
annotations that mark them read-only, non-destructive, idempotent and
closed-world. The title repeats in `annotations.title` for 2025-03-26
clients.

`schema` results and object `code` results add `structuredContent` next to
the unchanged text block. Array and scalar `code` results stay text only,
and error results never carry it. `tools/call` naming an unknown
tool returns JSON-RPC error `-32602`. A call without a string tool name
returns `-32602` with `Missing tool name`. Both tools reject undeclared
arguments with an `isError` result that names the key and lists the valid
arguments.

## Schema Contract

The `schema` tool accepts three request shapes:

- No arguments return the complete static schema without reading D1.
- `competition` returns the static schema for one competition.
- `competition`, `season`, and `includeObserved: true` add bounded observations.

The observed request runs indexed aggregates for statistics, weather, PAV,
lineups, and coaching coverage. The Worker caches successful output for 15
minutes. It rejects every other argument combination before querying D1.

An argument error names the failing key, for example
`Expected boolean at "includeObserved"` or
`Expected no excess property at "table"`. Contract errors, such as
`includeObserved` without a `season`, keep their own text.

## Components

| Layer             | Location                  | Responsibility                                               |
| ----------------- | ------------------------- | ------------------------------------------------------------ |
| Entry and routing | `src/index.ts`            | Worker fetch, scheduled, and authenticated admin routes      |
| Admin operations  | `src/admin/`              | Coaching and Brownlow backfill, club repair, operator status |
| MCP protocol      | `src/mcp/protocol.ts`     | Streamable HTTP transport                                    |
| MCP tools         | `src/mcp/tools/`          | `schema` and `code` definitions                              |
| Sandbox           | `src/sandbox/`            | Dynamic Worker isolation and the `DbProxy` read bridge       |
| Sync              | `src/sync/`               | Cron orchestration, upserts, weather, and PAV                |
| Schema            | `src/db/schema.sql`       | D1 schema documented in [Schema Reference](schema.md)        |

## Code Execution Model

The `code` tool launches a fresh
[Dynamic Worker](https://developers.cloudflare.com/workers/configuration/dynamic-workers/)
through the `LOADER` binding. `globalOutbound: null` prevents submitted code
from reaching the network.

The sandbox runs JavaScript only. The Worker Loader has no build step, so
TypeScript syntax fails to parse. The tool description asks for JavaScript
and declares the `db` API in TypeScript, which describes the API but never
runs.

Submitted code is the body of an async function.
`src/sandbox/normalize.ts` also strips a surrounding Markdown fence and
invokes a single `async () => { ... }` function. Code that returns nothing
gets an `isError` result that asks for a `return`. A syntax error in code
that holds TypeScript syntax gets a hint to remove type annotations.

Each run logs one `tool:code` event with `competition`, `outcome` (`ok` or
`error`) and, on failure, `errorClass`, such as `SyntaxError` or
`ReadOnlySqlError`. The event never records the code or the error message.

The sandbox replies with an envelope that holds the value or the thrown
error, plus captured console lines. `src/sandbox/console.ts` replaces the
console methods inside the sandbox and bounds the lines to 100 and 10,000
characters, on both sides of the reply. The lines come back as a second
`Console output:` text block, after the result or the error. They never
reach the server logs.

`src/sandbox/truncate.ts` shortens a result whose text form passes 100,000
characters, about 25,000 tokens. Each pass cuts the largest array or string
and adds a `--- TRUNCATED ---` notice with the full count, so the result
stays valid JSON. An object result keeps its keys and its
`structuredContent`.

The parent Worker exports `DbProxy` as a `WorkerEntrypoint`. The sandbox
receives only a small, read-only database interface that supports prepared
queries. Every call returns through `DbProxy.query` or `DbProxy.queryFirst` to
the parent D1 binding.

The optional `competition` argument must be `AFLM`, `AFLW`, `VFL` or `VFLW`.
Omitting it or passing `null` has the same effect. Any other value returns an
`isError` result that lists the valid codes, and the sandbox never runs. The
argument never changes submitted SQL. Client code must still filter through
`seasons` and `competitions`.

## Data Flow

```text
fitzroy and AFL API
        |
        v
sync orchestrator
        |
        |-- upserts to reference, match, stat, and lineup tables
        |-- calculates player_season_pav after stat changes
        `-- refreshes AFLM coaching on a bounded hourly cadence
        |
        v
Cloudflare D1
        |
        v
DbProxy <- sandbox isolate <- code tool <- MCP client
```

Sync and admin code calls fitzroy through `src/lib/fitzroy.ts`. That module runs
fitzroy's Effects on one runtime per isolate, which keeps the AFL API token
cached across requests. It returns each call as a success or failure value.

Sync and authenticated admin operations can write. MCP client code receives only
read access through `DbProxy`.

Brownlow ingestion shares the sync lease with cron and manual sync. Private
status uses fixed aggregate queries and never returns raw diagnostics.

See [Data Sync](sync.md) for orchestration and [Schema Reference](schema.md) for
the table contract.
