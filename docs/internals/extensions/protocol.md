# Extension protocol

An extension is a separate process. It opens **one WebSocket to the host and speaks the
ordinary client protocol**, using a token that carries the new `extension` scope alongside
whatever orchestration scopes it needs. Nothing loads into the host process, and the host
never dials out.

## Your extension is a client

Read this before reaching for anything below. An extension holds an ordinary client token on
an ordinary client socket, so **the API the product is built on is already your API** — the
same `orchestration.dispatchCommand`, `subscribeShell`, `subscribeThread`, and
`searchThreads` the web app calls, under whatever scopes your token carries. Spawning agents,
sending messages, and deriving state all happen there. Everything the `extensions.*` methods
add is the small remainder that has no client equivalent: registering tools, claiming an HTTP
prefix, mounting a web entry, and answering what the host pushes back. If you are wondering
which of the two surfaces a thing belongs to, the answer is almost always the client one.

The generated [Client API](#client-api) section lists every method available to you, grouped
by prefix, with what each takes and returns. For the model behind the orchestration methods —
why a dispatched command is an intent rather than a result, and why the acknowledgement
arrives before the provider has done anything — read
[Durable intent and side effects](../overview.md#durable-intent-and-side-effects). An
extension that treats a command acknowledgement as completion will look broken in exactly the
ways that document explains.

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

## Per-thread tool sets

By default every thread sees every registered tool. An extension that registers with
`filterToolsPerThread: true` is asked instead: the host sends a `toolsForThread` stream event
naming one thread, and the extension answers `extensions.respondToolsForThread` with the
tools that thread may use. Tools left out are hidden from `tools/list` **and** refused by
`tools/call`, so a name an agent already knows is no way around the filter. The thread id is
the one `ExtensionToolCaller` carries, so an extension that keeps a role per thread answers
from what it already knows.

The host asks once per thread, immediately before that thread's agent process is given its
MCP credential — the same moment the tool catalogue is completed, and for the same reason:
**an MCP client caches the catalogue at connect** ([spike](spikes/mcp-client-behaviour.md)).
So a set that changes mid-session — an agent promoted to team lead — reaches that agent's
_next_ provider process, not the running one. A call it makes in the meantime is still
checked against the set it was given at connect, which is the older, narrower one. Design a
role change to take effect on the next session rather than to revoke a tool mid-turn.

The filter is **visibility, not authorization**. An extension that must refuse an action
still checks inside the tool: a thread the host never asked about, and an extension that was
down or silent when asked, keep every tool. The host fails open on purpose — a restarting
extension must not silently strip tools from an agent that is mid-task — so the filter tidies
what an agent sees rather than guarding what it can do.

An extension that never sets the flag is never asked, and behaves exactly as before.

## HTTP and web

A registered prefix is served under the host's own origin and auth, so remote, relay, and
tunnel clients reach it unchanged. The host proxies each request onto the stream and waits
for the matching response. Bodies are `utf8` or `base64` so binary survives a JSON wire.

The nav row the host draws carries the manifest's `icon` when it declares one —
served, like the bundle, by the signed asset route — and the host's own icon when
it does not. The row is labelled, sits at the end of the thread list, and shows
the badge at its end; a folder that has moved under a running process adds a
small affordance that leads to Settings, where Deploy lives with the version, the
path and the logs.

The web entry is a path to an ES module inside the extension's folder. The client loads it
with a same-origin `import()` — the only thing that executes under the desktop CSP
([spike](spikes/electron-runtime.md)) — and mounts it in a container the host owns. The host
draws the nav entry itself from the label, icon, and badge.

## Text generation

`extensions.generateText` asks the environment's configured Text generation model one
question: a `prompt`, an optional `system`, and a `text` back. It is the same small model the
host uses for commit messages and thread titles, chosen under Settings → Text generation.

An extension is an ordinary client, so it could start a thread and read its output instead —
but a thread is a working agent with a checkout, a provider session and a history the user
sees, which is more than rewriting a paragraph needs. Use a thread for work; use this for a
sentence.

Three things it deliberately does not do. There is **no token budget**: the host drives
provider CLIs to completion with structured output, so a budget could not be honoured — say
how long the answer should be in the prompt. There is **no streaming**: the answer arrives
whole or not at all. And there is **no checkout**: the model runs in an empty scratch
directory the host removes afterwards, so a project's own agent configuration cannot reach
into an unrelated answer. Nothing the extension sends is attached to a thread.

An environment with no enabled provider answers `ExtensionTextGenerationUnavailableError`
rather than quietly picking something; a provider that failed answers
`ExtensionTextGenerationFailedError` with its own reason. Both are refusals to show a user,
not conditions to retry blindly.

## Project icons

An extension that shows projects should draw the icon the host draws, and one part of that
is not reachable as an ordinary client: the automatic icon the host picks from a project's
name when it has nothing better. `extensions.projectIcons` answers with every project's icon
in the three halves the host itself resolves, kept apart rather than flattened into one
picture:

- `override` — what the user chose in Project settings, an emoji or a Lucide icon and
  colour. When it is set, draw it and ignore the rest.
- `faviconUrl` — the project's own favicon as a signed, same-origin path an `<img>` loads as
  is, the same URL the sidebar uses. `null` when the project has none. It expires in about an
  hour, so ask again when you render rather than keeping it.
- `automatic` — a Lucide icon name and a colour. Always present: it is what to draw when
  there is neither of the others, and what to fall back to if the favicon fails to load.

The automatic name is one of a **closed set** of 22 Lucide names, enumerated in the schema as
`ExtensionAutomaticProjectIconName`: `bot`, `book-open`, `cloud-cog`, `database`, `monitor`,
`gamepad-2`, `image`, `smartphone`, `music`, `package`, `shield-check`, `server`,
`shopping-bag`, `terminal`, `flask-conical`, `video`, `earth`, `code-xml`, `braces`,
`circuit-board`, `folder-code`, `layers`. A consumer that draws them from its own copies,
without a Lucide dependency, can rely on that list being complete: a name joins it only
with a protocol change. An override's Lucide name is the user's choice and is not limited
to this set.

Colours come twice: `color` is the palette name, and `colorCss` is the CSS value the host
draws it in — `light` on light themes, `dark` when the host's root element has the `dark`
class — so a consumer needs no colour table of its own. The rule behind those values, for a consumer that builds its own table: they are Tailwind v4's default palette at shade 600 on light themes and 400 on dark — the shades the host's own classes use — given as Tailwind's `oklch()` values, not hex. The `faviconUrl` is root-relative
(`/api/assets/…`), never an absolute origin, so the packaged desktop's `t3code://` proxy
re-bases it like any other page path. The answer is keyed by the same project ids
`subscribeShell` uses; when a project's title, favicon or icon changes there, ask again.

## Where extensions come from

Two sources, and no third: entries in the environment's settings
(`extensions: [{ name, path, enabled }]`) and repeatable `--extension name=path` launch
flags. The desktop shell passes a flag for whatever sits in its resources directory, so a
shipped extension is indistinguishable from one a developer pointed at by hand — the word
"bundled" appears nowhere in the server.

Both are read again whenever the environment's settings change, so **installing
or removing an extension takes effect without a restart**: a new entry has its
folder read and starts, an entry that goes stops and is unregistered — freeing
its tool names and HTTP prefix — one whose path moved restarts on the new folder,
and `enabled` is followed either way. `extensions.admin.install` takes a path,
reads the folder's manifest for the name, refuses one already installed, and
writes the entry; `extensions.admin.remove` drops it, and deletes the data
directory only when asked; `extensions.admin.setPath` repoints an installed one at
another folder, keeping its name, data and switch. Reconciling is idempotent, so a
settings write that has nothing to do with extensions costs nothing — which is also
why Enable/Disable writes the entry's `enabled` rather than only stopping the
process: anything held only in memory would be undone by the next reconcile.

**A settings entry wins by name.** Writing an entry for `bach` pointing at your checkout's
build overrides the shipped copy; writing one with `enabled: false` turns it off. That one
rule is what makes the launch flag safe to hardcode, and Settings acts on it rather than
asking anyone to know it: changing the folder of, or disabling, a flag-started extension
writes that overriding entry.

**Remove means the settings entry.** For an extension an entry installed, it drops the
entry — and if a launch flag also names it, the flag's folder takes over again instead of
the extension disappearing. An extension only a launch flag names has no entry to drop, so
`extensions.admin.remove` refuses it (`ExtensionNotRemovableError`) and Settings does not
offer it: the flag would start it again on the next reconcile, and deleting its data would
pull the directory out from under a running process. Disable, kept as an `enabled: false`
entry, is how a shipped extension is turned off.

The name in the settings entry, not the manifest's, is the one the host installs under and
the one it hands the process as `T3_EXT_NAME`. Start order is the order entries are written,
then flags nothing named, and it is stable across restarts because a tool-name collision is
settled by whoever started first.

## Deploy

The host records a content hash of the folder when it starts a process. When the folder's
hash moves — an agent rebuilt it, an update landed — the extension is marked **changed** and
Settings offers Deploy. **Deploy is stop, rehash, start**, which is the same action whether
the new bytes came from a local build, a download, or an app update.

Deploy is a host action and human-only. Nothing an extension or an agent can call reaches
it. A crash-looping extension is the exception that needs no click: every restart re-reads
the folder, so a fix that lands while it is down is picked up on the next attempt.

## Starting an extension

The host spawns the extension from its folder on the host's own Node — under the
desktop, the app's own binary with `ELECTRON_RUN_AS_NODE=1`, which is how the server
itself already runs ([spike](spikes/electron-runtime.md)). Everything the extension
needs arrives as environment variables; nothing is inferred from the process.

| Variable                  | Meaning                                                                                         |
| ------------------------- | ----------------------------------------------------------------------------------------------- |
| `T3_EXT_NAME`             | The name the host registered this extension under; authoritative over the manifest's own `name` |
| `T3_EXT_TOKEN`            | Bearer token carrying the `extension` scope plus whatever orchestration scopes it was granted   |
| `T3_EXT_WS_URL`           | Absolute `ws://` or `wss://` URL for the host's ordinary client socket, connected to verbatim   |
| `T3_EXT_DATA_DIR`         | Absolute path to the per-environment directory the extension owns                               |
| `T3_EXT_PROTOCOL_VERSION` | Protocol version the host intends to speak; absent means 1                                      |

`T3_EXT_NAME` is what the extension must introduce itself as, in both
`extensions.hello` and `extensions.connect` — the host verifies that the two agree.
It overrides the manifest's own `name`: the token's subject is `extension:<name>`,
and a token minted for one extension cannot say hello as another, so the same built
folder installed twice must introduce itself as the installation it was spawned for.

The host refuses `hello` for a name it does not already know. A name comes from a
settings entry or an `--extension name=path` launch flag first; `npx t3 pair
--extension <name>` mints the credential and prints the environment block.

**The URL is the host's ordinary client socket** (`ws://<host>:<port>/ws`), not a
per-extension endpoint. An extension _is_ a plain client; what the `extension` scope
buys is access to the `extensions.*` methods on that same connection, alongside the
whole existing client API.

The token travels as `Authorization: Bearer <token>` on the WebSocket handshake.
`authenticateWebSocketUpgrade` (`apps/server/src/auth/EnvironmentAuth.ts:984`) checks
a `?ticket=` query parameter first — that exists because browsers cannot set
handshake headers — and otherwise takes the `Authorization` header, which is the path
a spawned extension uses.

A fully-formed URL rather than a base keeps host, port, and scheme entirely the
host's business, so remote, relay, and tunnel modes need no change in any extension.

Only `hello` names the extension. `registerTools`, `registerHttpPrefix`,
`registerWebEntry`, and `setBadge` carry no name: the socket's identity is
established by the handshake and held for the connection.

**`cwd` is the extension folder, but do not depend on it.** A bundled extension can
ship inside the packaged app's `app.asar`, and a path inside an asar cannot be a
process `cwd` — the packaged server sets its cwd to the home directory for exactly
this reason ([spike](spikes/electron-runtime.md)). An extension that resolves its own
files from `import.meta.url` keeps working if that day comes.

**The extension folder is read-only.** Everything the extension writes goes under
`T3_EXT_DATA_DIR`.

### The wire

The host serves Effect RPC with `RpcSerialization.layerJson`, which means one JSON
value per WebSocket frame; a frame may be a single message or an array of them. An
extension needs these five shapes and no Effect dependency —
`extensions/reference/src/server/rpc.ts` is a complete implementation in about two
hundred lines.

Extension to host:

```jsonc
{"_tag":"Request","id":1,"tag":"extensions.hello","payload":{ },"headers":[]}
{"_tag":"Ack","requestId":1}        // release the next chunk of a stream
{"_tag":"Interrupt","requestId":1}  // cancel a request or stream
```

Host to extension:

```jsonc
{"_tag":"Exit","requestId":1,"exit":{"_tag":"Success","value":{ }}}
{"_tag":"Exit","requestId":1,"exit":{"_tag":"Failure","cause":[{"_tag":"Fail","error":{ }}]}}
{"_tag":"Chunk","requestId":1,"values":[{ }]}   // one batch of stream events
{"_tag":"Ping"}                                  // answer with {"_tag":"Pong"}
```

Streams are pull-based: after each `Chunk` the host waits for an `Ack` before
sending the next. An extension that never acknowledges sees exactly one event and
then silence, which is the first thing to check when a stream looks dead.

## The HTTP surface

Two routes put an extension on the host's own origin, under the host's own auth. An
extension never opens a port and never sees a client's credential.

**`/ext-api/<environmentId>/<prefix>/*`** proxies one request onto the extension's
stream. It requires the same orchestration read scope as the `/api` routes, so
reaching an extension is exactly as privileged as reaching the rest of the
environment. The environment id in the path is compared against the server's own
rather than trusted — a URL minted for another environment does not resolve here just
because it arrived.

What crosses the wire: the method, the path **below the prefix** (so an extension
routes on `/status` wherever the host mounted it), the raw query string, and headers
lowercased with hop-by-hop and credential headers removed. The body is `utf8` when the
content type is textual and `base64` otherwise, capped at
`EXTENSION_HTTP_BODY_MAX_CHARS` measured on the encoded string — base64 is a third
larger than the bytes it carries.

| Situation                    | Status                                   |
| ---------------------------- | ---------------------------------------- |
| No extension owns the prefix | 404                                      |
| Registered but not connected | 503, the error's own message as the body |
| Connected but did not answer | 504                                      |
| Body over the cap            | 413                                      |
| Method outside the contract  | 405                                      |

**`/ext-assets/<signed>/<name>/<path>`** serves the web bundle. The client loads it
with a same-origin `import()`, which cannot set an `Authorization` header, so the
credential travels as a signed path segment — an HMAC over a claims blob with a
one-hour life, the same shape and for the same reason as `assets/AssetAccess.ts`, with
its own signing key so a token cannot be replayed across the two surfaces.

`extensions.admin.assetUrls({ name })` mints them: absolute paths on the host origin
for the entry, and for the css and icon when declared. Serving is deliberately narrow —
only an extension that is running or starting, only one with a registered web entry,
and only files inside that entry's own directory, so a code-split bundle's sibling
chunks resolve while a traversal does not. The module is served as `text/javascript`,
which the browser requires before it will execute it at all.

Every failure — forged, expired, wrong extension, missing file, traversal — answers 404. Distinguishing them only helps a prober.

**Not yet: an extension on a remote environment.** The desktop renderer's
`script-src 'self'` means a bundle can only execute from the host's own origin, and
the fetch-then-`blob:` escape is blocked too ([spike](spikes/electron-runtime.md)). A
bundle belonging to a remote environment therefore has to be proxied through the local
backend before it can be mounted. That proxying is a follow-up; today these routes
serve the environment the server itself is.

## Web host

The client draws one nav entry per **(environment, extension with a web entry)**: an
extension runs one process per environment, and the two instances are different things to
look at. The host draws the entry itself from the label, icon and badge the extension
registered — an extension contributes text, never markup — and adds the environment's name
to the label only when more than one environment is connected. An entry whose folder has
moved under a running process also carries a Deploy affordance, which opens the host's own
confirmation; Deploy is a human click in host UI and there is nothing an extension or an
agent can call to reach it.

Clicking an entry routes to `/ext/<environmentId>/<name>/…`. Everything below that is the
extension's own routing space: the host passes it down as a sub-path and never interprets
it, so an extension can have as many screens as it likes without the host knowing any of
them. Navigating between them re-runs `mount` with the new sub-path rather than tearing the
tree down and rebuilding it.

Mounting is `extensions.admin.assetUrls` followed by a same-origin dynamic `import()` of
what it minted — the only strategy that executes under the desktop CSP, as the section
above explains. The client links the stylesheet first so the extension's first frame is
already styled, imports the module, and calls `mount` with a container it owns; on the way
out it calls `unmount` and removes the link. An extension on a remote environment cannot be
mounted for the same reason its bundle cannot be served from here yet, so the route says so
instead of failing quietly.

The host API a mounted bundle is handed is five things and no more: `mount`, `unmount`, the
list of connected environments, an authenticated `fetch` scoped to one of them, and
navigation into a thread. Everything else an extension needs, it already has as an ordinary
client on its own socket, from its own process — so nothing else belongs here. Theme is
deliberately absent: the container sits inside the host's document, so the app's CSS custom
properties are already in scope, and an extension styled with them follows a theme change
while it is mounted.

**Settings → Extensions** is the other half of the same live list: one section per connected
environment, and per extension its version, where the host learned about it, where its folder
is, what state it is in, the tools it registered, whatever it asked for and did not get, and a
tail of its output. Deploy and Enable/Disable live here, each behind the host's own
confirmation and each showing its own reverse, and the sidebar's "new build on disk" marker
links straight to the row rather than acting on its own — the version, the state and the
output are what make Deploy a decision rather than a reflex.

Mobile is a non-goal for v1. The nav entry, the extension route and the Settings screen are
web-only, and the mobile app neither lists extensions nor mounts them; the derivations from
the list to the nav rows and the settings rows live in `client-runtime` so that stays a
decision rather than a rewrite.

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
