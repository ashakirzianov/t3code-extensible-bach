import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import {
  AuthExtensionScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
} from "./auth.ts";
import { EnvironmentId, NonNegativeInt, ProjectId, ThreadId } from "./baseSchemas.ts";
import { ProjectIconColor } from "./orchestration.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/**
 * The extension wire protocol.
 *
 * An extension is a separate process that connects to the host over **one
 * WebSocket, as an ordinary client**, using a token that carries the
 * `extension` scope alongside whatever orchestration scopes it needs. The
 * existing client API (`orchestration.dispatchCommand`, `subscribeShell`,
 * `subscribeThread`, `searchThreads`, ...) is unchanged and simply available
 * to it. Everything in this file is the *additional* surface an extension
 * gets, and nothing here replaces or wraps what already exists.
 *
 * ## Why host to extension calls ride on a stream
 *
 * The client protocol is Effect RPC over a WebSocket: a client issues
 * requests, and the only server-initiated traffic is the output of a
 * `stream: true` RPC the client subscribed to. There is no server to client
 * *request*. So a host to extension call cannot be modelled as a request; it
 * is an event on a stream the extension opened, answered by a correlated
 * request back to the host. `previewAutomation.connect` / `.respond` is the
 * same shape for the same reason, and the names here mirror it deliberately.
 *
 * That gives the connection this order:
 *
 * 1. `extensions.hello` — manifest and protocol version in, host facts out.
 * 2. `extensions.registerTools` / `.registerHttpPrefix` / `.registerWebEntry`
 *    — declarative, idempotent, and re-sent in full after a reconnect.
 * 3. `extensions.connect` — opens the stream. **Opening it is the readiness
 *    signal**: the host may invoke tools only once the stream exists, so an
 *    extension that opens it last has finished registering. This matters
 *    because MCP clients cache the tool catalogue at connect
 *    (`docs/internals/extensions/spikes/mcp-client-behaviour.md`), so the host
 *    holds MCP session issuance until enabled extensions are ready.
 * 4. `extensions.respondTool` / `.respondHttp` / `.respondToolsForThread` —
 *    answers, correlated by the invocation or request id plus the
 *    `connectionId` the stream handed out, so an answer from a stale
 *    connection is rejected rather than applied.
 *
 * ## Availability is expressed in results, not in the catalogue
 *
 * A tool whose extension is down does not vanish; it answers with
 * `ExtensionUnavailableError` rendered as an MCP error result. Removing it
 * would be invisible to a live agent, and Effect's MCP server has no remove.
 *
 * ## Definition, not registration
 *
 * This file defines the message *schemas* and the method names. The RPC
 * definitions themselves live in `rpc.ts` with every other method, and the
 * scope each one requires lives in the server's `RpcAuthorization.ts`, which
 * is typed to demand a scope for every RPC in the group. `orchestration.ts`
 * splits the same way.
 *
 * ## Why not `TrimmedNonEmptyString`
 *
 * The repo's trimmed-string idiom is a decode transformation, so its checks
 * describe the decoded value and vanish from the encoded JSON Schema. The
 * generated document under `generated/extensions/` is the contract an
 * extension in another language reads, so the bounds have to survive into it;
 * protocol strings are therefore plain `Schema.String` with explicit checks.
 * The branded host ids (`EnvironmentId`, `ThreadId`, `ProviderInstanceId`) are
 * the exception, and are opaque to extensions anyway.
 */

/**
 * The protocol version this build of the host and its contracts implement.
 *
 * **Version 1 is not frozen, and before 1.0 it is deliberately not.** While
 * Bach is the only extension there is, a shape inside v1 may change without
 * this number moving — the negotiation exists so a host and an extension can
 * disagree about the *protocol*, not so every field is settled before a second
 * consumer exists to be broken by it.
 *
 * What replaces the promise is an obligation on the consumer: **tolerate the
 * previous shape across a deploy skew.** Host and extension are deployed
 * separately, so between one Deploy and the next an extension built against the
 * older shape talks to the newer host, or the reverse, and
 * `ExtensionProtocolMismatchError` will not fire because the number did not
 * move.
 *
 * Applied once: `ExtensionProjectIcon.automatic` became
 * `{ text, color, colorCss }`, and on 2026-09-18 Anton decided not to bump for
 * it; Bach reads both shapes. This ends at 1.0 or at the second independent
 * extension, whichever comes first — from then a shape change is a version
 * change. See `docs/internals/extensions/protocol.md`, "What a version number
 * promises, before 1.0".
 */
export const EXTENSION_PROTOCOL_VERSION = 1;

/**
 * Every protocol version this host still speaks. A host may support more than
 * one so an extension built against an older *protocol version* keeps running
 * across a host update; the list is what `hello` reports back on a mismatch.
 *
 * Note what that does and does not cover, given the paragraph above: it carries
 * an older bundle across changes that moved this number, and before 1.0 not
 * every change does. An extension whose shape assumptions are older than the
 * host's, within one version, is the consumer's business to tolerate — not
 * something a negotiated version can rescue.
 */
export const EXTENSION_SUPPORTED_PROTOCOL_VERSIONS: ReadonlyArray<number> = [
  EXTENSION_PROTOCOL_VERSION,
];

/** A non-empty string with an explicit bound, visible in the generated schema. */
const BoundedString = (maxLength: number) =>
  Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(maxLength));

export const ExtensionProtocolVersion = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate(
  { identifier: "ExtensionProtocolVersion" },
);
export type ExtensionProtocolVersion = typeof ExtensionProtocolVersion.Type;

export const EXTENSION_WS_METHODS = {
  hello: "extensions.hello",
  registerTools: "extensions.registerTools",
  registerResources: "extensions.registerResources",
  registerHttpPrefix: "extensions.registerHttpPrefix",
  registerWebEntry: "extensions.registerWebEntry",
  setBadge: "extensions.setBadge",
  connect: "extensions.connect",
  respondTool: "extensions.respondTool",
  respondHttp: "extensions.respondHttp",
  respondToolsForThread: "extensions.respondToolsForThread",
  respondReadResource: "extensions.respondReadResource",
  projectIcons: "extensions.projectIcons",
  generateText: "extensions.generateText",
} as const;

/**
 * What an extension's token may do. The orchestration scopes are the ones an
 * extension actually uses — dispatching commands and reading threads. Terminal,
 * review, and relay are deliberately withheld: nothing in the design needs
 * them, and a token is easier to widen later than to narrow.
 *
 * Contract rather than server detail: it is what decides which of the client
 * methods an extension can call, so the guide lists it alongside them.
 */
export const EXTENSION_TOKEN_SCOPES = [
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  AuthExtensionScope,
] as const;

// ---------------------------------------------------------------------------
// Names and paths
// ---------------------------------------------------------------------------

/**
 * One identifier per extension, unique within an environment. Kebab case so it
 * is safe in a URL path, a directory name, and a settings key without escaping.
 */
/** The manifest file at the root of a built extension folder. */
export const EXTENSION_MANIFEST_FILE = "extension.json";

export const EXTENSION_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const ExtensionName = BoundedString(64)
  .check(Schema.isPattern(EXTENSION_NAME_PATTERN))
  .annotate({ identifier: "ExtensionName" });
export type ExtensionName = typeof ExtensionName.Type;

/**
 * Tool names are unprefixed in v1 and must be unique across the whole
 * environment, so this is the MCP tool-name charset rather than the stricter
 * extension-name one — `spawn_agent` has to remain spellable.
 */
export const EXTENSION_TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
export const ExtensionToolName = BoundedString(64)
  .check(Schema.isPattern(EXTENSION_TOOL_NAME_PATTERN))
  .annotate({ identifier: "ExtensionToolName" });
export type ExtensionToolName = typeof ExtensionToolName.Type;

/**
 * A path *inside* the extension's folder. The pattern rejects absolute paths,
 * backslashes, and any `..` segment, because the host resolves these against a
 * directory it then serves and spawns from.
 */
export const EXTENSION_RELATIVE_PATH_PATTERN =
  /^(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
export const ExtensionRelativePath = BoundedString(512)
  .check(Schema.isPattern(EXTENSION_RELATIVE_PATH_PATTERN))
  .annotate({ identifier: "ExtensionRelativePath" });
export type ExtensionRelativePath = typeof ExtensionRelativePath.Type;

/** An absolute path on the host, reported to the extension by `hello`. */
export const ExtensionHostPath = BoundedString(1024).annotate({ identifier: "ExtensionHostPath" });
export type ExtensionHostPath = typeof ExtensionHostPath.Type;

/** One kebab segment the host mounts the extension's HTTP routes under. */
export const ExtensionHttpPrefix = BoundedString(64)
  .check(Schema.isPattern(EXTENSION_NAME_PATTERN))
  .annotate({ identifier: "ExtensionHttpPrefix" });
export type ExtensionHttpPrefix = typeof ExtensionHttpPrefix.Type;

/**
 * Where the host serves one extension's proxied HTTP routes, relative to the
 * environment's own origin. The environment id is in the path so a URL minted
 * for one environment cannot silently resolve against another — the server
 * compares it rather than trusting it (`ExtensionHttpRoutes.ts`).
 *
 * One definition, so the route that answers, the `basePath` the extension is
 * told, and the URLs `hostApi.fetch` builds cannot drift apart.
 */
export const EXTENSION_HTTP_ROUTE_PREFIX = "/ext-api";

export const extensionHttpBasePath = (
  environmentId: EnvironmentId,
  prefix: ExtensionHttpPrefix,
): string => `${EXTENSION_HTTP_ROUTE_PREFIX}/${environmentId}/${prefix}`;

export const ExtensionConnectionId = BoundedString(64).annotate({
  identifier: "ExtensionConnectionId",
});
export type ExtensionConnectionId = typeof ExtensionConnectionId.Type;

export const ExtensionInvocationId = BoundedString(128).annotate({
  identifier: "ExtensionInvocationId",
});
export type ExtensionInvocationId = typeof ExtensionInvocationId.Type;

export const ExtensionHttpRequestId = BoundedString(128).annotate({
  identifier: "ExtensionHttpRequestId",
});
export type ExtensionHttpRequestId = typeof ExtensionHttpRequestId.Type;

export const ExtensionReadResourceRequestId = BoundedString(128).annotate({
  identifier: "ExtensionReadResourceRequestId",
});
export type ExtensionReadResourceRequestId = typeof ExtensionReadResourceRequestId.Type;

export const ExtensionToolsRequestId = BoundedString(128).annotate({
  identifier: "ExtensionToolsRequestId",
});
export type ExtensionToolsRequestId = typeof ExtensionToolsRequestId.Type;

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

/**
 * The nav entry the host renders for this extension. The host draws it
 * itself — the extension contributes text, not markup — so `icon` is a path to
 * an SVG in the folder rather than a component.
 */
export const ExtensionWebEntry = Schema.Struct({
  /** ES module the client loads with a same-origin `import()` and mounts. */
  entry: ExtensionRelativePath,
  css: Schema.optionalKey(ExtensionRelativePath),
  label: BoundedString(64),
  icon: Schema.optionalKey(ExtensionRelativePath),
}).annotate({ identifier: "ExtensionWebEntry" });
export type ExtensionWebEntry = typeof ExtensionWebEntry.Type;

export const ExtensionServerEntry = Schema.Struct({
  /** Self-contained JS the host runs on its own Node. No `node_modules`. */
  entry: ExtensionRelativePath,
}).annotate({ identifier: "ExtensionServerEntry" });
export type ExtensionServerEntry = typeof ExtensionServerEntry.Type;

/**
 * `extension.json` at the root of a built extension folder. Version strings
 * are compared by the host, not parsed here, so they are only length-checked.
 */
export const ExtensionManifest = Schema.Struct({
  name: ExtensionName,
  version: BoundedString(64),
  protocolVersion: ExtensionProtocolVersion,
  minHostVersion: Schema.optionalKey(BoundedString(64)),
  server: ExtensionServerEntry,
  web: Schema.optionalKey(ExtensionWebEntry),
}).annotate({ identifier: "ExtensionManifest" });
export type ExtensionManifest = typeof ExtensionManifest.Type;

// ---------------------------------------------------------------------------
// hello
// ---------------------------------------------------------------------------

export const ExtensionHelloInput = Schema.Struct({
  protocolVersion: ExtensionProtocolVersion,
  manifest: ExtensionManifest,
}).annotate({ identifier: "ExtensionHelloInput" });
export type ExtensionHelloInput = typeof ExtensionHelloInput.Type;

export const ExtensionHelloAck = Schema.Struct({
  /** The negotiated version. Both sides speak this for the connection's life. */
  protocolVersion: ExtensionProtocolVersion,
  hostProtocolVersions: Schema.Array(ExtensionProtocolVersion),
  /** The host app version, for the manifest's `minHostVersion` check. */
  hostVersion: BoundedString(64),
  environmentId: EnvironmentId,
  /** The folder the host started this extension from. */
  extensionPath: ExtensionHostPath,
  /** Writable directory the extension owns, under the environment's userdata. */
  dataDirectory: ExtensionHostPath,
}).annotate({ identifier: "ExtensionHelloAck" });
export type ExtensionHelloAck = typeof ExtensionHelloAck.Type;

// ---------------------------------------------------------------------------
// registerTools
// ---------------------------------------------------------------------------

/** Cap on one extension's tool surface, so a bad build cannot flood MCP. */
export const EXTENSION_TOOLS_MAX = 64;

/**
 * What an MCP server's `instructions` may be before a client starts cutting it.
 *
 * Claude Code truncates a server's instructions at roughly 2,500 characters,
 * and it does it mid-sentence. The host composes under this number rather than
 * leaving the cut to the client, so what an agent reads always ends where the
 * host meant it to. Its own preamble is a few hundred characters; the rest is
 * what the extensions get to share.
 */
export const EXTENSION_MCP_INSTRUCTIONS_MAX_CHARS = 2500;

/**
 * Cap on one extension's `instructions`. Deliberately smaller than the budget
 * above: the budget is shared, so an extension that spends all of it is an
 * extension that pushes the next one out entirely. A few hundred characters is
 * the size that survives a second extension being installed.
 */
export const EXTENSION_INSTRUCTIONS_MAX_CHARS = 2000;

export const ExtensionToolDefinition = Schema.Struct({
  name: ExtensionToolName,
  /** What the agent sees. This is the only guidance a tool gets. */
  description: BoundedString(4096),
  /** A JSON Schema object describing the tool's arguments. */
  inputSchema: Schema.Record(Schema.String, Schema.Unknown),
}).annotate({ identifier: "ExtensionToolDefinition" });
export type ExtensionToolDefinition = typeof ExtensionToolDefinition.Type;

export const ExtensionRegisterToolsInput = Schema.Struct({
  /** The complete tool surface. Re-sending replaces the previous set. */
  tools: Schema.Array(ExtensionToolDefinition).check(Schema.isMaxLength(EXTENSION_TOOLS_MAX)),
  /**
   * Opt in to per-thread tool visibility. The host then asks this extension
   * `toolsForThread` before each thread's agent connects, and hides from that
   * thread every registered tool the answer leaves out. Absent or false means
   * every thread sees every tool, which is what every extension got before
   * this existed.
   */
  filterToolsPerThread: Schema.optionalKey(Schema.Boolean),
  /**
   * Standing guidance for every agent in the environment, appended to the MCP
   * server's own `instructions`. It is billed on every turn of every thread,
   * so it belongs to the extension as a whole — what it is, what its tools are
   * for, when not to reach for them — and never to one tool, which has its own
   * `description`.
   *
   * Replaced with the rest of the registration: re-sending without it clears
   * what the previous registration said. Like the tool catalogue, it is read
   * when a provider process connects, so a change reaches the *next* agent
   * session rather than a running one.
   */
  instructions: Schema.optionalKey(BoundedString(EXTENSION_INSTRUCTIONS_MAX_CHARS)),
}).annotate({ identifier: "ExtensionRegisterToolsInput" });
export type ExtensionRegisterToolsInput = typeof ExtensionRegisterToolsInput.Type;

export const ExtensionToolRejectionReason = Schema.Literals([
  "name-collision",
  "invalid-input-schema",
  "unsupported",
]).annotate({ identifier: "ExtensionToolRejectionReason" });
export type ExtensionToolRejectionReason = typeof ExtensionToolRejectionReason.Type;

/**
 * Per tool, not per call: one bad name does not fail the batch, and the
 * extension keeps running with the tools that were accepted (design §5.2).
 */
export const ExtensionToolRegistration = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("accepted"),
    name: ExtensionToolName,
  }),
  Schema.Struct({
    status: Schema.Literal("rejected"),
    name: ExtensionToolName,
    reason: ExtensionToolRejectionReason,
    /** Shown verbatim in Settings, so it names the other owner on collision. */
    message: BoundedString(512),
  }),
]).annotate({ identifier: "ExtensionToolRegistration" });
export type ExtensionToolRegistration = typeof ExtensionToolRegistration.Type;

export const ExtensionRegisterToolsResult = Schema.Struct({
  tools: Schema.Array(ExtensionToolRegistration),
}).annotate({ identifier: "ExtensionRegisterToolsResult" });
export type ExtensionRegisterToolsResult = typeof ExtensionRegisterToolsResult.Type;

// ---------------------------------------------------------------------------
// registerResources
// ---------------------------------------------------------------------------

/** Cap on one extension's resource surface, for the same reason as the tools. */
export const EXTENSION_RESOURCES_MAX = 64;

/**
 * The URI an agent reads a resource by. Unique across the environment, like a
 * tool name: MCP has one flat resource namespace and the host serves its own
 * `t3code://` resources in it.
 */
export const ExtensionResourceUri = BoundedString(512).annotate({
  identifier: "ExtensionResourceUri",
});
export type ExtensionResourceUri = typeof ExtensionResourceUri.Type;

export const ExtensionResourceDefinition = Schema.Struct({
  uri: ExtensionResourceUri,
  /** A short handle. MCP clients use it to label the resource in their UI. */
  name: BoundedString(128),
  /** Why an agent would read this. The only guidance a resource gets. */
  description: BoundedString(4096),
  mimeType: BoundedString(100),
}).annotate({ identifier: "ExtensionResourceDefinition" });
export type ExtensionResourceDefinition = typeof ExtensionResourceDefinition.Type;

export const ExtensionRegisterResourcesInput = Schema.Struct({
  /** The complete resource surface. Re-sending replaces the previous set. */
  resources: Schema.Array(ExtensionResourceDefinition).check(
    Schema.isMaxLength(EXTENSION_RESOURCES_MAX),
  ),
}).annotate({ identifier: "ExtensionRegisterResourcesInput" });
export type ExtensionRegisterResourcesInput = typeof ExtensionRegisterResourcesInput.Type;

export const ExtensionResourceRejectionReason = Schema.Literals([
  "uri-collision",
  "unsupported",
]).annotate({ identifier: "ExtensionResourceRejectionReason" });
export type ExtensionResourceRejectionReason = typeof ExtensionResourceRejectionReason.Type;

/** Per resource, not per call — the same rule `registerTools` answers by. */
export const ExtensionResourceRegistration = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("accepted"),
    uri: ExtensionResourceUri,
  }),
  Schema.Struct({
    status: Schema.Literal("rejected"),
    uri: ExtensionResourceUri,
    reason: ExtensionResourceRejectionReason,
    /** Shown verbatim in Settings, so it names the other owner on collision. */
    message: BoundedString(512),
  }),
]).annotate({ identifier: "ExtensionResourceRegistration" });
export type ExtensionResourceRegistration = typeof ExtensionResourceRegistration.Type;

export const ExtensionRegisterResourcesResult = Schema.Struct({
  resources: Schema.Array(ExtensionResourceRegistration),
}).annotate({ identifier: "ExtensionRegisterResourcesResult" });
export type ExtensionRegisterResourcesResult = typeof ExtensionRegisterResourcesResult.Type;

// ---------------------------------------------------------------------------
// registerHttpPrefix, registerWebEntry, setBadge
// ---------------------------------------------------------------------------

export const ExtensionRegisterHttpPrefixInput = Schema.Struct({
  prefix: ExtensionHttpPrefix,
}).annotate({ identifier: "ExtensionRegisterHttpPrefixInput" });
export type ExtensionRegisterHttpPrefixInput = typeof ExtensionRegisterHttpPrefixInput.Type;

export const ExtensionRegisterHttpPrefixResult = Schema.Struct({
  prefix: ExtensionHttpPrefix,
  /**
   * Where the prefix landed, relative to the host origin. The host owns the
   * routing shape, so the extension is told rather than asked.
   */
  basePath: BoundedString(512),
}).annotate({ identifier: "ExtensionRegisterHttpPrefixResult" });
export type ExtensionRegisterHttpPrefixResult = typeof ExtensionRegisterHttpPrefixResult.Type;

export const ExtensionRegisterWebEntryInput = Schema.Struct({
  web: ExtensionWebEntry,
}).annotate({ identifier: "ExtensionRegisterWebEntryInput" });
export type ExtensionRegisterWebEntryInput = typeof ExtensionRegisterWebEntryInput.Type;

/**
 * The nav badge. `none` clears it. The host holds the last value across a
 * reconnect and clears it when the extension stops, so an extension does not
 * have to re-send one on every restart.
 */
export const ExtensionBadge = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("none") }),
  Schema.Struct({ kind: Schema.Literal("dot") }),
  Schema.Struct({
    kind: Schema.Literal("count"),
    count: NonNegativeInt.check(Schema.isLessThanOrEqualTo(9999)),
  }),
]).annotate({ identifier: "ExtensionBadge" });
export type ExtensionBadge = typeof ExtensionBadge.Type;

export const ExtensionSetBadgeInput = Schema.Struct({
  badge: ExtensionBadge,
}).annotate({ identifier: "ExtensionSetBadgeInput" });
export type ExtensionSetBadgeInput = typeof ExtensionSetBadgeInput.Type;

// ---------------------------------------------------------------------------
// projectIcons
// ---------------------------------------------------------------------------

/**
 * A user's own icon for a project, from Project settings: the host's
 * `ProjectIconOverride`, with bounded strings for the generated schema's sake
 * and the colour's CSS value added.
 */
/**
 * A palette colour as the host draws it, ready to use as a CSS colour: `light`
 * on light themes, `dark` when the host's root element has the `dark` class.
 */
export const ExtensionProjectIconColorCss = Schema.Struct({
  light: BoundedString(64),
  dark: BoundedString(64),
}).annotate({ identifier: "ExtensionProjectIconColorCss" });
export type ExtensionProjectIconColorCss = typeof ExtensionProjectIconColorCss.Type;

export const ExtensionProjectIconOverride = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("lucide"),
    /** A Lucide icon name, kebab case — `rocket`, `book-open`. */
    name: BoundedString(64).check(Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)),
    color: ProjectIconColor,
    colorCss: ExtensionProjectIconColorCss,
  }),
  Schema.Struct({
    kind: Schema.Literal("emoji"),
    emoji: BoundedString(32),
  }),
  Schema.Struct({
    kind: Schema.Literal("monogram"),
    /** A short piece of text — usually one or two graphemes — drawn as the icon. */
    text: BoundedString(32),
    color: ProjectIconColor,
    colorCss: ExtensionProjectIconColorCss,
  }),
]).annotate({ identifier: "ExtensionProjectIconOverride" });
export type ExtensionProjectIconOverride = typeof ExtensionProjectIconOverride.Type;

/**
 * A project's icon, as the host resolves it — kept as its three halves rather
 * than flattened into one picture, because they are different kinds of thing:
 *
 * - `override`: what the user chose. When present, draw it and ignore the rest.
 * - `faviconUrl`: the project's own favicon, as a signed root-relative path,
 *   valid for about an hour — ask again rather than keep it. `null` when the
 *   project has none. **Pass it through the web host API's `resolveAssetUrl`
 *   before loading it; do not use the bare path.** The page's origin is the
 *   environment's HTTP base only on clients whose page the environment served;
 *   a packaged desktop renderer loads `t3code://app` from a directory of static
 *   files with only `/ext-assets/…` bridged to the local backend. An `<img>`
 *   handed the bare path there misses and falls through to `automatic`, which
 *   is why the mistake is a wrong picture rather than a broken one.
 * - `automatic`: what the host draws when there is neither, and what to fall
 *   back to if the favicon fails to load. Always present.
 *
 * Colours come as the palette name (`color`) and as the CSS value the host
 * draws it in (`colorCss`), so a reader needs no colour table of its own.
 */
export const ExtensionProjectIcon = Schema.Struct({
  override: Schema.NullOr(ExtensionProjectIconOverride),
  faviconUrl: Schema.NullOr(BoundedString(2048)),
  /**
   * A monogram on a colour hashed from the project's name — the same two
   * fields as a `monogram` override, and drawn the same way. Nothing here is
   * derived from what the name means, so there is no icon vocabulary to keep
   * in step and no dependency on Lucide.
   */
  automatic: Schema.Struct({
    /** One or two graphemes, already uppercased. Draw it as text. */
    text: BoundedString(32),
    color: ProjectIconColor,
    colorCss: ExtensionProjectIconColorCss,
  }),
}).annotate({ identifier: "ExtensionProjectIcon" });
export type ExtensionProjectIcon = typeof ExtensionProjectIcon.Type;

export const ExtensionProjectIconsInput = Schema.Struct({}).annotate({
  identifier: "ExtensionProjectIconsInput",
});
export type ExtensionProjectIconsInput = typeof ExtensionProjectIconsInput.Type;

/** One entry per project in this environment, keyed as `subscribeShell` keys them. */
export const ExtensionProjectIconsResult = Schema.Struct({
  projects: Schema.Array(
    Schema.Struct({
      projectId: ProjectId,
      icon: ExtensionProjectIcon,
    }),
  ),
}).annotate({ identifier: "ExtensionProjectIconsResult" });
export type ExtensionProjectIconsResult = typeof ExtensionProjectIconsResult.Type;

// ---------------------------------------------------------------------------
// generateText
// ---------------------------------------------------------------------------

/**
 * The environment's configured Text generation model, as a single question and
 * answer.
 *
 * An extension is an ordinary client, so it can start a thread and read its
 * output — but a thread is a working agent with a checkout, a provider session
 * and a visible history, which is far more than a one-shot rewrite of a
 * paragraph needs. This is the small model the host already resolves for its
 * own commit messages and thread titles (Settings, Text generation), reachable
 * without any of that.
 *
 * It is deliberately one prompt in and one string out. There is no token
 * budget and no streaming: the host's providers are CLIs it drives to
 * completion with structured output, so a budget could not be honoured and a
 * partial answer has nowhere to go. Length guidance belongs in the prompt.
 */
export const EXTENSION_GENERATE_TEXT_PROMPT_MAX_CHARS = 100_000;
export const EXTENSION_GENERATE_TEXT_SYSTEM_MAX_CHARS = 10_000;
export const EXTENSION_GENERATE_TEXT_RESULT_MAX_CHARS = 1024 * 1024;

export const ExtensionGenerateTextInput = Schema.Struct({
  /** What to answer, as the extension wrote it. */
  prompt: BoundedString(EXTENSION_GENERATE_TEXT_PROMPT_MAX_CHARS),
  /** Standing instructions for the request, above the prompt itself. */
  system: Schema.optionalKey(BoundedString(EXTENSION_GENERATE_TEXT_SYSTEM_MAX_CHARS)),
}).annotate({ identifier: "ExtensionGenerateTextInput" });
export type ExtensionGenerateTextInput = typeof ExtensionGenerateTextInput.Type;

export const ExtensionGenerateTextResult = Schema.Struct({
  /** The model's answer, trimmed. Never partial: the host waits for the whole of it. */
  text: Schema.String.check(Schema.isMaxLength(EXTENSION_GENERATE_TEXT_RESULT_MAX_CHARS)),
}).annotate({ identifier: "ExtensionGenerateTextResult" });
export type ExtensionGenerateTextResult = typeof ExtensionGenerateTextResult.Type;

// ---------------------------------------------------------------------------
// Host to extension: tool invocation
// ---------------------------------------------------------------------------

/**
 * Who is calling, resolved by the host from the MCP credential and attached to
 * the invocation. The extension trusts this and never takes an identity from
 * the tool arguments — that is the whole point of brokering the call. Mirrors
 * `McpInvocationScope` in the server.
 */
export const ExtensionToolCaller = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  providerSessionId: BoundedString(256),
  providerInstanceId: ProviderInstanceId,
}).annotate({ identifier: "ExtensionToolCaller" });
export type ExtensionToolCaller = typeof ExtensionToolCaller.Type;

export const ExtensionToolInvocation = Schema.Struct({
  invocationId: ExtensionInvocationId,
  name: ExtensionToolName,
  /** Arguments as the agent supplied them, validated against `inputSchema`. */
  arguments: Schema.Record(Schema.String, Schema.Unknown),
  caller: ExtensionToolCaller,
}).annotate({ identifier: "ExtensionToolInvocation" });
export type ExtensionToolInvocation = typeof ExtensionToolInvocation.Type;

// ---------------------------------------------------------------------------
// Host to extension: which tools a thread may see
// ---------------------------------------------------------------------------

/**
 * Asked of an extension that registered with `filterToolsPerThread`, once per
 * thread, just before that thread's agent process connects to MCP.
 *
 * The thread id is the same one `ExtensionToolCaller` carries, so an extension
 * that keeps per-thread state (a role, a team) answers from what it already
 * knows.
 */
export const ExtensionToolsForThreadRequest = Schema.Struct({
  requestId: ExtensionToolsRequestId,
  threadId: ThreadId,
}).annotate({ identifier: "ExtensionToolsForThreadRequest" });
export type ExtensionToolsForThreadRequest = typeof ExtensionToolsForThreadRequest.Type;

// ---------------------------------------------------------------------------
// Host to extension: reading a registered resource
// ---------------------------------------------------------------------------

/**
 * One `resources/read` an agent made, routed to whoever registered the URI.
 *
 * It carries no caller: MCP reads a resource by URI alone, and the host has
 * nothing more truthful to attach. An extension that needs to know who is
 * asking should expose a tool, which does carry `ExtensionToolCaller`.
 */
export const ExtensionReadResourceRequest = Schema.Struct({
  requestId: ExtensionReadResourceRequestId,
  uri: ExtensionResourceUri,
}).annotate({ identifier: "ExtensionReadResourceRequest" });
export type ExtensionReadResourceRequest = typeof ExtensionReadResourceRequest.Type;

// ---------------------------------------------------------------------------
// Host to extension: proxied HTTP
// ---------------------------------------------------------------------------

export const ExtensionHttpMethod = Schema.Literals([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
]).annotate({ identifier: "ExtensionHttpMethod" });
export type ExtensionHttpMethod = typeof ExtensionHttpMethod.Type;

/** Bodies cross the same socket as the UI's traffic, so they are capped. */
export const EXTENSION_HTTP_BODY_MAX_CHARS = 8 * 1024 * 1024;

/**
 * `base64` exists so binary responses survive a JSON transport; `utf8` keeps
 * the common JSON case readable in logs and in other languages.
 */
export const ExtensionHttpBody = Schema.Struct({
  encoding: Schema.Literals(["utf8", "base64"]),
  data: Schema.String.check(Schema.isMaxLength(EXTENSION_HTTP_BODY_MAX_CHARS)),
}).annotate({ identifier: "ExtensionHttpBody" });
export type ExtensionHttpBody = typeof ExtensionHttpBody.Type;

export const ExtensionHttpHeaders = Schema.Record(Schema.String, Schema.String).annotate({
  identifier: "ExtensionHttpHeaders",
});
export type ExtensionHttpHeaders = typeof ExtensionHttpHeaders.Type;

export const ExtensionHttpRequest = Schema.Struct({
  requestId: ExtensionHttpRequestId,
  method: ExtensionHttpMethod,
  /** Path *below* the registered prefix, always leading-slashed. */
  path: Schema.String.check(Schema.isMaxLength(2048), Schema.isPattern(/^\//)),
  /** Raw query string without the `?`. */
  query: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4096))),
  /** Lowercased by the host. Hop-by-hop and auth headers are stripped. */
  headers: ExtensionHttpHeaders,
  body: Schema.optionalKey(ExtensionHttpBody),
  /** The client the host authenticated, so the extension can scope its reads. */
  environmentId: EnvironmentId,
}).annotate({ identifier: "ExtensionHttpRequest" });
export type ExtensionHttpRequest = typeof ExtensionHttpRequest.Type;

// ---------------------------------------------------------------------------
// The stream
// ---------------------------------------------------------------------------

export const ExtensionConnectInput = Schema.Struct({
  name: ExtensionName,
}).annotate({ identifier: "ExtensionConnectInput" });
export type ExtensionConnectInput = typeof ExtensionConnectInput.Type;

/**
 * Everything the host pushes to the extension. `attached` arrives first and
 * carries the `connectionId` every answer must quote; a reconnect mints a new
 * one, which is how the host drops answers from the previous process.
 */
export const ExtensionStreamEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("attached"),
    connectionId: ExtensionConnectionId,
  }),
  Schema.Struct({
    type: Schema.Literal("invokeTool"),
    connectionId: ExtensionConnectionId,
    invocation: ExtensionToolInvocation,
  }),
  Schema.Struct({
    type: Schema.Literal("proxyHttp"),
    connectionId: ExtensionConnectionId,
    request: ExtensionHttpRequest,
  }),
  Schema.Struct({
    type: Schema.Literal("toolsForThread"),
    connectionId: ExtensionConnectionId,
    request: ExtensionToolsForThreadRequest,
  }),
  Schema.Struct({
    type: Schema.Literal("readResource"),
    connectionId: ExtensionConnectionId,
    request: ExtensionReadResourceRequest,
  }),
]).annotate({ identifier: "ExtensionStreamEvent" });
export type ExtensionStreamEvent = typeof ExtensionStreamEvent.Type;

// ---------------------------------------------------------------------------
// Extension to host: answers
// ---------------------------------------------------------------------------

export const EXTENSION_TOOL_TEXT_MAX_CHARS = 1024 * 1024;

/**
 * MCP-shaped content, narrowed to what a tool result actually needs. Image
 * data is base64 rather than bytes because this is a JSON wire an extension in
 * any language has to be able to write.
 */
export const ExtensionToolContent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("text"),
    text: Schema.String.check(Schema.isMaxLength(EXTENSION_TOOL_TEXT_MAX_CHARS)),
  }),
  Schema.Struct({
    type: Schema.Literal("image"),
    data: Schema.String.check(Schema.isMaxLength(EXTENSION_HTTP_BODY_MAX_CHARS)),
    mimeType: BoundedString(100),
  }),
]).annotate({ identifier: "ExtensionToolContent" });
export type ExtensionToolContent = typeof ExtensionToolContent.Type;

export const ExtensionToolResult = Schema.Struct({
  connectionId: ExtensionConnectionId,
  invocationId: ExtensionInvocationId,
  content: Schema.Array(ExtensionToolContent),
  /** Absent means success. An error result is still a *result*, not a failure. */
  isError: Schema.optionalKey(Schema.Boolean),
  structuredContent: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
}).annotate({ identifier: "ExtensionToolResult" });
export type ExtensionToolResult = typeof ExtensionToolResult.Type;

/**
 * The answer to one `toolsForThread`: the registered tools this thread may
 * list and call. A name the extension never registered is ignored, and an
 * empty array is a real answer — that thread sees none of this extension's
 * tools.
 */
export const ExtensionToolsForThreadResult = Schema.Struct({
  connectionId: ExtensionConnectionId,
  requestId: ExtensionToolsRequestId,
  tools: Schema.Array(ExtensionToolName).check(Schema.isMaxLength(EXTENSION_TOOLS_MAX)),
}).annotate({ identifier: "ExtensionToolsForThreadResult" });
export type ExtensionToolsForThreadResult = typeof ExtensionToolsForThreadResult.Type;

/**
 * The bytes of one resource. `text` keeps the common case readable on the wire
 * and in logs; `blob` is base64 so binary survives a JSON transport, exactly
 * as `ExtensionToolContent` does it.
 */
export const ExtensionResourceContents = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("text"),
    uri: ExtensionResourceUri,
    mimeType: Schema.optionalKey(BoundedString(100)),
    text: Schema.String.check(Schema.isMaxLength(EXTENSION_TOOL_TEXT_MAX_CHARS)),
  }),
  Schema.Struct({
    type: Schema.Literal("blob"),
    uri: ExtensionResourceUri,
    mimeType: Schema.optionalKey(BoundedString(100)),
    blob: Schema.String.check(Schema.isMaxLength(EXTENSION_HTTP_BODY_MAX_CHARS)),
  }),
]).annotate({ identifier: "ExtensionResourceContents" });
export type ExtensionResourceContents = typeof ExtensionResourceContents.Type;

/**
 * The answer to one `readResource`. An empty `contents` is a real answer — the
 * resource exists and has nothing in it — so a failure is a *failure*, not an
 * empty array: the host maps a missing answer to an MCP error, because
 * `resources/read` has no `isError` shape a tool result would carry.
 */
export const ExtensionReadResourceResult = Schema.Struct({
  connectionId: ExtensionConnectionId,
  requestId: ExtensionReadResourceRequestId,
  contents: Schema.Array(ExtensionResourceContents),
}).annotate({ identifier: "ExtensionReadResourceResult" });
export type ExtensionReadResourceResult = typeof ExtensionReadResourceResult.Type;

export const ExtensionHttpResponse = Schema.Struct({
  connectionId: ExtensionConnectionId,
  requestId: ExtensionHttpRequestId,
  status: Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 })),
  headers: ExtensionHttpHeaders,
  body: Schema.optionalKey(ExtensionHttpBody),
}).annotate({ identifier: "ExtensionHttpResponse" });
export type ExtensionHttpResponse = typeof ExtensionHttpResponse.Type;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ExtensionProtocolMismatchError extends Schema.TaggedError<ExtensionProtocolMismatchError>()(
  "ExtensionProtocolMismatchError",
  {
    extensionName: Schema.optionalKey(ExtensionName),
    requestedVersion: ExtensionProtocolVersion,
    supportedVersions: Schema.Array(ExtensionProtocolVersion),
  },
) {
  override get message(): string {
    return `Extension protocol version ${this.requestedVersion} is not supported by this host (supported: ${this.supportedVersions.join(", ")}).`;
  }
}

export class ExtensionHandshakeRequiredError extends Schema.TaggedError<ExtensionHandshakeRequiredError>()(
  "ExtensionHandshakeRequiredError",
  {
    method: BoundedString(128),
  },
) {
  override get message(): string {
    return `${this.method} requires a completed ${EXTENSION_WS_METHODS.hello} handshake.`;
  }
}

export class ExtensionToolNameCollisionError extends Schema.TaggedError<ExtensionToolNameCollisionError>()(
  "ExtensionToolNameCollisionError",
  {
    toolName: ExtensionToolName,
    /** Who already owns the name. Absent when the host itself owns it. */
    owner: Schema.optionalKey(ExtensionName),
  },
) {
  override get message(): string {
    return this.owner === undefined
      ? `Tool ${this.toolName} is already provided by T3 Code.`
      : `Tool ${this.toolName} is already provided by extension ${this.owner}.`;
  }
}

export class ExtensionResourceUriCollisionError extends Schema.TaggedError<ExtensionResourceUriCollisionError>()(
  "ExtensionResourceUriCollisionError",
  {
    uri: ExtensionResourceUri,
    /** Who already owns the URI. Absent when the host itself owns it. */
    owner: Schema.optionalKey(ExtensionName),
  },
) {
  override get message(): string {
    return this.owner === undefined
      ? `Resource ${this.uri} is already provided by T3 Code.`
      : `Resource ${this.uri} is already provided by extension ${this.owner}.`;
  }
}

/**
 * The URI reached the broker and nobody registers it — the narrow window
 * between an extension dropping a resource and the next catalogue sync
 * noticing. It becomes an MCP error rather than empty contents, because an
 * agent that gets nothing back cannot tell the two apart.
 */
export class ExtensionUnknownResourceError extends Schema.TaggedError<ExtensionUnknownResourceError>()(
  "ExtensionUnknownResourceError",
  {
    uri: ExtensionResourceUri,
    extensionName: Schema.optionalKey(ExtensionName),
  },
) {
  override get message(): string {
    return `No registered extension resource at ${this.uri}.`;
  }
}

export class ExtensionUnknownToolError extends Schema.TaggedError<ExtensionUnknownToolError>()(
  "ExtensionUnknownToolError",
  {
    toolName: ExtensionToolName,
    extensionName: Schema.optionalKey(ExtensionName),
  },
) {
  override get message(): string {
    return `No registered extension tool named ${this.toolName}.`;
  }
}

export const ExtensionUnavailableReason = Schema.Literals([
  "not-connected",
  "stopped",
  "restarting",
  "timeout",
]).annotate({ identifier: "ExtensionUnavailableReason" });
export type ExtensionUnavailableReason = typeof ExtensionUnavailableReason.Type;

/**
 * The answer a brokered call gets when the extension behind it is not there.
 * Its `message` reaches the agent verbatim as an MCP error result, so it says
 * what happened rather than what failed internally.
 */
export class ExtensionUnavailableError extends Schema.TaggedError<ExtensionUnavailableError>()(
  "ExtensionUnavailableError",
  {
    extensionName: ExtensionName,
    reason: ExtensionUnavailableReason,
    toolName: Schema.optionalKey(ExtensionToolName),
    resourceUri: Schema.optionalKey(ExtensionResourceUri),
  },
) {
  override get message(): string {
    const subject =
      this.toolName !== undefined
        ? `The extension backing ${this.toolName} (${this.extensionName})`
        : this.resourceUri !== undefined
          ? `The extension backing ${this.resourceUri} (${this.extensionName})`
          : `Extension ${this.extensionName}`;
    switch (this.reason) {
      case "stopped":
        return `${subject} is stopped.`;
      case "restarting":
        return `${subject} is restarting; try again shortly.`;
      case "timeout":
        return `${subject} did not answer in time.`;
      case "not-connected":
        return `${subject} is not running.`;
    }
  }
}

export class ExtensionHttpPrefixCollisionError extends Schema.TaggedError<ExtensionHttpPrefixCollisionError>()(
  "ExtensionHttpPrefixCollisionError",
  {
    prefix: ExtensionHttpPrefix,
    owner: Schema.optionalKey(ExtensionName),
  },
) {
  override get message(): string {
    return this.owner === undefined
      ? `HTTP prefix ${this.prefix} is reserved by T3 Code.`
      : `HTTP prefix ${this.prefix} is already registered by extension ${this.owner}.`;
  }
}

/**
 * `extensions.generateText` was asked of an environment with no usable Text
 * generation provider — none enabled, or the configured one no longer
 * installed. A refusal rather than a silent fallback: the answer would come
 * from a model the user did not choose.
 */
export class ExtensionTextGenerationUnavailableError extends Schema.TaggedError<ExtensionTextGenerationUnavailableError>()(
  "ExtensionTextGenerationUnavailableError",
  {},
) {
  override get message(): string {
    return "No text generation provider is configured in this environment. Choose one under Settings, Text generation.";
  }
}

/** The provider was there and the generation failed. `detail` is the provider's own reason. */
export class ExtensionTextGenerationFailedError extends Schema.TaggedError<ExtensionTextGenerationFailedError>()(
  "ExtensionTextGenerationFailedError",
  {
    detail: BoundedString(1024),
  },
) {
  override get message(): string {
    return `Text generation failed: ${this.detail}`;
  }
}

export const ExtensionError = Schema.Union([
  ExtensionProtocolMismatchError,
  ExtensionHandshakeRequiredError,
  ExtensionToolNameCollisionError,
  ExtensionUnknownToolError,
  ExtensionResourceUriCollisionError,
  ExtensionUnknownResourceError,
  ExtensionUnavailableError,
  ExtensionHttpPrefixCollisionError,
  ExtensionTextGenerationUnavailableError,
  ExtensionTextGenerationFailedError,
]).annotate({ identifier: "ExtensionError" });
export type ExtensionError = typeof ExtensionError.Type;

// ---------------------------------------------------------------------------
// Negotiation
// ---------------------------------------------------------------------------

/**
 * The extension states one version and the host either speaks it or does not —
 * there is no "highest common", because the extension only shipped one wire.
 * Used by the host to answer `hello`, and by a vendored client to check the
 * ack it got back.
 */
export const negotiateExtensionProtocolVersion = (options: {
  readonly requestedVersion: number;
  readonly supportedVersions?: ReadonlyArray<number> | undefined;
  readonly extensionName?: ExtensionName | undefined;
}): Result.Result<number, ExtensionProtocolMismatchError> => {
  const supportedVersions = options.supportedVersions ?? EXTENSION_SUPPORTED_PROTOCOL_VERSIONS;
  if (supportedVersions.includes(options.requestedVersion)) {
    return Result.succeed(options.requestedVersion);
  }
  return Result.fail(
    new ExtensionProtocolMismatchError({
      ...(options.extensionName === undefined ? {} : { extensionName: options.extensionName }),
      requestedVersion: options.requestedVersion,
      supportedVersions,
    }),
  );
};

// ---------------------------------------------------------------------------
// Registry and admin surface
// ---------------------------------------------------------------------------

/**
 * One settings entry, per environment. `path` is the built folder; a relative
 * path resolves against the server's cwd. Settings entries win by name over
 * `--extension` launch flags, so overriding a shipped extension with a local
 * build is a settings edit.
 */
export const ExtensionSettingsEntry = Schema.Struct({
  name: ExtensionName,
  path: BoundedString(1024),
  enabled: Schema.Boolean,
}).annotate({ identifier: "ExtensionSettingsEntry" });
export type ExtensionSettingsEntry = typeof ExtensionSettingsEntry.Type;

/** Where the host learned about this extension. There is no "bundled" source. */
export const ExtensionSource = Schema.Literals(["settings", "launch-flag"]).annotate({
  identifier: "ExtensionSource",
});
export type ExtensionSource = typeof ExtensionSource.Type;

/**
 * `changed` is its own flag rather than a state because a changed extension is
 * still running the old build: it is a Deploy affordance, not a health problem.
 */
export const ExtensionRuntimeState = Schema.Literals([
  "disabled",
  "stopped",
  "starting",
  "running",
  "crashed",
]).annotate({ identifier: "ExtensionRuntimeState" });
export type ExtensionRuntimeState = typeof ExtensionRuntimeState.Type;

/**
 * Something the extension asked for and did not get.
 *
 * A rejection is answered to the extension at registration time, but the
 * extension is a background process and its answer reaches nobody. Keeping the
 * refusals on the status is what lets Settings say *why* a tool an extension
 * claims to provide is not there — the collision case in particular, where the
 * fix is to rename one of the two and only the host knows both names.
 *
 * They describe the current registration, not history: re-registering replaces
 * the rejections of that kind, and a restart clears them all.
 */
export const ExtensionRejection = Schema.Struct({
  kind: Schema.Literals(["tool", "resource", "http-prefix"]),
  /** The tool name, resource URI, or prefix that was refused. */
  subject: BoundedString(512),
  /** Shown verbatim; it names the other owner where there is one. */
  message: BoundedString(512),
}).annotate({ identifier: "ExtensionRejection" });
export type ExtensionRejection = typeof ExtensionRejection.Type;

export const ExtensionStatus = Schema.Struct({
  name: ExtensionName,
  path: BoundedString(1024),
  source: ExtensionSource,
  enabled: Schema.Boolean,
  state: ExtensionRuntimeState,
  /** From the manifest. Absent when the folder has no readable manifest. */
  version: Schema.optionalKey(BoundedString(64)),
  protocolVersion: Schema.optionalKey(ExtensionProtocolVersion),
  /** Hash of the folder as it is on disk right now. */
  folderHash: Schema.optionalKey(BoundedString(64)),
  /** Hash of the folder the running process was started from. */
  runningHash: Schema.optionalKey(BoundedString(64)),
  /** The two hashes differ: a build landed and Deploy will pick it up. */
  changed: Schema.Boolean,
  tools: Schema.Array(ExtensionToolName),
  /**
   * URIs of the resources it registered and was granted; a refused one is in
   * `rejections`. Optional only so a client can read a host older than the
   * field, which leaves it out.
   */
  resources: Schema.optionalKey(Schema.Array(ExtensionResourceUri)),
  /**
   * Its registration declared instructions for the MCP server. Whether they
   * reach an agent is `composeMcpInstructions`'s call, made per session.
   * Optional for the same reason as `resources`.
   */
  hasInstructions: Schema.optionalKey(Schema.Boolean),
  /** What it asked for and did not get, in the words Settings shows. */
  rejections: Schema.Array(ExtensionRejection),
  httpPrefix: Schema.optionalKey(ExtensionHttpPrefix),
  web: Schema.optionalKey(ExtensionWebEntry),
  badge: Schema.optionalKey(ExtensionBadge),
  /** Why it is stopped or crashed, in the words Settings shows. */
  lastError: Schema.optionalKey(BoundedString(1024)),
  restartCount: NonNegativeInt,
}).annotate({ identifier: "ExtensionStatus" });
export type ExtensionStatus = typeof ExtensionStatus.Type;

export const ExtensionListResult = Schema.Struct({
  extensions: Schema.Array(ExtensionStatus),
}).annotate({ identifier: "ExtensionListResult" });
export type ExtensionListResult = typeof ExtensionListResult.Type;

export const ExtensionDeployInput = Schema.Struct({ name: ExtensionName }).annotate({
  identifier: "ExtensionDeployInput",
});
export type ExtensionDeployInput = typeof ExtensionDeployInput.Type;

export const ExtensionSetEnabledInput = Schema.Struct({
  name: ExtensionName,
  enabled: Schema.Boolean,
}).annotate({ identifier: "ExtensionSetEnabledInput" });
export type ExtensionSetEnabledInput = typeof ExtensionSetEnabledInput.Type;

/**
 * Signed, short-lived URLs for one extension's web assets.
 *
 * The client loads the bundle with a same-origin `import()`, which cannot set
 * an `Authorization` header, so the credential has to travel in the URL — the
 * same reason `AssetAccess` mints signed asset URLs. Paths are absolute on the
 * host's own origin, so remote, relay, and tunnel clients use them unchanged.
 */
export const ExtensionAssetUrlsInput = Schema.Struct({ name: ExtensionName }).annotate({
  identifier: "ExtensionAssetUrlsInput",
});
export type ExtensionAssetUrlsInput = typeof ExtensionAssetUrlsInput.Type;

export const ExtensionAssetUrlsResult = Schema.Struct({
  name: ExtensionName,
  /** The ES module to `import()`. */
  entry: BoundedString(2048),
  css: Schema.optionalKey(BoundedString(2048)),
  icon: Schema.optionalKey(BoundedString(2048)),
  /** Epoch millis after which these stop resolving and must be re-minted. */
  expiresAt: Schema.Number,
}).annotate({ identifier: "ExtensionAssetUrlsResult" });
export type ExtensionAssetUrlsResult = typeof ExtensionAssetUrlsResult.Type;

/**
 * How long a minted asset URL stays valid. Matches `AssetAccess`'s window: long
 * enough that a mounted extension does not re-mint mid-session, short enough
 * that a leaked URL stops working.
 */
export const EXTENSION_ASSET_TOKEN_TTL_MS = 60 * 60 * 1000;

/** Bounded so one noisy extension cannot grow the host's memory without limit. */
export const EXTENSION_LOG_BUFFER_LINES = 500;

export const ExtensionLogEntry = Schema.Struct({
  at: Schema.Int,
  stream: Schema.Literals(["stdout", "stderr"]),
  line: BoundedString(4096),
}).annotate({ identifier: "ExtensionLogEntry" });
export type ExtensionLogEntry = typeof ExtensionLogEntry.Type;

export const ExtensionLogsInput = Schema.Struct({
  name: ExtensionName,
  limit: Schema.optionalKey(
    Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(EXTENSION_LOG_BUFFER_LINES),
    ),
  ),
}).annotate({ identifier: "ExtensionLogsInput" });
export type ExtensionLogsInput = typeof ExtensionLogsInput.Type;

export const ExtensionLogsResult = Schema.Struct({
  name: ExtensionName,
  entries: Schema.Array(ExtensionLogEntry),
}).annotate({ identifier: "ExtensionLogsResult" });
export type ExtensionLogsResult = typeof ExtensionLogsResult.Type;

/**
 * Client-facing management, gated by the ordinary orchestration scopes rather
 * than the `extension` scope: this is Settings talking, not an extension.
 */
export const EXTENSION_ADMIN_WS_METHODS = {
  list: "extensions.admin.list",
  subscribe: "extensions.admin.subscribe",
  deploy: "extensions.admin.deploy",
  setEnabled: "extensions.admin.setEnabled",
  logs: "extensions.admin.logs",
  install: "extensions.admin.install",
  remove: "extensions.admin.remove",
  setPath: "extensions.admin.setPath",
  assetUrls: "extensions.admin.assetUrls",
} as const;

export class ExtensionNotFoundError extends Schema.TaggedError<ExtensionNotFoundError>()(
  "ExtensionNotFoundError",
  {
    extensionName: ExtensionName,
  },
) {
  override get message(): string {
    return `No extension named ${this.extensionName} is installed in this environment.`;
  }
}

/**
 * The folder is gone, unreadable, or has no valid `extension.json`. Carries the
 * path because the fix is almost always to point the settings entry elsewhere.
 *
 * The manifest's own `name` is deliberately not checked against the name the
 * host installed the folder under: the host's name is authoritative, and the
 * same built folder may be installed more than once.
 */
export class ExtensionFolderError extends Schema.TaggedError<ExtensionFolderError>()(
  "ExtensionFolderError",
  {
    extensionName: Schema.optionalKey(ExtensionName),
    path: BoundedString(1024),
    reason: Schema.Literals(["missing", "unreadable", "invalid-manifest"]),
    detail: Schema.optionalKey(BoundedString(1024)),
  },
) {
  override get message(): string {
    // `detail` is the part that tells the user what to fix, so it belongs in
    // the sentence Settings shows rather than only in the structured error.
    const suffix = this.detail === undefined ? "" : ` (${this.detail})`;
    switch (this.reason) {
      case "missing":
        return `No extension folder at ${this.path}.`;
      case "unreadable":
        return `Could not read the extension folder at ${this.path}${suffix}.`;
      case "invalid-manifest":
        return `${this.path} has no valid extension.json${suffix}.`;
    }
  }
}

/**
 * The name in the folder's manifest is already installed in this environment.
 *
 * Names are the environment's namespace — they key the settings entry, the
 * data directory, the tool owners and the nav row — so a second folder claiming
 * one has to be refused rather than merged. Overriding a shipped extension with
 * a local build is an *edit* of the existing entry's path, not a second install.
 */
export class ExtensionAlreadyInstalledError extends Schema.TaggedError<ExtensionAlreadyInstalledError>()(
  "ExtensionAlreadyInstalledError",
  {
    extensionName: ExtensionName,
  },
) {
  override get message(): string {
    return `An extension named ${this.extensionName} is already installed in this environment.`;
  }
}

export const ExtensionInstallInput = Schema.Struct({
  /** A folder on the host. Relative paths resolve against the server's cwd. */
  path: BoundedString(1024),
}).annotate({ identifier: "ExtensionInstallInput" });
export type ExtensionInstallInput = typeof ExtensionInstallInput.Type;

/** The name came from the folder's manifest, so the caller is told what it got. */
export const ExtensionInstallResult = Schema.Struct({
  name: ExtensionName,
}).annotate({ identifier: "ExtensionInstallResult" });
export type ExtensionInstallResult = typeof ExtensionInstallResult.Type;

export const ExtensionRemoveInput = Schema.Struct({
  name: ExtensionName,
  /**
   * Also delete `<userdata>/extensions/<name>/`. Off by default and asked for
   * explicitly: an extension is usually removed in order to reinstall it, and
   * discarding its state silently would make that lossy.
   */
  deleteData: Schema.Boolean,
}).annotate({ identifier: "ExtensionRemoveInput" });
export type ExtensionRemoveInput = typeof ExtensionRemoveInput.Type;

/**
 * Point an installed extension at another folder.
 *
 * An edit, not an install: the name stays, and so do its data directory and
 * settings. For an extension a launch flag started, this writes the settings
 * entry that overrides the flag — the documented way to run your own build of
 * a shipped extension, surfaced as an action instead of a rule to discover.
 */
export const ExtensionSetPathInput = Schema.Struct({
  name: ExtensionName,
  /** A folder on the host. Relative paths resolve against the server's cwd. */
  path: BoundedString(1024),
}).annotate({ identifier: "ExtensionSetPathInput" });
export type ExtensionSetPathInput = typeof ExtensionSetPathInput.Type;

/**
 * Remove asked of an extension that only a launch flag names. There is no
 * settings entry to drop, so the flag would name it again on the next
 * reconcile: the click would do nothing, and deleting its data would pull the
 * directory out from under a process that is still running. Disable — kept as
 * an `enabled: false` entry — is how a shipped extension is turned off.
 */
export class ExtensionNotRemovableError extends Schema.TaggedError<ExtensionNotRemovableError>()(
  "ExtensionNotRemovableError",
  {
    extensionName: ExtensionName,
  },
) {
  override get message(): string {
    return `${this.extensionName} is started by a launch flag, so there is no settings entry to remove. Disable it instead.`;
  }
}

export const ExtensionAdminError = Schema.Union([
  ExtensionNotFoundError,
  ExtensionFolderError,
  ExtensionAlreadyInstalledError,
  ExtensionNotRemovableError,
]).annotate({ identifier: "ExtensionAdminError" });
export type ExtensionAdminError = typeof ExtensionAdminError.Type;

// ---------------------------------------------------------------------------
// The web host API
// ---------------------------------------------------------------------------

/**
 * The contract between the host's web client and an extension's web bundle.
 *
 * It is deliberately five things and no more: a `mount`, an `unmount`, and the
 * three capabilities a mounted extension cannot get for itself — the list of
 * connected environments, an authenticated `fetch` scoped to one of them, and
 * navigation back into a thread. Everything else an extension needs it already
 * has as an ordinary client on its own WebSocket, from its own process.
 *
 * These are plain TypeScript rather than schemas because they never cross a
 * wire: the bundle runs in the host's page and is handed these objects
 * directly. An extension vendors the shapes (see
 * `extensions/reference/src/web/hostApi.ts`) rather than importing them, so the
 * bundle carries no workspace link — which makes this file the contract the two
 * sides are checked against by hand, not by the compiler.
 *
 * Theme is not part of the API. The container the host hands over sits inside
 * the host's document, so the app's CSS custom properties are already in scope
 * and an extension that styles itself with them follows the host's theme for
 * free — including a theme change while it is mounted.
 */
export interface ExtensionHostEnvironment {
  readonly environmentId: EnvironmentId;
  /** The name the host shows for this environment, already disambiguated. */
  readonly label: string;
  /** True for the environment this mount belongs to. */
  readonly current: boolean;
}

export interface ExtensionHostApi {
  /** The environment this mount belongs to; the usual argument to `fetch`. */
  readonly environmentId: EnvironmentId;
  /**
   * Every environment the client is connected to right now. An extension runs
   * one process per environment, so reaching a sibling instance means naming
   * its environment here and calling `fetch` against it.
   */
  readonly environments: ReadonlyArray<ExtensionHostEnvironment>;
  /**
   * Authenticated request to this extension's own HTTP prefix on one
   * environment. `path` is below the prefix and leading-slashed; the host
   * supplies the origin, the base path, and the credential the client is
   * already using for that environment.
   */
  readonly fetch: (
    environmentId: EnvironmentId,
    path: string,
    init?: RequestInit,
  ) => Promise<Response>;
  /**
   * A root-relative asset path the host minted on one environment — a
   * `faviconUrl` from `extensions.projectIcons` — as a URL this page can load,
   * resolved against that environment's HTTP base the way the host resolves
   * its own. The page's origin is not that base on every client (a packaged
   * desktop renderer is a static `t3code://app`), which is why the path cannot
   * be used as is. `null` when the client is not connected to the environment.
   */
  readonly resolveAssetUrl: (environmentId: EnvironmentId, path: string) => string | null;
  /** Opens a thread in the host's chat view, leaving the extension's route. */
  readonly navigateToThread: (threadId: ThreadId, environmentId?: EnvironmentId) => void;
}

/**
 * The container the host hands over, typed structurally rather than as `Element`
 * because this file is also compiled by the server, whose build has no DOM
 * library. An extension writes `Element` on its own side and it fits.
 */
export interface ExtensionMountContainer {
  readonly tagName: string;
}

/**
 * What the host expects to find on the module it `import()`s.
 *
 * `mount` and `unmount` both take the container because the same extension can
 * be mounted twice in one page under two environments, so neither side may key
 * anything by extension name alone. `subPath` is the part of the URL below the
 * extension's route, always leading-slashed; the host calls `mount` again with
 * a new one rather than remounting when navigation stays inside the extension.
 */
export interface ExtensionWebModule {
  readonly mount: (
    container: ExtensionMountContainer,
    hostApi: ExtensionHostApi,
    subPath: string,
  ) => void | Promise<void>;
  readonly unmount: (container: ExtensionMountContainer) => void | Promise<void>;
}
