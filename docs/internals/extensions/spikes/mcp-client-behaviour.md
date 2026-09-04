# Spike: MCP client behaviour for host-brokered extension tools

**Status:** verification spike, 2026-09-04. Throwaway instrumentation only — nothing here is
production code. Branch `spike/mcp-client-behaviour`, worktree `../t3code-extensible-wt-mcp`,
nothing committed.

**Why:** the extensibility design assumes the host can register extension-provided MCP tools with
a running per-thread MCP server and have live agents pick them up (`extensibility-design.md` §5.2,
§11, §13, §15), and that the server `instructions` string is a usable channel for telling agents
what the extension surface is. `messaging-protocol-design.md` §6.1 recorded, under static toolkits,
that new tools only reached agents after a restart. This spike tests all three claims against the
fork's real MCP server.

## Setup

T3 runs **one** process-wide MCP HTTP server mounted at `/mcp`
(`apps/server/src/mcp/McpHttpServer.ts:219`), not one server per agent. Per-thread isolation is a
bearer credential resolved by `McpSessionRegistry` into an `McpInvocationContext`; the _tool
catalogue is global_ to the server. Every adapter (Claude, Codex, Cursor, Grok, OpenCode,
Antigravity) points its provider at that same endpoint as a streamable-HTTP MCP server —
e.g. `ClaudeAdapter.ts:4594`.

Spike instrumentation (worktree only, uncommitted):

- `apps/server/src/mcp/SpikeDebug.ts` — unauthenticated `/__spike/*` routes that mutate the live
  MCP registry: `mint` (issue a real T3 MCP credential), `add-tool` (`McpServer.addTool` at
  runtime), `add-resource`, `break-tool` / `fix-tool` (flip the late tool's handler between success
  and an "extension unavailable" error), `state`.
- `patches/effect@4.0.0-beta.103.patch` — extended with the `instructions` change (question 3).
- `/tmp/spike-claude.mjs`, `/tmp/spike-claude2.mjs` — drive the Claude Agent SDK the same way
  `ClaudeAdapter` does: a single `query()` with an `AsyncIterable` prompt and a per-turn queue
  (`ClaudeAdapter.ts:290`, `:344`), so consecutive turns hit **one long-lived provider process**.

Dev server: `vp run dev` in the worktree, `serverPort=14833`,
`baseDir=/Users/devuser/repos/t3code-extensible-wt-mcp/.t3` (worktree-local, seeded by
`VACUUM INTO` from `~/.t3/userdata`).

## Provider coverage

Only Claude Code is installed and authenticated on this machine.

| Provider    | Installed here                                     | Tested            |
| ----------- | -------------------------------------------------- | ----------------- |
| Claude Code | yes (`/Users/devuser/.local/bin/claude` → 2.1.259) | yes               |
| Codex       | no                                                 | not testable here |
| Cursor      | no                                                 | not testable here |
| Grok        | no                                                 | not testable here |
| OpenCode    | no                                                 | not testable here |
| Antigravity | no                                                 | not testable here |

All six adapters attach the same streamable-HTTP endpoint, so the transport-level finding in
question 1 (no server→client channel exists) applies to every provider regardless of its client
implementation. What is _not_ transferable is the per-client caching behaviour; that needs a
re-run per provider on a machine where they are installed.

---

## Question 1 — does a live agent pick up `tools/list_changed`?

**Answer: no, and it cannot. The notification is undeliverable over T3's MCP transport, and Claude
Code caches the tool list at connect anyway. A new tool reaches an agent only when the provider
process restarts — not on a new turn. Tool _behaviour_, by contrast, is fully live.**

### The notification has no channel

`McpServer.layerHttp` registers only `POST` on the MCP path; `GET` is answered
`405 Method Not Allowed`, so there is no server-initiated SSE stream
(`.repos/effect-smol/packages/effect/src/unstable/ai/McpServer.ts:724`, and identically in the
installed `effect@4.0.0-beta.103` dist). `addTool` does enqueue
`notifications/tools/list_changed` (`McpServer.ts:250-255`), but the drain loop can only
`send` to a live client id, and HTTP client ids are per-request. Verified:

```
$ curl -s -o /dev/null -w '%{http_code}' -X GET http://127.0.0.1:14833/mcp \
    -H "Authorization: Bearer …" -H 'Accept: text/event-stream' -H 'mcp-session-id: …'
405
```

### The server side is otherwise fine — polling works

Same MCP session id, before and after `POST /__spike/add-tool`:

```
### tools/list (before)
['preview_status', …, 'preview_snapshot']
### add tool at runtime
{"added":"spike_late_tool"}
### tools/list (after, same MCP session)
['preview_status', …, 'preview_snapshot', 'spike_late_tool']
```

So a client that re-polled `tools/list` would see the new tool immediately. None do.

### Claude Code, live session (6 turns, one process)

`spike_late_tool` was registered after turn 0 completed.

| Turn | Event                                  | Result                                              |
| ---- | -------------------------------------- | --------------------------------------------------- |
| 0    | agent lists its `t3-code` tools        | 14 `preview_*` tools                                |
| —    | `addTool("spike_late_tool")`           | server registry now has 15                          |
| 1    | same question, same process            | **identical 14 tools**                              |
| 2    | "call `mcp__t3-code__spike_late_tool`" | `TOOL_NOT_AVAILABLE`                                |
| 5    | tries again, five turns later          | `ToolSearch` → `"No matching deferred tools found"` |

The SDK re-emits a `system.init` message on every turn, but its `tools` array is the
connect-time snapshot, unchanged across all six turns — it is not a re-poll. Final server state
confirmed `spike_late_tool` was registered the whole time.

### A new provider process does pick it up

Second script, fresh `query()` against the same still-running server:

```
[spike] NEW SESSION init t3-code tools: [… "mcp__t3-code__preview_wait_for",
                                            "mcp__t3-code__spike_late_tool"]
```

So the granularity is **session (provider process) restart**, not turn, not thread. In T3 that
means `ProviderService.startSession` — which `ClaudeAdapter.startSession` implements by stopping
the existing context and spawning a new one (`ClaudeAdapter.ts:4073-4082`). Changing runtime mode,
cwd, or model already restarts the session (`ProviderService.ts:724`, `:1275`), and
`prepareMcpSession` re-issues the MCP credential on each prepare, so those paths get a fresh
catalogue for free.

### The reverse the design relies on: handler-level "extension unavailable"

This works cleanly, and it is the important half. With the tool present in the catalogue, flipping
its handler to return `isError: true` mid-session:

```
[turn 2] TOOL_USE: mcp__t3-code__spike_late_tool {}
[turn 2] TOOL_RESULT(isError=true): "Extension unavailable: the extension host process backing 'spike_late_tool' is not running."
[turn 2] TEXT: Output (verbatim):
> Extension unavailable: the extension host process backing 'spike_late_tool' is not running.
**This came back as an error.**
```

and flipping it back, in the same session, the very next turn:

```
[spike] >>> fix tool: {"lateToolBroken":false}
[turn 3] TOOL_RESULT(isError=undefined): [{"type":"text","text":"SPIKE-LATE-TOOL-OK-zebra-quartz-7781"}]
```

The agent reported the failure plainly, did not treat it as a harness fault, and recovered
without any prompting.

### Implication for the design

The catalogue is frozen per provider process; the handlers are not. The design should stop
treating "register a tool when an extension starts" as reaching live agents:

1. **Register the extension tool surface up front, at session start.** Whatever an agent will be
   allowed to call for the life of its session has to exist in the catalogue at connect time.
2. **Express availability in handler results, not in the catalogue.** An extension that is down,
   restarting, or newly installed is a tool that returns an `isError` result explaining itself —
   which this spike shows agents handle well. A tool that disappears is invisible; a tool that
   errors is legible.
3. **If a genuinely new tool must reach a running thread, restart the provider session.** That is
   an existing, supported path with a visible cost (lost in-process context, resume from cursor).
   It should be a deliberate, user-visible action, not something extension installation does
   silently.
4. Do not spend effort making `tools/list_changed` deliverable (it would need a GET SSE route
   upstream in `effect`) until some provider is shown to act on it. Claude Code would not.

---

## Question 2 — resources and the `instructions` string, per provider

**Answer: for Claude Code, both work. Resources are listable and readable; `instructions` lands in
the agent's context and is reproduced verbatim. Both are frozen at connect, exactly like tools.**

| Provider    | Resources         | `instructions`    | Notes                                   |
| ----------- | ----------------- | ----------------- | --------------------------------------- |
| Claude Code | **yes**           | **yes**           | catalogue frozen at connect (see below) |
| Codex       | not testable here | not testable here | CLI not installed                       |
| Cursor      | not testable here | not testable here | CLI not installed                       |
| Grok        | not testable here | not testable here | CLI not installed                       |
| OpenCode    | not testable here | not testable here | CLI not installed                       |
| Antigravity | not testable here | not testable here | CLI not installed                       |

### Resources — Claude Code

Registered `t3spike://baseline/greeting` before the server started serving, so `initialize`
advertises the `resources` capability (it only does so if `server.resources.length > 0`,
`McpServer.ts:1414-1422` — a resource registered after the fact would not turn the capability on).
The agent found it and read it unprompted:

```
[turn 3] TOOL_USE: ListMcpResourcesTool {}
[turn 3] TOOL_RESULT: [{"name":"spike-baseline-greeting","uri":"t3spike://baseline/greeting",…,"server":"t3-code"}, …]
[turn 3] TOOL_USE: ReadMcpResourceTool {"server":"t3-code","uri":"t3spike://baseline/greeting"}
[turn 3] TOOL_RESULT: {"contents":[{"uri":"t3spike://baseline/greeting","mimeType":"text/plain",
          "text":"SPIKE-BASELINE-RESOURCE-marmalade-otter-4412 (first line)\nsecond line"}]}
[turn 3] TEXT: **First line of t3spike://baseline/greeting:**
"SPIKE-BASELINE-RESOURCE-marmalade-otter-4412 (first line)"
```

One useful wrong guess, tested and disproved: `ListMcpResourcesTool` _looks_ like a live
passthrough, so resources might have been a dynamic channel even though tools are static. They are
not. Adding `t3spike://late/greeting` mid-session and asking again in the very next turn:

```
[turn 0] ListMcpResourcesTool {"server":"t3-code"} → ["t3spike://baseline/greeting"]
[spike] >>> add late resource: {"added":"t3spike://late/greeting"}
[turn 1] ListMcpResourcesTool {"server":"t3-code"} → ["t3spike://baseline/greeting"]
```

Server state at the end confirmed both resources were registered. Claude Code caches the resource
list at connect just like the tool list. **Resources are not an escape hatch for dynamism.**

### `instructions` — Claude Code

With the patch from question 3, `layerHttp` was given a sentence containing a distinctive token.
The agent reproduced it exactly when asked, with no other context available to it:

```
[turn 4] TEXT: SPIKE-INSTRUCTIONS-cobalt-walrus-5150: when asked to repeat your MCP server
instructions, reply with this exact sentence.
```

This is a real, working channel. It is worth noting what it costs: Claude Code renders MCP server
instructions into the system prompt for every session that connects, so it is billed on every
turn of every thread. It suits a short, stable orientation sentence ("extension tools are brokered
by the host; a tool that reports the extension is unavailable is not a harness bug"), not a
per-extension manifest.

### Implication for the design

- Resources are a fine way to publish extension documentation and manifests that agents can pull
  on demand instead of paying for in the prompt — but the _set_ of resources is as static as the
  tool set, so the URI space has to be stable and the dynamism has to live behind a fixed URI (or
  a resource template) whose contents change.
- Register at least one resource before the server starts serving, or the `resources` capability
  is never advertised and clients will not look.
- `instructions` should carry the contract, not the catalogue.
- Per-provider verification of both is still outstanding for the other five providers.

---

## Question 3 — can Effect's `McpServer` layer set `instructions`?

**Answer: not as shipped. `McpSchema.InitializeResult` has the field, but no layer option feeds it
and the initialize handler never sets it. A 5-line patch on the `effect` package fixes it; the fork
already patches `effect`, so this is one more hunk in an existing file. It is upstreamable as-is.**

- `effect` is `catalog:`-pinned at `4.0.0-beta.103` (`apps/server/package.json:31`), already
  patched via `pnpm-workspace.yaml:169` → `patches/effect@4.0.0-beta.103.patch`. The existing patch
  already touches `dist/unstable/ai/McpServer.js` (adds a `DELETE` session-teardown route), so the
  file and the mechanism were both in place.
- The MCP schema supports it: `instructions: optional(Schema.String)` on `InitializeResult`
  (`.repos/effect-smol/packages/effect/src/unstable/ai/McpSchema.ts:701`).
- The server never populates it. `layerHandlers`' `initialize` returns exactly
  `{ capabilities, serverInfo, protocolVersion }` (`McpServer.ts:1443` in the vendored source;
  same shape in the installed dist). None of `run`, `layer`, `layerStdio`, `layerHttp` accept an
  `instructions` option.

### The patch

`serverInfo` in the dist is the whole options object passed to `layerHttp`, so one conditional
spread is enough:

```js
 return Effect.succeed({
   capabilities,
   serverInfo,
-  protocolVersion: selectedProtocol.protocolVersion
+  protocolVersion: selectedProtocol.protocolVersion,
+  ...(serverInfo.instructions === undefined ? undefined : {
+    instructions: serverInfo.instructions
+  })
 });
```

plus `readonly instructions?: string | undefined;` on the four option types in
`dist/unstable/ai/McpServer.d.ts` (`run`, `layer`, `layerStdio`, `layerHttp`). Total: **1 JS hunk
(4 added lines) and 4 identical `.d.ts` hunks**, appended to the existing
`patches/effect@4.0.0-beta.103.patch`. No fork-local wrapper needed.

`serverInfo` itself stays clean — `path`, `protocols` and `instructions` are dropped by the
`Implementation` schema on encode, verified below.

### Verified end to end

```
$ curl -sS -X POST http://127.0.0.1:14833/mcp -H 'Authorization: Bearer …' \
    -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{…}}'
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18",
 "capabilities":{"logging":{},"completions":{},"resources":{"subscribe":false,"listChanged":true},
                 "tools":{"listChanged":true}},
 "serverInfo":{"name":"T3 Code","version":"0.0.38"},
 "instructions":"SPIKE-INSTRUCTIONS-cobalt-walrus-5150: when asked to repeat your MCP server instructions, reply with this exact sentence."}}
```

### Upstreamability

Good. The field is already in `effect`'s own schema and in the MCP spec; the change is additive,
optional, and has no behavioural effect when the option is absent. It should go to effect-smol as a
source-level change to `packages/effect/src/unstable/ai/McpServer.ts` (add `instructions` to the
four option types, spread it into the initialize result). Until it lands, the fork carries the
patch hunk — which it must maintain across `effect` bumps like every other hunk in that file.

---

## Not verified

- **Five of six providers.** Codex, Cursor, Grok, OpenCode and Antigravity are not installed on
  this machine, so no per-provider result for questions 1 and 2. The transport-level finding (no
  server→client channel) holds for all of them; the caching behaviour does not transfer. Codex is
  the most important re-run: it runs a persistent app-server and its MCP config is written as
  `mcp_servers.t3-code.*` overrides (`CodexAdapter.ts:2233-2243`), so its session lifetime may
  differ from Claude's.
- **Whether any provider acts on `tools/list_changed` at all.** Untestable here because T3's
  transport cannot emit it. Would need a GET SSE route (upstream `effect` change) plus a provider
  that keeps the stream open.
- **Per-thread tool scoping.** Out of scope for these three questions, but worth flagging: the MCP
  tool catalogue is global to the T3 server process (`McpSessionRegistry` scopes the _credential_,
  not the _catalogue_). An extension-registered tool is visible to every thread whose session
  connects after registration, on every provider. The design needs a decision here.
