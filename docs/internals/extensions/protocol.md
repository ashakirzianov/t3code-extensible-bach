# Extension protocol

An extension is a separate process. It opens **one WebSocket to the host and speaks the
ordinary client protocol**, using a token that carries the new `extension` scope alongside
whatever orchestration scopes it needs. Nothing loads into the host process, and the host
never dials out.

Because it is a client, the whole existing client API is already available to it —
`orchestration.dispatchCommand`, `subscribeShell`, `subscribeThread`, `searchThreads` — under
its token's scopes. That is where spawning, messaging, and state derivation happen. The
`extensions.*` methods below are only the surface that has no client equivalent.

## The connection

1. **`extensions.hello`** — the extension sends its manifest and the protocol version it was
   built against. The host replies with the negotiated version, every version it speaks, the
   host app version, the environment id, and two absolute paths: the folder the extension was
   started from, and the data directory it owns. A version the host does not speak fails with
   `ExtensionProtocolMismatchError`, which Settings shows.
2. **`extensions.registerTools`, `.registerHttpPrefix`, `.registerWebEntry`, `.setBadge`** —
   declarative and idempotent. Each re-send replaces what came before, so an extension repeats
   them verbatim after a reconnect rather than diffing.
3. **`extensions.connect`** — opens the stream the host pushes calls on. Its first event,
   `attached`, carries a `connectionId`. **Opening this stream is the readiness signal**: the
   host may invoke tools only once it exists, so an extension that opens it last has finished
   registering.
4. **`extensions.respondTool`, `.respondHttp`** — the answers, correlated by the invocation or
   request id together with the `connectionId`. A reconnect mints a new id, which is how an
   answer from a dead process gets dropped instead of applied.

## Why the host's calls are stream events

The client protocol is Effect RPC over a WebSocket: clients issue requests, and the only
server-initiated traffic is the output of a stream a client subscribed to. There is no
server-to-client _request_. So `invokeTool` and `proxyHttp` cannot be requests; they are
events on the stream, answered by a correlated request going the other way.
`previewAutomation.connect` / `.respond` has the same shape for the same reason, and the
extension methods mirror it deliberately.

## Tools

Registered tool names are **unprefixed** and must be unique across the environment. The host
attaches the caller's resolved identity — thread, environment, provider instance — to every
invocation, so an agent cannot claim to be someone else by writing it into the arguments.

Registration is answered per tool: a name that collides is rejected with a reason the
Settings screen shows, and the extension keeps running with the tools that were accepted.

MCP clients cache the tool catalogue when their provider process connects, so a tool that
appears later is invisible to a running agent
([spike](spikes/mcp-client-behaviour.md)). Two consequences the protocol is shaped around:
the whole tool surface is registered before agent sessions start, and **availability is
expressed in results, not in the catalogue**. A tool whose extension is down does not vanish;
it answers with `ExtensionUnavailableError`, whose message reaches the agent verbatim.

## HTTP and web

A registered prefix is served under the host's own origin and auth, so remote, relay, and
tunnel clients reach it unchanged. The host proxies each request onto the stream and waits
for the matching response. Bodies are `utf8` or `base64` so binary survives a JSON wire.

The web entry is a path to an ES module inside the extension's folder. The client loads it
with a same-origin `import()` — the only thing that executes under the desktop CSP
([spike](spikes/electron-runtime.md)) — and mounts it in a container the host owns. The host
draws the nav entry itself from the label, icon, and badge.

## The reference

Field-by-field definitions are generated, not written:

- **[`packages/contracts/generated/extensions/protocol.schema.json`](../../../packages/contracts/generated/extensions/protocol.schema.json)**
  — JSON Schema for the manifest and every message, plus an `x-methods` map from method name
  to the schemas that describe it. This is the contract for an extension in any language.
- **[`packages/contracts/generated/extensions/protocol.d.ts`](../../../packages/contracts/generated/extensions/protocol.d.ts)**
  — the same shapes as dependency-free TypeScript declarations, to copy into a TypeScript
  extension.

Both are generated from `packages/contracts/src/extensions.ts` by
`pnpm --filter @t3tools/contracts generate:extensions`, and a test regenerates them and fails
on any diff, so the schemas and the published contract cannot drift.
