---
status: accepted
---

# Keep the Hand-Rolled MCP Protocol

AFL-MCP keeps its own MCP protocol implementation instead of the official
server SDK, until logs or feature needs trigger a switch.

## Context

`src/mcp/protocol.ts` implements the MCP Streamable HTTP transport by hand.
It serves two tools over JSON request and response, with no streaming,
resources or sessions. Version 5.0.0 upgrades it to negotiate protocol
revisions up to 2025-11-25. The official `@modelcontextprotocol/server`
package could replace it. That package adds about 55 KB gzipped to the
bundle and keeps Zod as a dependency after the repo moves to
`effect/Schema`.

## Decision

AFL-MCP keeps the hand-rolled MCP protocol. From 5.0.0, golden tests pin
its wire contract, so changes to it show up as reviewed test diffs.

Adopt `@modelcontextprotocol/server` when either trigger fires:

- Worker logs show clients requesting protocol revision 2026-07-28. From
  5.0.0 the protocol handler logs every requested version for this purpose.
- The server needs a second transport feature, such as streaming
  responses or resources.

## Alternatives

The maintainer considered and rejected these options.

### Adopt the Official Server SDK Now

The SDK tracks the spec and would serve 2026-07-28 sooner. It costs bundle
size and a second validation library, and current clients gain nothing from
it.

### Adopt the Agents Package

The `agents` package brings Durable Object session state that a stateless
two-tool server does not need.

## Consequences

- The repo must follow MCP spec changes by hand. Each protocol change needs
  golden test updates and a review against the spec.
- From 5.0.0, requests in the 2026-07-28 format get a plain 4xx error, so
  dual-era clients fall back to the `initialize` handshake.
- The protocol version logs decide when to revisit the choice.
