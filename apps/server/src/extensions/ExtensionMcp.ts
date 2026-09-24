/**
 * Brokering extensions onto the process-wide MCP server.
 *
 * Everything here is shaped by one measured fact: an MCP client caches the
 * tool and resource catalogues when its provider process connects, and T3's
 * MCP transport has no way to tell it otherwise
 * (`docs/internals/extensions/spikes/mcp-client-behaviour.md`). So:
 *
 * - **The catalogue is completed before a provider connects, not after.**
 *   Credential issuance waits for every enabled extension to have connected or
 *   given up, bounded by `EXTENSION_READY_TIMEOUT`, and the tool set is synced
 *   into the MCP server immediately before each credential is handed out. A
 *   tool that appears later — a Deploy that added one — reaches the next
 *   provider process rather than the running one. The sync follows a redeploy
 *   in all three directions: a new tool is added, a tool whose description or
 *   schema moved is re-added over the old entry, and a tool the extension
 *   stopped registering is retired from what the next process is shown.
 *
 *   "Next" is exact, and it is the reason a Deploy can look like it did
 *   nothing. `prepareForSession` runs once per session, at issuance, and
 *   `awaitReady` is one-shot — so a spawn that races a Deploy syncs against
 *   whatever the registry held at that instant, which may still be the
 *   pre-Deploy record. The redeploy then lands for the agent after it. Nothing
 *   re-syncs a session that is already running.
 * - **Availability is a result, not a catalogue entry.** A tool whose
 *   extension is stopped, restarting, or gone stays registered and answers
 *   `isError` with a sentence saying so. Removing it would be invisible to a
 *   live agent; an error is legible, and the spike showed agents relay it
 *   without treating it as a harness fault.
 *
 *   Retirement is the narrower case and it is done by visibility, never by
 *   removal: the entry stays in the MCP server, and only leaves the catalogue a
 *   process that connects *next* is shown. Be precise about what an agent that
 *   still holds a retired name gets, because it is **not** the `isError`
 *   sentence above: MCP consults the same visibility predicate on `tools/call`
 *   as on `tools/list` (`mcpCore.ts`, `tools.call`), so the handler is never
 *   reached and the answer is a JSON-RPC error — `Tool "x" not found` — rather
 *   than a tool result. That is legible and it is honest, but it is a different
 *   shape from an unavailable extension's, and an agent may treat it as a
 *   harness fault rather than a fact about the world. The `ExtensionUnknownToolError`
 *   result still exists and still reaches an agent: it covers the narrow window
 *   between an extension dropping a tool and the next sync noticing.
 * - **At least one resource is registered before the server starts serving**,
 *   or the `resources` capability is never advertised and clients never look.
 *   The three host resources are registered as a layer, which is why they are
 *   static registrations rather than another thing `prepareForSession` does.
 *   An extension's resources ride the same sync as its tools, and carry the
 *   same caveat: a URI that appears later reaches the next provider process.
 *   The one difference is what a stale URI answers. A tool can be hidden from
 *   `tools/list` because MCP consults a visibility predicate the host owns; a
 *   resource has no such predicate here, so a URI nobody registers any more
 *   stays listed and the broker answers `ExtensionUnknownResourceError` as a
 *   JSON-RPC error — `resources/read` has no `isError` result to carry it.
 * - **The server-level `instructions` are composed at the same moment.** MCP
 *   publishes them once per `initialize`, which is when a provider process
 *   connects, so an extension's standing guidance follows exactly the rule its
 *   tools do.
 */
import {
  EXTENSION_MCP_INSTRUCTIONS_MAX_CHARS,
  type ExtensionListResult,
  type ExtensionName,
  type ExtensionReadResourceResult,
  type ExtensionResourceContents,
  type ExtensionToolContent,
  type ExtensionToolName,
  type ExtensionToolResult,
  type ExtensionUnavailableError,
  type ExtensionUnknownResourceError,
  type ExtensionUnknownToolError,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { McpSchema, McpServer } from "effect/unstable/ai";

import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import {
  ExtensionRegistry,
  type ExtensionInstructions,
  type ExtensionRegistryShape,
  type ExtensionResourceOwner,
  type ExtensionToolOwner,
} from "./ExtensionRegistry.ts";
import {
  EXTENSION_GUIDE_MARKDOWN,
  EXTENSION_SCAFFOLD_MARKDOWN,
} from "./guideResources.generated.ts";

/**
 * How long credential issuance waits for extensions to become ready. Long
 * enough for a cold Node process to boot and connect, short enough that a hung
 * extension costs one turn rather than blocking the app.
 */
export const EXTENSION_READY_TIMEOUT = Duration.seconds(10);

/**
 * How many threads' answers to `toolsForThread` are kept. One entry per thread
 * that started an agent since the server did, so this is a bound on a long
 * uptime rather than a working set: the answer for a thread that fell out is
 * asked for again the next time that thread starts a session.
 */
export const EXTENSION_VISIBILITY_CACHE_THREADS = 512;

export const EXTENSION_GUIDE_URI = "t3code://extensions/guide";
export const EXTENSION_SCAFFOLD_URI = "t3code://extensions/scaffold";
export const EXTENSION_INSTALLED_URI = "t3code://extensions/installed";

/**
 * The server-level description MCP clients that honour it put in the model's
 * context. It is billed on every turn of every thread, so it carries the
 * contract and points at the resources instead of repeating them.
 */
export const EXTENSION_MCP_INSTRUCTIONS = [
  "This T3 Code supports extensions: separate processes that contribute tools, HTTP routes, and UI.",
  `Read ${EXTENSION_GUIDE_URI} to modify one, ${EXTENSION_SCAFFOLD_URI} to build one, and`,
  `${EXTENSION_INSTALLED_URI} to see what is installed here.`,
  "A tool reporting that its extension is unavailable describes a stopped or restarting extension,",
  "not a harness fault: say so and carry on.",
].join(" ");

/**
 * The whole server-level instructions string: the host's own paragraph, then
 * one section per connected extension, in the order the extensions started.
 *
 * Two things decide the shape. The string is billed on every turn of every
 * thread, and Claude Code cuts it at about
 * `EXTENSION_MCP_INSTRUCTIONS_MAX_CHARS` — mid-sentence, with nothing said.
 * So the host composes under that number itself and drops whole sections
 * rather than letting a client cut one in half, and it names what it dropped:
 * an agent that can see guidance is missing asks, where one reading a
 * truncated sentence just believes it.
 *
 * The host's own paragraph always survives. It is the part that explains what
 * an extension *is*, so it is the one section that is worth nothing in pieces.
 */
export const composeMcpInstructions = (
  sections: ReadonlyArray<ExtensionInstructions>,
  options: { readonly host?: string; readonly budget?: number } = {},
): string => {
  const host = options.host ?? EXTENSION_MCP_INSTRUCTIONS;
  const budget = options.budget ?? EXTENSION_MCP_INSTRUCTIONS_MAX_CHARS;
  const rendered = sections.map(
    (section) => `## ${section.extensionName}\n${section.instructions.trim()}`,
  );
  const compose = (keep: number): string => {
    const parts = [host, ...rendered.slice(0, keep)];
    if (keep < sections.length) {
      const left = sections.slice(keep).map((section) => section.extensionName);
      parts.push(
        `Instructions from ${left.join(", ")} did not fit and were left out; read ${EXTENSION_INSTALLED_URI} to see what is installed.`,
      );
    }
    return parts.join("\n\n");
  };
  // Longest prefix that fits, notice included. Sections are dropped from the
  // end so the order is the start order whatever gets left out, and the count
  // is small enough that trying each length is cheaper than reasoning about
  // how much the notice itself will cost.
  for (let keep = sections.length; keep > 0; keep -= 1) {
    const text = compose(keep);
    if (text.length <= budget) return text;
  }
  return compose(0);
};

/** MCP-shaped content from the extension's answer, mapped one for one. */
const toCallToolContent = (content: ReadonlyArray<ExtensionToolContent>) =>
  content.map((entry) =>
    entry.type === "text"
      ? ({ type: "text", text: entry.text } as const)
      : ({
          type: "image",
          data: new Uint8Array(Buffer.from(entry.data, "base64")),
          mimeType: entry.mimeType,
        } as const),
  );

export const toCallToolResult = (result: ExtensionToolResult): McpSchema.CallToolResult =>
  new McpSchema.CallToolResult({
    content: toCallToolContent(result.content),
    ...(result.isError === undefined ? {} : { isError: result.isError }),
    ...(result.structuredContent === undefined
      ? {}
      : { structuredContent: result.structuredContent }),
  });

/**
 * A brokering failure the agent should read, not a crash it should retry.
 * `message` names the tool and the reason, which is what the spike showed
 * agents relay usefully.
 */
export const toErrorResult = (
  error: ExtensionUnavailableError | ExtensionUnknownToolError,
): McpSchema.CallToolResult =>
  new McpSchema.CallToolResult({
    isError: true,
    content: [{ type: "text", text: error.message }],
    structuredContent: { error: { _tag: error._tag, message: error.message } },
  });

/**
 * The extension's answer as MCP's `ReadResourceResult`. `blob` is decoded here
 * because the MCP schema carries bytes while the extension wire carries
 * base64 — the same asymmetry an image tool result has.
 */
export const toReadResourceResult = (
  result: ExtensionReadResourceResult,
): McpSchema.ReadResourceResult => ({
  contents: result.contents.map((entry: ExtensionResourceContents) =>
    entry.type === "text"
      ? {
          uri: entry.uri,
          ...(entry.mimeType === undefined ? {} : { mimeType: entry.mimeType }),
          text: entry.text,
        }
      : {
          uri: entry.uri,
          ...(entry.mimeType === undefined ? {} : { mimeType: entry.mimeType }),
          blob: new Uint8Array(Buffer.from(entry.blob, "base64")),
        },
  ),
});

/**
 * A brokering failure on `resources/read`. Unlike `tools/call` there is no
 * result shape that carries an error, so the only way an agent hears about a
 * stopped extension is a JSON-RPC failure — `InternalError` is the code MCP
 * reserves for "the server could not do this", and its message is the
 * extension's own sentence.
 */
export const toResourceError = (
  error: ExtensionUnavailableError | ExtensionUnknownResourceError,
): McpSchema.InternalError => new McpSchema.InternalError({ message: error.message });

/**
 * What `t3code://extensions/installed` serves: enough for an agent told "add a
 * capability to Bach" to find Bach's folder without asking a human.
 */
export const installedResourceJson = (list: ExtensionListResult): string =>
  `${JSON.stringify(
    {
      extensions: list.extensions.map((extension) => ({
        name: extension.name,
        version: extension.version ?? null,
        path: extension.path,
        state: extension.state,
        enabled: extension.enabled,
        changed: extension.changed,
        tools: extension.tools,
        ...(extension.lastError === undefined ? {} : { lastError: extension.lastError }),
      })),
    },
    null,
    2,
  )}\n`;

// `ReadResourceResult` is an opaque schema rather than a class, so the result
// is the plain shape it describes.
const readResource = (
  uri: string,
  mimeType: string,
  text: string,
): McpSchema.ReadResourceResult => ({ contents: [{ uri, mimeType, text }] });

/**
 * Registers one extension tool. The handler takes the caller from the
 * invocation context the MCP auth middleware provided, so the identity on a
 * brokered call is the host's resolution and never something the agent wrote
 * into its arguments.
 */
export const addExtensionTool = Effect.fn("ExtensionMcp.addExtensionTool")(function* (input: {
  readonly addTool: McpServer.McpServer["Service"]["addTool"];
  readonly registry: ExtensionRegistryShape;
  readonly extensionName: ExtensionName;
  readonly name: ExtensionToolName;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  /**
   * Whether this tool is in the calling thread's set. Consulted by MCP for
   * `tools/list` *and* `tools/call`, both synchronously, which is why the
   * answer is a cached one and not a round trip to the extension.
   */
  readonly isToolVisible: ExtensionMcpShape["isToolVisible"];
}) {
  yield* input.addTool({
    tool: new McpSchema.Tool({
      name: input.name,
      description: input.description,
      inputSchema: input.inputSchema,
    }),
    // MCP decides visibility from the negotiated client profile, which says
    // nothing about who is calling — so the caller is read from the fiber the
    // MCP request is running on, where the transport's auth middleware put it.
    // A request with no resolved caller sees everything, which is what every
    // tool did before per-thread filtering existed.
    annotations: Context.make(McpSchema.EnabledWhen, () => {
      const fiber = Fiber.getCurrent();
      const invocation =
        fiber === undefined
          ? undefined
          : Context.getOption(fiber.context, McpInvocationContext.McpInvocationContext);
      if (invocation === undefined || invocation._tag === "None") return true;
      return input.isToolVisible({
        extensionName: input.extensionName,
        toolName: input.name,
        threadId: invocation.value.threadId,
      });
    }),
    handle: (payload: unknown) =>
      Effect.withFiber((fiber) => {
        const invocation = Context.getOption(
          fiber.context,
          McpInvocationContext.McpInvocationContext,
        );
        if (invocation._tag === "None") {
          return Effect.succeed(
            new McpSchema.CallToolResult({
              isError: true,
              content: [{ type: "text", text: "This tool requires an MCP session credential." }],
            }),
          );
        }
        const caller = invocation.value;
        return input.registry
          .invokeTool({
            name: input.name,
            arguments: (payload ?? {}) as Readonly<Record<string, unknown>>,
            caller: {
              environmentId: caller.environmentId,
              threadId: caller.threadId,
              providerSessionId: caller.providerSessionId,
              providerInstanceId: caller.providerInstanceId,
            },
          })
          .pipe(
            Effect.map(toCallToolResult),
            Effect.catch((error) => Effect.succeed(toErrorResult(error))),
          );
      }),
  });
});

/**
 * The gate credential issuance waits on.
 *
 * It deliberately knows nothing about `McpServer`: the MCP transport's auth
 * middleware needs `McpSessionRegistry`, so anything the registry depends on
 * has to sit *below* the transport. The tool sync does need the server, so it
 * is installed into the gate by the MCP layer once that exists — late binding
 * is what keeps the two layers from requiring each other.
 */
export interface ExtensionMcpShape {
  /**
   * Everything a provider process about to connect must see: wait for the
   * extensions, make sure every tool they registered is in the catalogue, and
   * ask the extensions that filter per thread what this thread may see.
   */
  readonly prepareForSession: (input: { readonly threadId: ThreadId }) => Effect.Effect<void>;
  /**
   * Whether one extension tool is in one thread's set, answered from what the
   * extensions said at `prepareForSession`. A thread the host never asked
   * about, and an extension that did not answer, are unrestricted: visibility
   * is a smaller promise than authorization, and a silent extension must not
   * take tools away from an agent that is already running.
   */
  readonly isToolVisible: (input: {
    readonly extensionName: ExtensionName;
    readonly toolName: ExtensionToolName;
    readonly threadId: ThreadId;
  }) => boolean;
  /**
   * Called once by the MCP layer with an effect that adds any newly registered
   * tools. Run on every issue rather than on a change signal: a tool only ever
   * reaches a *new* provider process, and issuing a credential is exactly when
   * one is about to connect.
   */
  readonly installCatalogueSync: (sync: Effect.Effect<void>) => Effect.Effect<void>;
  /**
   * The server-level `instructions` as of the last catalogue sync, read
   * synchronously because MCP asks for it while answering `initialize` and the
   * answer has to be a string, not an effect.
   *
   * Same "catalogue at connect" rule as the tools, and for the same reason:
   * `initialize` happens once, when a provider process connects, so what an
   * extension says here reaches the next session rather than a running one.
   */
  readonly mcpInstructions: () => string;
  /** What the extensions are saying now, told to the gate by every sync. */
  readonly noteInstructions: (
    sections: ReadonlyArray<ExtensionInstructions>,
  ) => Effect.Effect<void>;
  /**
   * What the extensions are registering *now*, told to the gate by the tool
   * sync on every run.
   *
   * MCP has no way to withdraw a tool from its server, so a tool an extension
   * stopped registering — a redeploy that dropped it, an extension that was
   * removed — is retired by visibility instead: it leaves the `tools/list` a
   * *new* provider process sees, while the registration stays behind to answer
   * a call from an agent that is already running. Until the first sync there is
   * no answer, and nothing is retired: this is a smaller promise than
   * authorization, and it must never take tools away by not knowing yet.
   *
   * A stopped, crashed, or disabled extension keeps its registrations in the
   * registry, so this does not retire its tools — they stay listed and answer
   * `ExtensionUnavailableError`, which is the legible outcome the spike asked
   * for.
   *
   * **The invariant this leans on**: `registerTools` replaces an extension's
   * whole set in one write, so `listTools` is never a half-registered
   * extension. If registration ever became two calls — a second one adding to
   * the first — a sync landing between them would read a partial set and retire
   * everything the second call was about to restore, and that retirement would
   * stand until the next spawn. Any change there has to keep the write atomic.
   */
  readonly noteRegisteredTools: (tools: ReadonlyArray<ExtensionToolOwner>) => Effect.Effect<void>;
}

export class ExtensionMcp extends Context.Service<ExtensionMcp, ExtensionMcpShape>()(
  "t3/extensions/ExtensionMcp",
) {}

export const make = Effect.fnUntraced(function* (
  options: { readonly readyTimeout?: Duration.Duration } = {},
) {
  const registry = yield* ExtensionRegistry;
  const toolSync = yield* SynchronizedRef.make<Effect.Effect<void>>(Effect.void);
  // A plain Map rather than a ref: `isToolVisible` is called from MCP's own
  // synchronous visibility check, which cannot run an effect. Insertion order
  // is the eviction order, so a re-answered thread is re-inserted.
  const visibleTools = new Map<ThreadId, ReadonlyMap<ExtensionName, ReadonlySet<string>>>();
  // What the last tool sync saw the extensions registering, per extension so
  // two extensions cannot retire each other's names. `undefined` until the
  // first sync, which reads as "not known yet" and retires nothing.
  let registeredTools: ReadonlyMap<ExtensionName, ReadonlySet<string>> | undefined;
  // Composed rather than composed-on-read: `initialize` cannot run an effect,
  // and the sync is the one moment the answer is allowed to move anyway.
  let mcpInstructions = EXTENSION_MCP_INSTRUCTIONS;

  const rememberVisibleTools = (
    threadId: ThreadId,
    answers: ReadonlyMap<ExtensionName, ReadonlySet<ExtensionToolName>>,
  ) =>
    Effect.sync(() => {
      visibleTools.delete(threadId);
      visibleTools.set(threadId, answers);
      while (visibleTools.size > EXTENSION_VISIBILITY_CACHE_THREADS) {
        const oldest = visibleTools.keys().next();
        if (oldest.done === true) break;
        visibleTools.delete(oldest.value);
      }
    });

  const prepareForSession = (input: { readonly threadId: ThreadId }) =>
    registry.awaitReady.pipe(
      Effect.timeoutOption(options.readyTimeout ?? EXTENSION_READY_TIMEOUT),
      Effect.andThen(SynchronizedRef.get(toolSync)),
      Effect.flatMap((sync) => sync),
      // After the sync, so the names an extension answers with are names the
      // catalogue already carries.
      Effect.andThen(registry.toolsForThread(input.threadId)),
      Effect.flatMap((answers) => rememberVisibleTools(input.threadId, answers)),
    );

  return ExtensionMcp.of({
    prepareForSession,
    isToolVisible: (input) => {
      // Retired first: a tool nobody registers any more is out of every
      // thread's set, whatever that thread's extension said about it.
      if (registeredTools !== undefined) {
        const live = registeredTools.get(input.extensionName);
        if (live === undefined || !live.has(input.toolName)) return false;
      }
      const allowed = visibleTools.get(input.threadId)?.get(input.extensionName);
      return allowed === undefined || allowed.has(input.toolName);
    },
    installCatalogueSync: (sync) => SynchronizedRef.set(toolSync, sync),
    mcpInstructions: () => mcpInstructions,
    noteInstructions: (sections) =>
      Effect.sync(() => {
        mcpInstructions = composeMcpInstructions(sections);
      }),
    noteRegisteredTools: (tools) =>
      Effect.sync(() => {
        const next = new Map<ExtensionName, Set<string>>();
        for (const tool of tools) {
          const names = next.get(tool.extensionName) ?? new Set<string>();
          names.add(tool.definition.name);
          next.set(tool.extensionName, names);
        }
        registeredTools = next;
      }),
  });
});

/**
 * A stable rendering of everything about a tool that the MCP catalogue carries:
 * who answers it, what it is called, what it says, and what it takes. Two
 * registrations with the same fingerprint are the same catalogue entry, so
 * re-adding one would only churn a `tools/list_changed` notification; two with
 * different fingerprints are not, and the newer one has to replace the older.
 *
 * Object keys are sorted, because a redeploy that only reordered the JSON it
 * sends has not changed the schema.
 */
const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

export const extensionToolFingerprint = (tool: ExtensionToolOwner): string =>
  stableJson([
    tool.extensionName,
    tool.definition.name,
    tool.definition.description,
    tool.definition.inputSchema,
  ]);

export const extensionResourceFingerprint = (resource: ExtensionResourceOwner): string =>
  stableJson([
    resource.extensionName,
    resource.definition.uri,
    resource.definition.name,
    resource.definition.description,
    resource.definition.mimeType,
  ]);

/**
 * Registers one extension resource. The handler carries no caller: MCP reads a
 * resource by URI and tells the server nothing about who asked, so an
 * extension that needs an identity has to expose a tool instead.
 */
export const addExtensionResource = Effect.fn("ExtensionMcp.addExtensionResource")(
  function* (input: {
    readonly addResource: McpServer.McpServer["Service"]["addResource"];
    readonly registry: ExtensionRegistryShape;
    readonly definition: ExtensionResourceOwner["definition"];
  }) {
    yield* input.addResource({
      resource: new McpSchema.Resource({
        uri: input.definition.uri,
        name: input.definition.name,
        description: input.definition.description,
        mimeType: input.definition.mimeType,
      }),
      annotations: Context.empty(),
      handle: input.registry.readResource({ uri: input.definition.uri }).pipe(
        Effect.map(toReadResourceResult),
        Effect.catch((error) => Effect.fail(toResourceError(error))),
      ),
    });
  },
);

/**
 * The catalogue sync, over any `addTool`: read what the extensions register
 * now, tell the gate so retirement follows, and add or re-add whatever the MCP
 * server does not already carry in that exact shape.
 */
export const makeToolSync = (input: {
  readonly addTool: McpServer.McpServer["Service"]["addTool"];
  readonly registry: ExtensionRegistryShape;
  readonly gate: ExtensionMcpShape;
}): Effect.Effect<Effect.Effect<void>> => {
  const { addTool, registry, gate } = input;
  // Name to fingerprint, so a redeploy that rebound a name to a new
  // description or schema is a difference and not a match. It never shrinks:
  // a retired name's registration stays in the MCP server to answer a live
  // agent, and if the same tool comes back unchanged there is nothing to add.
  return SynchronizedRef.make<ReadonlyMap<string, string>>(new Map()).pipe(
    Effect.map((registered) =>
      Effect.gen(function* () {
        const tools = yield* registry.listTools;
        // Before the early return: a redeploy that only *dropped* a tool adds
        // nothing, and retiring it is the whole of what that sync has to do.
        yield* gate.noteRegisteredTools(tools);
        const already = yield* SynchronizedRef.get(registered);
        const stale = tools.filter(
          (tool) => already.get(tool.definition.name) !== extensionToolFingerprint(tool),
        );
        if (stale.length === 0) return;
        yield* Effect.forEach(
          stale,
          (tool) =>
            addExtensionTool({
              addTool,
              registry,
              extensionName: tool.extensionName,
              name: tool.definition.name,
              description: tool.definition.description,
              inputSchema: tool.definition.inputSchema,
              isToolVisible: gate.isToolVisible,
            }),
          { discard: true },
        );
        yield* SynchronizedRef.update(registered, (current) => {
          const next = new Map(current);
          for (const tool of stale) {
            next.set(tool.definition.name, extensionToolFingerprint(tool));
          }
          return next;
        });
      }),
    ),
  );
};

/**
 * The resource half of the same sync. Separate from the tools only because
 * `addResource` is a different call: the rules are identical, down to the
 * fingerprint map never shrinking, and for the same reason — a resource an
 * extension stopped registering has to keep answering an agent that already
 * holds its URI.
 *
 * Unlike a tool it is not *retired*: MCP consults no visibility predicate the
 * host controls here, so the registration stays and the broker answers
 * `ExtensionUnknownResourceError` once nobody owns the URI.
 */
export const makeResourceSync = (input: {
  readonly addResource: McpServer.McpServer["Service"]["addResource"];
  readonly registry: ExtensionRegistryShape;
}): Effect.Effect<Effect.Effect<void>> => {
  const { addResource, registry } = input;
  return SynchronizedRef.make<ReadonlyMap<string, string>>(new Map()).pipe(
    Effect.map((registered) =>
      Effect.gen(function* () {
        const resources = yield* registry.listResources;
        const already = yield* SynchronizedRef.get(registered);
        const stale = resources.filter(
          (resource) =>
            already.get(resource.definition.uri) !== extensionResourceFingerprint(resource),
        );
        if (stale.length === 0) return;
        yield* Effect.forEach(
          stale,
          (resource) =>
            addExtensionResource({ addResource, registry, definition: resource.definition }),
          { discard: true },
        );
        yield* SynchronizedRef.update(registered, (current) => {
          const next = new Map(current);
          for (const resource of stale) {
            next.set(resource.definition.uri, extensionResourceFingerprint(resource));
          }
          return next;
        });
      }),
    ),
  );
};

/**
 * Everything a provider process about to connect has to be shown: the tools,
 * the resources, and the instructions. One installed effect rather than three,
 * because they share a moment — the instant before a credential is handed out
 * — and nothing reads a half-synced catalogue.
 */
export const makeCatalogueSync = (input: {
  readonly addTool: McpServer.McpServer["Service"]["addTool"];
  readonly addResource: McpServer.McpServer["Service"]["addResource"];
  readonly registry: ExtensionRegistryShape;
  readonly gate: ExtensionMcpShape;
}): Effect.Effect<Effect.Effect<void>> =>
  Effect.gen(function* () {
    const tools = yield* makeToolSync(input);
    const resources = yield* makeResourceSync(input);
    return Effect.gen(function* () {
      yield* tools;
      yield* resources;
      yield* input.gate.noteInstructions(yield* input.registry.listInstructions);
    });
  });

/**
 * Builds the catalogue sync and hands it to the gate. Lives where `McpServer`
 * exists, which is above the session registry.
 */
export const catalogueLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* ExtensionRegistry;
    const server = yield* McpServer.McpServer;
    const gate = yield* ExtensionMcp;
    yield* gate.installCatalogueSync(
      yield* makeCatalogueSync({
        addTool: server.addTool,
        addResource: server.addResource,
        registry,
        gate,
      }),
    );
  }),
);

/** The three resources from design §13, as definitions a caller registers. */
export const extensionResourceDefinitions = (
  registry: ExtensionRegistryShape,
): ReadonlyArray<{
  readonly resource: McpSchema.Resource;
  readonly handle: Effect.Effect<McpSchema.ReadResourceResult>;
}> => [
  {
    resource: new McpSchema.Resource({
      uri: EXTENSION_GUIDE_URI,
      name: "t3-extension-guide",
      description:
        "How T3 Code extensions work: the protocol, the manifest, and the host web API. Read this to modify an existing extension.",
      mimeType: "text/markdown",
    }),
    handle: Effect.succeed(
      readResource(EXTENSION_GUIDE_URI, "text/markdown", EXTENSION_GUIDE_MARKDOWN),
    ),
  },
  {
    resource: new McpSchema.Resource({
      uri: EXTENSION_SCAFFOLD_URI,
      name: "t3-extension-scaffold",
      description:
        "A complete reference extension with build and deploy steps. Read this to build a new extension.",
      mimeType: "text/markdown",
    }),
    handle: Effect.succeed(
      readResource(EXTENSION_SCAFFOLD_URI, "text/markdown", EXTENSION_SCAFFOLD_MARKDOWN),
    ),
  },
  {
    resource: new McpSchema.Resource({
      uri: EXTENSION_INSTALLED_URI,
      name: "t3-extensions-installed",
      description:
        "The extensions installed in this environment: name, version, folder path, and state. Dynamic — read it to find an extension's source folder.",
      mimeType: "application/json",
    }),
    // Read on demand, so the URI is stable while what it says is not. The
    // resource *set* is as frozen as the tool set; only contents can move.
    handle: registry.list.pipe(
      Effect.map((list) =>
        readResource(EXTENSION_INSTALLED_URI, "application/json", installedResourceJson(list)),
      ),
    ),
  },
];

/**
 * Registered as a layer so the resources exist before the transport starts
 * serving — one added later would never turn the `resources` capability on,
 * and clients would never look.
 */
export const resourcesLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const registry = yield* ExtensionRegistry;
    yield* Effect.forEach(
      extensionResourceDefinitions(registry),
      (definition) =>
        server.addResource({
          resource: definition.resource,
          annotations: Context.empty(),
          handle: definition.handle,
        }),
      { discard: true },
    );
  }),
);

export const layer = (options: { readonly readyTimeout?: Duration.Duration } = {}) =>
  Layer.effect(ExtensionMcp, make(options));
