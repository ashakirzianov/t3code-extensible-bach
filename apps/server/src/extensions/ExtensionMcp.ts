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
 *   provider process rather than the running one.
 * - **Availability is a result, not a catalogue entry.** A tool whose
 *   extension is stopped, restarting, or gone stays registered and answers
 *   `isError` with a sentence saying so. Removing it would be invisible to a
 *   live agent; an error is legible, and the spike showed agents relay it
 *   without treating it as a harness fault.
 * - **At least one resource is registered before the server starts serving**,
 *   or the `resources` capability is never advertised and clients never look.
 *   The three here are registered as a layer, which is why they are static
 *   registrations rather than another thing `prepareForSession` does.
 */
import {
  type ExtensionListResult,
  type ExtensionToolContent,
  type ExtensionToolName,
  type ExtensionToolResult,
  type ExtensionUnavailableError,
  type ExtensionUnknownToolError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { McpSchema, McpServer } from "effect/unstable/ai";

import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { ExtensionRegistry, type ExtensionRegistryShape } from "./ExtensionRegistry.ts";
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
  readonly name: ExtensionToolName;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}) {
  yield* input.addTool({
    tool: new McpSchema.Tool({
      name: input.name,
      description: input.description,
      inputSchema: input.inputSchema,
    }),
    annotations: Context.empty(),
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
   * extensions, then make sure every tool they registered is in the catalogue.
   */
  readonly prepareForSession: Effect.Effect<void>;
  /**
   * Called once by the MCP layer with an effect that adds any newly registered
   * tools. Run on every issue rather than on a change signal: a tool only ever
   * reaches a *new* provider process, and issuing a credential is exactly when
   * one is about to connect.
   */
  readonly installToolSync: (sync: Effect.Effect<void>) => Effect.Effect<void>;
}

export class ExtensionMcp extends Context.Service<ExtensionMcp, ExtensionMcpShape>()(
  "t3/extensions/ExtensionMcp",
) {}

export const make = Effect.fnUntraced(function* (
  options: { readonly readyTimeout?: Duration.Duration } = {},
) {
  const registry = yield* ExtensionRegistry;
  const toolSync = yield* SynchronizedRef.make<Effect.Effect<void>>(Effect.void);

  const prepareForSession = registry.awaitReady.pipe(
    Effect.timeoutOption(options.readyTimeout ?? EXTENSION_READY_TIMEOUT),
    Effect.andThen(SynchronizedRef.get(toolSync)),
    Effect.flatMap((sync) => sync),
  );

  return ExtensionMcp.of({
    prepareForSession,
    installToolSync: (sync) => SynchronizedRef.set(toolSync, sync),
  });
});

/**
 * Builds the tool sync and hands it to the gate. Lives where `McpServer`
 * exists, which is above the session registry.
 */
export const toolsLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* ExtensionRegistry;
    const server = yield* McpServer.McpServer;
    const gate = yield* ExtensionMcp;
    const registered = yield* SynchronizedRef.make<ReadonlySet<string>>(new Set());

    const syncTools = Effect.gen(function* () {
      const tools = yield* registry.listTools;
      const already = yield* SynchronizedRef.get(registered);
      const missing = tools.filter((tool) => !already.has(tool.definition.name));
      if (missing.length === 0) return;
      yield* Effect.forEach(
        missing,
        (tool) =>
          addExtensionTool({
            addTool: server.addTool,
            registry,
            name: tool.definition.name,
            description: tool.definition.description,
            inputSchema: tool.definition.inputSchema,
          }),
        { discard: true },
      );
      yield* SynchronizedRef.update(registered, (current) => {
        const next = new Set(current);
        for (const tool of missing) next.add(tool.definition.name);
        return next;
      });
    });

    yield* gate.installToolSync(syncTools);
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
