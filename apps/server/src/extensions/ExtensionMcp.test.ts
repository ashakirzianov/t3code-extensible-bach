// @effect-diagnostics preferSchemaOverJson:off - the installed resource is asserted as JSON.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  EXTENSION_PROTOCOL_VERSION,
  EnvironmentId,
  ExtensionUnavailableError,
  ProviderInstanceId,
  ThreadId,
  type ExtensionManifest,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import type * as Types from "effect/Types";
import * as TestClock from "effect/testing/TestClock";
import { McpProtocol, McpServer, type McpSchema } from "effect/unstable/ai";
import { NodeHttpServer } from "@effect/platform-node";
import {
  HttpBody,
  HttpClient,
  HttpRouter,
  HttpServerRequest,
  type HttpServerResponse,
} from "effect/unstable/http";

import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import {
  ExtensionMcp,
  EXTENSION_GUIDE_URI,
  EXTENSION_INSTALLED_URI,
  EXTENSION_MCP_INSTRUCTIONS,
  EXTENSION_SCAFFOLD_URI,
  addExtensionTool,
  extensionResourceDefinitions,
  installedResourceJson,
  make,
  toCallToolResult,
  toErrorResult,
  toolsLayer,
} from "./ExtensionMcp.ts";
import { EXTENSION_SUBJECT_PREFIX } from "./ExtensionIdentity.ts";
import * as ExtensionRegistry from "./ExtensionRegistry.ts";

const environmentId = EnvironmentId.make("environment-1");

const invocation: McpInvocationContext.McpInvocationScope = {
  environmentId,
  threadId: ThreadId.make("thread-1"),
  providerSessionId: "provider-session-1",
  providerInstanceId: ProviderInstanceId.make("claude"),
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
};

const manifest = {
  name: "bach",
  version: "1.0.0",
  protocolVersion: EXTENSION_PROTOCOL_VERSION,
  server: { entry: "dist/server.js" },
} satisfies ExtensionManifest;

const spawnTool = {
  name: "spawn_agent",
  description: "Spawn a Bach agent.",
  inputSchema: { type: "object" },
};

const makeRegistry = (options: { readonly reservedToolNames?: ReadonlyArray<string> } = {}) =>
  ExtensionRegistry.make({
    environmentId,
    hostVersion: "0.0.38",
    dataRoot: "/home/dev/.t3/userdata/extensions",
    ...options,
  }).pipe(Effect.provide(NodeServices.layer));

/** Register `bach`, complete its handshake, and register its tool. */
const withTool = Effect.fn("test.withTool")(function* (
  registry: ExtensionRegistry.ExtensionRegistryShape,
) {
  yield* registry.upsertSource({
    name: "bach",
    path: "/opt/bach",
    enabled: true,
    source: "settings",
  });
  yield* registry.hello({
    protocolVersion: EXTENSION_PROTOCOL_VERSION,
    manifest,
    name: "bach",
    subject: `${EXTENSION_SUBJECT_PREFIX}bach`,
  });
  // The supervisor marks an extension it is launching before it forks, so a
  // gate test has to model that too.
  yield* registry.setState({ name: "bach", state: "starting" });
  return yield* registry.registerTools({ name: "bach", tools: [spawnTool] });
});

/** Captures what would have been registered, so no transport is needed. */
const captureAddTool = (
  captured: Ref.Ref<
    ReadonlyArray<{
      readonly name: string;
      readonly handle: (payload: unknown) => Effect.Effect<McpSchema.CallToolResult, never, never>;
    }>
  >,
): McpServer.McpServer["Service"]["addTool"] =>
  ((options: {
    readonly tool: { readonly name: string };
    readonly handle: (payload: unknown) => Effect.Effect<McpSchema.CallToolResult, never, never>;
  }) =>
    Ref.update(captured, (current) => [
      ...current,
      { name: options.tool.name, handle: options.handle },
    ])) as unknown as McpServer.McpServer["Service"]["addTool"];

describe("brokered tool", () => {
  it.effect("passes the host-resolved caller through and maps the answer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* makeRegistry();
        yield* withTool(registry);
        const events = yield* registry.connect({ name: "bach" });
        yield* Stream.runForEach(events, (event) =>
          event.type === "invokeTool"
            ? registry.respondTool({
                connectionId: event.connectionId,
                invocationId: event.invocation.invocationId,
                content: [
                  { type: "text", text: JSON.stringify(event.invocation.caller) },
                  { type: "image", data: "aGk=", mimeType: "image/png" },
                ],
                structuredContent: { agentId: "a-1" },
              })
            : Effect.void,
        ).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;

        const captured = yield* Ref.make<
          ReadonlyArray<{
            readonly name: string;
            readonly handle: (
              payload: unknown,
            ) => Effect.Effect<McpSchema.CallToolResult, never, never>;
          }>
        >([]);
        yield* addExtensionTool({
          addTool: captureAddTool(captured),
          registry,
          extensionName: "bach",
          isToolVisible: () => true,
          name: "spawn_agent",
          description: spawnTool.description,
          inputSchema: spawnTool.inputSchema,
        });
        const [tool] = yield* Ref.get(captured);
        const result = yield* tool!
          .handle({ prompt: "ship it" })
          .pipe(Effect.provideService(McpInvocationContext.McpInvocationContext, invocation));

        expect(result.isError).toBeUndefined();
        expect(result.structuredContent).toStrictEqual({ agentId: "a-1" });
        const [text, image] = result.content;
        expect(text).toStrictEqual({
          type: "text",
          text: JSON.stringify({
            environmentId,
            threadId: invocation.threadId,
            providerSessionId: invocation.providerSessionId,
            providerInstanceId: invocation.providerInstanceId,
          }),
        });
        // MCP carries image bytes, not base64, so the mapper has to decode.
        expect(image).toMatchObject({ type: "image", mimeType: "image/png" });
      }),
    ),
  );

  it.effect("answers isError when the extension behind the tool is not running", () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry();
      yield* withTool(registry);
      const captured = yield* Ref.make<
        ReadonlyArray<{
          readonly name: string;
          readonly handle: (
            payload: unknown,
          ) => Effect.Effect<McpSchema.CallToolResult, never, never>;
        }>
      >([]);
      yield* addExtensionTool({
        addTool: captureAddTool(captured),
        registry,
        extensionName: "bach",
        isToolVisible: () => true,
        name: "spawn_agent",
        description: spawnTool.description,
        inputSchema: spawnTool.inputSchema,
      });
      const [tool] = yield* Ref.get(captured);
      const result = yield* tool!
        .handle({})
        .pipe(Effect.provideService(McpInvocationContext.McpInvocationContext, invocation));

      expect(result.isError).toBe(true);
      const [content] = result.content;
      expect(content).toMatchObject({ type: "text" });
      expect((content as { readonly text: string }).text).toContain("spawn_agent");
      // The tool stays in the catalogue: a provider cached it at connect, and
      // a tool that vanishes is invisible while one that errors is legible.
      expect((yield* registry.listTools).length).toBe(1);
    }),
  );
});

describe("result mapping", () => {
  it("keeps an extension's own isError result an error", () => {
    const mapped = toCallToolResult({
      connectionId: "c",
      invocationId: "i",
      isError: true,
      content: [{ type: "text", text: "the agent id was not found" }],
    });
    expect(mapped.isError).toBe(true);
    expect(mapped.content[0]).toStrictEqual({
      type: "text",
      text: "the agent id was not found",
    });
  });

  it("renders a brokering failure as the sentence the agent reads", () => {
    const result = toErrorResult(
      new ExtensionUnavailableError({
        extensionName: "bach",
        toolName: "spawn_agent",
        reason: "restarting",
      }),
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as { readonly text: string }).text).toBe(
      "The extension backing spawn_agent (bach) is restarting; try again shortly.",
    );
  });
});

describe("resources", () => {
  it.effect("publishes the guide, the scaffold, and the installed list", () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry();
      yield* withTool(registry);
      const definitions = extensionResourceDefinitions(registry);
      expect(definitions.map((entry) => entry.resource.uri)).toStrictEqual([
        EXTENSION_GUIDE_URI,
        EXTENSION_SCAFFOLD_URI,
        EXTENSION_INSTALLED_URI,
      ]);

      const guide = yield* definitions[0]!.handle;
      expect(guide.contents[0]).toMatchObject({
        uri: EXTENSION_GUIDE_URI,
        mimeType: "text/markdown",
      });
      expect((guide.contents[0] as { readonly text: string }).text).toContain("extensions.hello");

      const installed = yield* definitions[2]!.handle;
      const parsed = JSON.parse((installed.contents[0] as { readonly text: string }).text) as {
        readonly extensions: ReadonlyArray<Record<string, unknown>>;
      };
      expect(parsed.extensions[0]).toMatchObject({
        name: "bach",
        version: "1.0.0",
        path: "/opt/bach",
        tools: ["spawn_agent"],
      });
    }),
  );

  it("names every resource it tells agents to read", () => {
    for (const uri of [EXTENSION_GUIDE_URI, EXTENSION_SCAFFOLD_URI, EXTENSION_INSTALLED_URI]) {
      expect(EXTENSION_MCP_INSTRUCTIONS).toContain(uri);
    }
    // The one thing worth spending prompt budget on beyond the pointers.
    expect(EXTENSION_MCP_INSTRUCTIONS).toContain("not a harness fault");
  });

  it("reports an extension with no readable manifest without a version", () => {
    const json = installedResourceJson({
      extensions: [
        {
          name: "broken",
          path: "/opt/broken",
          source: "settings",
          enabled: true,
          state: "crashed",
          changed: false,
          tools: [],
          rejections: [],
          restartCount: 2,
          lastError: "no valid extension.json",
        },
      ],
    });
    expect(JSON.parse(json)).toStrictEqual({
      extensions: [
        {
          name: "broken",
          version: null,
          path: "/opt/broken",
          state: "crashed",
          enabled: true,
          changed: false,
          tools: [],
          lastError: "no valid extension.json",
        },
      ],
    });
  });
});

describe("the readiness gate", () => {
  const gate = (registry: ExtensionRegistry.ExtensionRegistryShape) =>
    make({ readyTimeout: Duration.seconds(10) }).pipe(
      Effect.provideService(ExtensionRegistry.ExtensionRegistry, registry),
    );

  it.effect("holds issuance until the extension connects, then syncs the catalogue", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* makeRegistry();
        const bridge = yield* gate(registry);
        const synced = yield* Ref.make(0);
        yield* bridge.installToolSync(Ref.update(synced, (count) => count + 1));

        yield* withTool(registry);
        yield* registry.markSourcesResolved;
        const waiting = yield* Effect.forkChild(
          bridge.prepareForSession({ threadId: invocation.threadId }),
        );
        yield* Effect.yieldNow;
        expect(yield* Ref.get(synced)).toBe(0);

        // Opening the stream is the readiness signal.
        const events = yield* registry.connect({ name: "bach" });
        yield* Stream.runForEach(events, () => Effect.void).pipe(Effect.forkScoped);
        yield* Fiber.await(waiting);
        expect(yield* Ref.get(synced)).toBe(1);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, TestClock.layer()))),
  );

  it.effect("gives up after the timeout so one silent extension cannot block a turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* makeRegistry();
        const bridge = yield* gate(registry);
        const synced = yield* Ref.make(0);
        yield* bridge.installToolSync(Ref.update(synced, (count) => count + 1));

        yield* withTool(registry);
        yield* registry.markSourcesResolved;
        const waiting = yield* Effect.forkChild(
          bridge.prepareForSession({ threadId: invocation.threadId }),
        );
        yield* Effect.yieldNow;
        expect(yield* Ref.get(synced)).toBe(0);

        yield* TestClock.adjust(Duration.seconds(10));
        yield* Fiber.await(waiting);
        // Released anyway, and the catalogue still gets whatever did register.
        expect(yield* Ref.get(synced)).toBe(1);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, TestClock.layer()))),
  );

  it.effect("does not wait on a crashed extension that will never connect", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* makeRegistry();
        const bridge = yield* gate(registry);
        yield* registry.upsertSource({
          name: "bach",
          path: "/opt/bach",
          enabled: true,
          source: "settings",
        });
        yield* registry.setState({ name: "bach", state: "crashed", lastError: "exit 1" });
        yield* registry.markSourcesResolved;
        // No clock movement: readiness resolves on state, not on a timeout.
        yield* bridge.prepareForSession({ threadId: invocation.threadId });
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, TestClock.layer()))),
  );
});

describe("host tool names", () => {
  it.effect("rejects an extension tool that shadows one of the host's own", () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry({ reservedToolNames: ["preview_open"] });
      yield* registry.upsertSource({
        name: "bach",
        path: "/opt/bach",
        enabled: true,
        source: "settings",
      });
      yield* registry.hello({
        protocolVersion: EXTENSION_PROTOCOL_VERSION,
        manifest,
        name: "bach",
        subject: `${EXTENSION_SUBJECT_PREFIX}bach`,
      });
      const result = yield* registry.registerTools({
        name: "bach",
        tools: [{ ...spawnTool, name: "preview_open" }, spawnTool],
      });
      expect(result.tools[0]).toMatchObject({ status: "rejected", reason: "name-collision" });
      expect((result.tools[0] as { readonly message: string }).message).toContain("T3 Code");
      expect(result.tools[1]).toStrictEqual({ status: "accepted", name: "spawn_agent" });
      expect((yield* registry.listTools).map((tool) => tool.definition.name)).toStrictEqual([
        "spawn_agent",
      ]);
    }),
  );
});

describe("per-thread tool visibility", () => {
  const leadThread = ThreadId.make("thread-lead");
  const builderThread = ThreadId.make("thread-builder");
  const reviewTool = { ...spawnTool, name: "review_task", description: "Team lead only." };

  /** `bach` with two tools, answering `toolsForThread` per thread. */
  const withFilteringExtension = Effect.fn("test.withFilteringExtension")(function* (
    registry: ExtensionRegistry.ExtensionRegistryShape,
    visible: (threadId: string) => ReadonlyArray<string>,
  ) {
    yield* registry.upsertSource({
      name: "bach",
      path: "/opt/bach",
      enabled: true,
      source: "settings",
    });
    yield* registry.hello({
      protocolVersion: EXTENSION_PROTOCOL_VERSION,
      manifest,
      name: "bach",
      subject: `${EXTENSION_SUBJECT_PREFIX}bach`,
    });
    yield* registry.registerTools({
      name: "bach",
      tools: [spawnTool, reviewTool],
      filterToolsPerThread: true,
    });
    const events = yield* registry.connect({ name: "bach" });
    yield* Stream.runForEach(events, (event) =>
      event.type === "toolsForThread"
        ? registry.respondToolsForThread({
            connectionId: event.connectionId,
            requestId: event.request.requestId,
            tools: visible(event.request.threadId),
          })
        : Effect.void,
    ).pipe(Effect.forkScoped);
    // The stream attaches when it is first run, so let the fork reach it
    // before anything asks the registry to push an event onto it.
    yield* Effect.yieldNow;
    yield* registry.markSourcesResolved;
  });

  const gate = (registry: ExtensionRegistry.ExtensionRegistryShape) =>
    make().pipe(Effect.provideService(ExtensionRegistry.ExtensionRegistry, registry));

  it.effect("answers the gate from what the extension said for that thread", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* makeRegistry();
        const bridge = yield* gate(registry);
        yield* withFilteringExtension(registry, (threadId) =>
          threadId === leadThread ? ["spawn_agent", "review_task"] : ["spawn_agent"],
        );

        yield* bridge.prepareForSession({ threadId: leadThread });
        yield* bridge.prepareForSession({ threadId: builderThread });

        const visible = (threadId: ThreadId, toolName: string) =>
          bridge.isToolVisible({ extensionName: "bach", toolName, threadId });
        expect(visible(leadThread, "review_task")).toBe(true);
        expect(visible(builderThread, "review_task")).toBe(false);
        expect(visible(builderThread, "spawn_agent")).toBe(true);
        // A thread the host never asked about keeps every tool: visibility is
        // not authorization, and an unasked thread must not lose its tools.
        expect(visible(ThreadId.make("thread-unknown"), "review_task")).toBe(true);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("leaves an extension that does not filter alone", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* makeRegistry();
        const bridge = yield* gate(registry);
        yield* withTool(registry);
        const events = yield* registry.connect({ name: "bach" });
        const asked = yield* Ref.make(0);
        yield* Stream.runForEach(events, (event) =>
          event.type === "toolsForThread" ? Ref.update(asked, (count) => count + 1) : Effect.void,
        ).pipe(Effect.forkScoped);
        yield* registry.markSourcesResolved;

        yield* bridge.prepareForSession({ threadId: builderThread });

        expect(yield* Ref.get(asked)).toBe(0);
        expect(
          bridge.isToolVisible({
            extensionName: "bach",
            toolName: "spawn_agent",
            threadId: builderThread,
          }),
        ).toBe(true);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("filters both tools/list and tools/call over the real MCP transport", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* makeRegistry();
        const bridge = yield* gate(registry);
        yield* withFilteringExtension(registry, (threadId) =>
          threadId === leadThread ? ["spawn_agent", "review_task"] : ["spawn_agent"],
        );

        // The transport's own middleware resolves a bearer token to a caller;
        // this one does the same from a fixed table, so the test exercises the
        // registration and the catalogue rather than the credential store.
        const authMiddleware = HttpRouter.middleware<{
          provides: McpInvocationContext.McpInvocationContext;
        }>()(
          Effect.succeed(
            (
              httpEffect: Effect.Effect<
                HttpServerResponse.HttpServerResponse,
                Types.unhandled,
                McpInvocationContext.McpInvocationContext
              >,
            ) =>
              Effect.gen(function* () {
                const request = yield* HttpServerRequest.HttpServerRequest;
                return yield* httpEffect.pipe(
                  Effect.provideService(McpInvocationContext.McpInvocationContext, {
                    ...invocation,
                    threadId: ThreadId.make(request.headers.authorization ?? "thread-unknown"),
                  }),
                );
              }),
          ),
        ).layer;

        yield* HttpRouter.serve(
          toolsLayer.pipe(
            Layer.provideMerge(
              McpServer.layerHttp({
                name: "T3 Code",
                version: "0.0.38",
                path: "/mcp",
                protocols: [McpProtocol.v2025_06_18],
              }).pipe(Layer.provide(authMiddleware)),
            ),
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(ExtensionRegistry.ExtensionRegistry, registry),
                Layer.succeed(ExtensionMcp, bridge),
              ),
            ),
          ),
          { disableListenLog: true, disableLogger: true },
        ).pipe(Layer.build);

        // Issuing a credential is what fills the catalogue and the thread's set.
        yield* bridge.prepareForSession({ threadId: leadThread });
        yield* bridge.prepareForSession({ threadId: builderThread });

        const httpClient = yield* HttpClient.HttpClient;
        const session = Effect.fn("test.session")(function* (threadId: ThreadId) {
          const initialize = yield* httpClient.post("/mcp", {
            headers: { accept: "application/json, text/event-stream", authorization: threadId },
            body: HttpBody.text(
              '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t3-test","version":"1.0.0"}}}',
              "application/json",
            ),
          });
          const sessionId = initialize.headers["mcp-session-id"] ?? "";
          const send = (body: string) =>
            httpClient
              .post("/mcp", {
                headers: {
                  accept: "application/json, text/event-stream",
                  authorization: threadId,
                  "mcp-session-id": sessionId,
                  "mcp-protocol-version": "2025-06-18",
                },
                body: HttpBody.text(body, "application/json"),
              })
              .pipe(Effect.flatMap((response) => response.text));
          yield* send('{"jsonrpc":"2.0","method":"notifications/initialized"}');
          return send;
        });

        const leadSend = yield* session(leadThread);
        const builderSend = yield* session(builderThread);
        const listed = '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}';
        const called =
          '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"review_task","arguments":{}}}';

        const leadTools = yield* leadSend(listed);
        const builderTools = yield* builderSend(listed);
        expect(leadTools).toContain("review_task");
        expect(leadTools).toContain("spawn_agent");
        expect(builderTools).not.toContain("review_task");
        expect(builderTools).toContain("spawn_agent");

        // A hidden tool is not merely absent from the list: calling it by name
        // is refused too, which is what stops an agent that cached the
        // catalogue before the filter changed.
        const builderCall = yield* builderSend(called);
        expect(builderCall).toContain("not found");
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeHttpServer.layerTest))),
  );
});
