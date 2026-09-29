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
  addExtensionResource,
  addExtensionTool,
  composeMcpInstructions,
  extensionResourceDefinitions,
  makeCatalogueSync,
  makeResourceSync,
  resourcesLayer,
  installedResourceJson,
  make,
  makeToolSync,
  toCallToolResult,
  toErrorResult,
  catalogueLayer,
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
        yield* bridge.installCatalogueSync(Ref.update(synced, (count) => count + 1));

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
        yield* bridge.installCatalogueSync(Ref.update(synced, (count) => count + 1));

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

describe("the catalogue after a redeploy", () => {
  const reviewTool = {
    name: "review_task",
    description: "Review a task.",
    inputSchema: { type: "object" },
  };

  /** Captures name and description, which is what a redeploy can move. */
  const captureAdds = (
    captured: Ref.Ref<ReadonlyArray<{ readonly name: string; readonly description: string }>>,
  ): McpServer.McpServer["Service"]["addTool"] =>
    ((options: { readonly tool: { readonly name: string; readonly description: string } }) =>
      Ref.update(captured, (current) => [
        ...current,
        { name: options.tool.name, description: options.tool.description },
      ])) as unknown as McpServer.McpServer["Service"]["addTool"];

  const gate = (registry: ExtensionRegistry.ExtensionRegistryShape) =>
    make().pipe(Effect.provideService(ExtensionRegistry.ExtensionRegistry, registry));

  /** `bach`, handshaken, with whatever tool set the caller passes. */
  const deploy = Effect.fn("test.deploy")(function* (
    registry: ExtensionRegistry.ExtensionRegistryShape,
    tools: ReadonlyArray<{
      readonly name: string;
      readonly description: string;
      readonly inputSchema: Readonly<Record<string, unknown>>;
    }>,
  ) {
    yield* registry.registerTools({ name: "bach", tools });
  });

  const handshake = Effect.fn("test.handshake")(function* (
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
  });

  it.effect("re-adds a tool whose description moved and leaves an unchanged one alone", () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry();
      const bridge = yield* gate(registry);
      yield* handshake(registry);
      yield* deploy(registry, [spawnTool, reviewTool]);
      const captured = yield* Ref.make<
        ReadonlyArray<{ readonly name: string; readonly description: string }>
      >([]);
      const sync = yield* makeToolSync({
        addTool: captureAdds(captured),
        registry,
        gate: bridge,
      });

      yield* sync;
      expect((yield* Ref.get(captured)).length).toBe(2);

      // An unchanged redeploy costs the catalogue nothing: re-adding would only
      // churn a `tools/list_changed` for an identical entry.
      yield* deploy(registry, [spawnTool, reviewTool]);
      yield* sync;
      expect((yield* Ref.get(captured)).length).toBe(2);

      // A schema that only reordered its keys is the same schema.
      yield* deploy(registry, [
        { ...spawnTool, inputSchema: { type: "object", properties: {} } },
        reviewTool,
      ]);
      yield* sync;
      expect((yield* Ref.get(captured)).length).toBe(3);
      yield* deploy(registry, [
        { ...spawnTool, inputSchema: { properties: {}, type: "object" } },
        reviewTool,
      ]);
      yield* sync;
      expect((yield* Ref.get(captured)).length).toBe(3);

      yield* deploy(registry, [
        {
          ...spawnTool,
          inputSchema: { type: "object", properties: {} },
          description: "Now with a room.",
        },
        reviewTool,
      ]);
      yield* sync;
      const adds = yield* Ref.get(captured);
      expect(adds.length).toBe(4);
      expect(adds.at(-1)).toStrictEqual({ name: "spawn_agent", description: "Now with a room." });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("retires a tool the thread's own remembered answer still names", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* makeRegistry();
        const bridge = yield* gate(registry);
        yield* handshake(registry);
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
                tools: ["spawn_agent", "review_task"],
              })
            : Effect.void,
        ).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        yield* registry.markSourcesResolved;
        const captured = yield* Ref.make<
          ReadonlyArray<{ readonly name: string; readonly description: string }>
        >([]);
        yield* bridge.installCatalogueSync(
          yield* makeToolSync({ addTool: captureAdds(captured), registry, gate: bridge }),
        );

        // The extension said this thread may see both, and that answer is
        // remembered for the life of the session.
        yield* bridge.prepareForSession({ threadId: invocation.threadId });
        const visible = (toolName: string) =>
          bridge.isToolVisible({
            extensionName: "bach",
            toolName,
            threadId: invocation.threadId,
          });
        expect(visible("review_task")).toBe(true);

        // A later sync drops it. The remembered answer still names it, so the
        // live set has to be consulted first or the thread keeps a tool nobody
        // registers any more.
        yield* registry.registerTools({
          name: "bach",
          tools: [spawnTool],
          filterToolsPerThread: true,
        });
        yield* bridge.prepareForSession({ threadId: ThreadId.make("thread-other") });

        expect(visible("review_task")).toBe(false);
        expect(visible("spawn_agent")).toBe(true);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("retires a tool the extension stopped registering, and only that one", () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry();
      const bridge = yield* gate(registry);
      yield* handshake(registry);
      yield* deploy(registry, [spawnTool, reviewTool]);
      const captured = yield* Ref.make<
        ReadonlyArray<{ readonly name: string; readonly description: string }>
      >([]);
      const sync = yield* makeToolSync({
        addTool: captureAdds(captured),
        registry,
        gate: bridge,
      });
      const visible = (toolName: string) =>
        bridge.isToolVisible({
          extensionName: "bach",
          toolName,
          threadId: invocation.threadId,
        });

      // Nothing is retired before the first sync: not knowing yet must not
      // take a tool away.
      expect(visible("review_task")).toBe(true);
      yield* sync;
      expect(visible("review_task")).toBe(true);

      yield* deploy(registry, [spawnTool]);
      yield* sync;
      expect(visible("review_task")).toBe(false);
      expect(visible("spawn_agent")).toBe(true);
      // Retirement is visibility, not removal: the entry is still in the MCP
      // server, so nothing was re-added for the tool that stayed.
      expect((yield* Ref.get(captured)).length).toBe(2);

      // A tool that comes back is not retired any more, and needs no re-add.
      yield* deploy(registry, [spawnTool, reviewTool]);
      yield* sync;
      expect(visible("review_task")).toBe(true);
      expect((yield* Ref.get(captured)).length).toBe(2);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("does not retire the tools of an extension that merely stopped", () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry();
      const bridge = yield* gate(registry);
      yield* handshake(registry);
      yield* deploy(registry, [spawnTool]);
      const captured = yield* Ref.make<
        ReadonlyArray<{ readonly name: string; readonly description: string }>
      >([]);
      const sync = yield* makeToolSync({
        addTool: captureAdds(captured),
        registry,
        gate: bridge,
      });
      yield* sync;

      yield* registry.setState({ name: "bach", state: "stopped" });
      yield* registry.setEnabled({ name: "bach", enabled: false });
      yield* sync;

      // Availability is a result, not a catalogue entry: the tool stays listed
      // and answers `ExtensionUnavailableError`.
      expect(
        bridge.isToolVisible({
          extensionName: "bach",
          toolName: "spawn_agent",
          threadId: invocation.threadId,
        }),
      ).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps two extensions from retiring each other's tools", () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry();
      const bridge = yield* gate(registry);
      yield* handshake(registry);
      yield* deploy(registry, [spawnTool]);
      yield* registry.upsertSource({
        name: "notes",
        path: "/opt/notes",
        enabled: true,
        source: "settings",
      });
      yield* registry.hello({
        protocolVersion: EXTENSION_PROTOCOL_VERSION,
        manifest: { ...manifest, name: "notes" },
        name: "notes",
        subject: `${EXTENSION_SUBJECT_PREFIX}notes`,
      });
      yield* registry.registerTools({ name: "notes", tools: [reviewTool] });
      const captured = yield* Ref.make<
        ReadonlyArray<{ readonly name: string; readonly description: string }>
      >([]);
      const sync = yield* makeToolSync({
        addTool: captureAdds(captured),
        registry,
        gate: bridge,
      });
      yield* sync;

      yield* deploy(registry, []);
      yield* sync;

      const visible = (extensionName: string, toolName: string) =>
        bridge.isToolVisible({
          extensionName,
          toolName,
          threadId: invocation.threadId,
        });
      expect(visible("bach", "spawn_agent")).toBe(false);
      expect(visible("notes", "review_task")).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("shows the next agent the redeployed catalogue over the real transport", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* makeRegistry();
        const bridge = yield* make().pipe(
          Effect.provideService(ExtensionRegistry.ExtensionRegistry, registry),
        );
        yield* handshake(registry);
        yield* deploy(registry, [spawnTool, reviewTool]);
        const events = yield* registry.connect({ name: "bach" });
        yield* Stream.runForEach(events, () => Effect.void).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        yield* registry.markSourcesResolved;

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
          catalogueLayer.pipe(
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
        const listed = '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}';
        const callReview =
          '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"review_task","arguments":{}}}';

        const firstThread = ThreadId.make("thread-before");
        yield* bridge.prepareForSession({ threadId: firstThread });
        const firstSend = yield* session(firstThread);
        const before = yield* firstSend(listed);
        expect(before).toContain("Review a task.");
        expect(before).toContain("spawn_agent");

        // The Deploy: one tool's description moved, the other was dropped.
        yield* deploy(registry, [
          { ...spawnTool, description: "Spawn a Bach agent, with a role." },
        ]);

        const nextThread = ThreadId.make("thread-after");
        yield* bridge.prepareForSession({ threadId: nextThread });
        const nextSend = yield* session(nextThread);
        const after = yield* nextSend(listed);
        expect(after).toContain("Spawn a Bach agent, with a role.");
        expect(after).not.toContain("Spawn a Bach agent.");
        expect(after).not.toContain("review_task");

        // The retired tool is still refused legibly rather than silently
        // answering with a stale result.
        expect(yield* nextSend(callReview)).toContain("not found");

        // And refused for the thread prepared *before* the retirement, which is
        // the agent actually holding the name. Its remembered set was recorded
        // while the tool was still registered — here it is the unrestricted
        // answer, so nothing but the retirement refuses the call, and for a
        // filtering extension it would be an answer that named the tool. Either
        // way the live set is consulted first, which is what stops a session
        // that predates the Deploy from keeping a tool nobody registers.
        expect(yield* firstSend(callReview)).toContain("not found");
        expect(yield* firstSend(listed)).not.toContain("review_task");
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeHttpServer.layerTest))),
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
          catalogueLayer.pipe(
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

describe("server instructions", () => {
  const section = (extensionName: string, instructions: string) => ({
    extensionName: extensionName as never,
    instructions,
  });

  it("puts the host's own paragraph first and each extension under its name", () => {
    const composed = composeMcpInstructions([
      section("bach", "Bach runs the fleet."),
      section("notes", "Notes keeps the notebook."),
    ]);
    expect(composed.startsWith(EXTENSION_MCP_INSTRUCTIONS)).toBe(true);
    expect(composed).toContain("## bach\nBach runs the fleet.");
    expect(composed).toContain("## notes\nNotes keeps the notebook.");
    // Start order, so the string an agent reads does not shuffle between runs.
    expect(composed.indexOf("## bach")).toBeLessThan(composed.indexOf("## notes"));
  });

  it("drops whole sections under the budget rather than letting a client cut one", () => {
    const composed = composeMcpInstructions(
      [section("bach", "a".repeat(200)), section("notes", "b".repeat(200))],
      { host: "host.", budget: 340 },
    );
    expect(composed.length).toBeLessThanOrEqual(340);
    expect(composed).toContain("## bach");
    // Named rather than silently missing: an agent that knows can ask.
    expect(composed).toContain("Instructions from notes did not fit");
    expect(composed).not.toContain("bbbb");
  });

  it("keeps the host's own paragraph even when nothing else fits", () => {
    const composed = composeMcpInstructions([section("bach", "a".repeat(400))], {
      host: "host.",
      budget: 150,
    });
    expect(composed.length).toBeLessThanOrEqual(150);
    expect(composed.startsWith("host.")).toBe(true);
    expect(composed).toContain("Instructions from bach did not fit");
  });

  it("holds the budget when the notice itself is what would overrun it", () => {
    const many = Array.from({ length: 40 }, (_, index) =>
      section(`extension-with-a-long-name-${index}`, "a".repeat(100)),
    );
    const budget = 200;

    // Too many names to list: the notice counts them instead.
    const counted = composeMcpInstructions(many, { host: "host.", budget });
    expect(counted.length).toBeLessThanOrEqual(budget);
    expect(counted).toContain("Instructions from 40 more extensions did not fit");

    // Not even a counting notice fits: the host's paragraph goes alone.
    const bare = composeMcpInstructions(many, { host: "host.", budget: 20 });
    expect(bare).toBe("host.");

    // A host paragraph over the budget by itself is the one thing that is cut.
    const cut = composeMcpInstructions(many, { host: "h".repeat(30), budget: 20 });
    expect(cut).toBe("h".repeat(20));
  });

  it("counts rather than names when naming would cost a section that otherwise fits", () => {
    const composed = composeMcpInstructions(
      [
        section("bach", "a".repeat(50)),
        ...Array.from({ length: 10 }, (_, index) =>
          section(`extension-with-a-long-name-${index}`, "b".repeat(400)),
        ),
      ],
      { host: "host.", budget: 250 },
    );
    expect(composed.length).toBeLessThanOrEqual(250);
    expect(composed).toContain("## bach");
    expect(composed).toContain("Instructions from 10 more extensions did not fit");
  });
});

describe("the catalogue sync", () => {
  const notesResource = {
    uri: "bach://notes",
    name: "bach-notes",
    description: "Everything Bach knows about the running fleet.",
    mimeType: "application/json",
  };

  /** Captures URI and description, which is what a redeploy can move. */
  const captureAddResource = (
    captured: Ref.Ref<ReadonlyArray<{ readonly uri: string; readonly description: string }>>,
  ): McpServer.McpServer["Service"]["addResource"] =>
    ((options: { readonly resource: { readonly uri: string; readonly description: string } }) =>
      Ref.update(captured, (current) => [
        ...current,
        { uri: options.resource.uri, description: options.resource.description },
      ])) as unknown as McpServer.McpServer["Service"]["addResource"];

  const gate = (registry: ExtensionRegistry.ExtensionRegistryShape) =>
    make().pipe(Effect.provideService(ExtensionRegistry.ExtensionRegistry, registry));

  it.effect("adds a resource once and re-adds it when its description moves", () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry();
      yield* withTool(registry);
      const captured = yield* Ref.make<
        ReadonlyArray<{ readonly uri: string; readonly description: string }>
      >([]);
      const sync = yield* makeResourceSync({
        addResource: captureAddResource(captured),
        registry,
      });

      yield* registry.registerResources({ name: "bach", resources: [notesResource] });
      yield* sync;
      expect(yield* Ref.get(captured)).toMatchObject([{ uri: "bach://notes" }]);

      // An unchanged redeploy costs the catalogue nothing.
      yield* registry.registerResources({ name: "bach", resources: [notesResource] });
      yield* sync;
      expect((yield* Ref.get(captured)).length).toBe(1);

      yield* registry.registerResources({
        name: "bach",
        resources: [{ ...notesResource, description: "Now with fewer words." }],
      });
      yield* sync;
      expect((yield* Ref.get(captured)).length).toBe(2);
    }),
  );

  it.effect("composes the instructions from whatever is connected at sync time", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* makeRegistry();
        const bridge = yield* gate(registry);
        yield* withTool(registry);
        const captured = yield* Ref.make<
          ReadonlyArray<{ readonly name: string; readonly handle: unknown }>
        >([]);
        const resources = yield* Ref.make<
          ReadonlyArray<{ readonly uri: string; readonly description: string }>
        >([]);
        const sync = yield* makeCatalogueSync({
          addTool: captureAddTool(captured as never),
          addResource: captureAddResource(resources),
          registry,
          gate: bridge,
        });

        // Before the extension connects there is nothing to say about it.
        yield* registry.registerTools({
          name: "bach",
          tools: [spawnTool],
          instructions: "Spawn agents through Bach, never by hand.",
        });
        yield* sync;
        expect(bridge.mcpInstructions()).toBe(EXTENSION_MCP_INSTRUCTIONS);

        yield* Stream.runForEach(yield* registry.connect({ name: "bach" }), () => Effect.void).pipe(
          Effect.forkScoped,
        );
        yield* Effect.yieldNow;
        yield* sync;
        expect(bridge.mcpInstructions()).toContain("## bach");
        expect(bridge.mcpInstructions()).toContain("never by hand");
      }),
    ),
  );
});

describe("reading an extension resource", () => {
  const notesResource = {
    uri: "bach://notes",
    name: "bach-notes",
    description: "Everything Bach knows about the running fleet.",
    mimeType: "application/json",
  };

  /** Captures the handler MCP would call on `resources/read`. */
  const captureHandler = (
    captured: Ref.Ref<
      Effect.Effect<McpSchema.ReadResourceResult, McpSchema.InternalError, never> | undefined
    >,
  ): McpServer.McpServer["Service"]["addResource"] =>
    ((options: {
      readonly handle: Effect.Effect<McpSchema.ReadResourceResult, McpSchema.InternalError, never>;
    }) =>
      Ref.set(
        captured,
        options.handle,
      )) as unknown as McpServer.McpServer["Service"]["addResource"];

  it.effect("answers with the extension's own contents", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* makeRegistry();
        yield* withTool(registry);
        yield* registry.registerResources({ name: "bach", resources: [notesResource] });
        const captured = yield* Ref.make<
          Effect.Effect<McpSchema.ReadResourceResult, McpSchema.InternalError, never> | undefined
        >(undefined);
        yield* addExtensionResource({
          addResource: captureHandler(captured),
          registry,
          definition: notesResource,
        });

        const events = yield* registry.connect({ name: "bach" });
        yield* Stream.runForEach(events, (event) =>
          event.type === "readResource"
            ? registry.respondReadResource({
                connectionId: event.connectionId,
                requestId: event.request.requestId,
                contents: [{ type: "text", uri: event.request.uri, text: '{"agents":2}' }],
              })
            : Effect.void,
        ).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;

        const handle = yield* Ref.get(captured);
        const result = yield* handle!;
        expect(result.contents[0]).toMatchObject({
          uri: "bach://notes",
          text: '{"agents":2}',
        });
      }),
    ),
  );

  it.effect("turns an unreachable extension into an MCP error, not empty contents", () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry();
      yield* withTool(registry);
      yield* registry.registerResources({ name: "bach", resources: [notesResource] });
      const captured = yield* Ref.make<
        Effect.Effect<McpSchema.ReadResourceResult, McpSchema.InternalError, never> | undefined
      >(undefined);
      yield* addExtensionResource({
        addResource: captureHandler(captured),
        registry,
        definition: notesResource,
      });

      const handle = yield* Ref.get(captured);
      const error = yield* handle!.pipe(Effect.flip);
      expect(error._tag).toBe("InternalError");
      // `resources/read` has no error-result shape, so the sentence has to
      // travel as the protocol error's message.
      expect(error.message).toContain("bach://notes");
    }),
  );
});

describe("over the real transport", () => {
  const notesResource = {
    uri: "bach://notes",
    name: "bach-notes",
    description: "Everything Bach knows about the running fleet.",
    mimeType: "application/json",
  };

  it.effect("publishes the extension's instructions and serves its resource", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* makeRegistry();
        const bridge = yield* make().pipe(
          Effect.provideService(ExtensionRegistry.ExtensionRegistry, registry),
        );
        yield* withTool(registry);
        yield* registry.registerTools({
          name: "bach",
          tools: [spawnTool],
          instructions: "Spawn agents through Bach, never by hand.",
        });
        yield* registry.registerResources({ name: "bach", resources: [notesResource] });
        const events = yield* registry.connect({ name: "bach" });
        yield* Stream.runForEach(events, (event) =>
          event.type === "readResource"
            ? registry.respondReadResource({
                connectionId: event.connectionId,
                requestId: event.request.requestId,
                contents: [{ type: "text", uri: event.request.uri, text: '{"agents":2}' }],
              })
            : Effect.void,
        ).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        yield* registry.markSourcesResolved;

        yield* HttpRouter.serve(
          Layer.mergeAll(catalogueLayer, resourcesLayer).pipe(
            Layer.provideMerge(
              McpServer.layerHttp({
                name: "T3 Code",
                version: "0.0.38",
                path: "/mcp",
                protocols: [McpProtocol.v2025_06_18],
                // The same getter `McpHttpServer` installs: MCP reads it while
                // answering `initialize`, so the value is whatever the
                // catalogue sync composed for this session.
                get instructions() {
                  return bridge.mcpInstructions();
                },
              }),
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

        yield* bridge.prepareForSession({ threadId: invocation.threadId });

        const httpClient = yield* HttpClient.HttpClient;
        const initialize = yield* httpClient.post("/mcp", {
          headers: { accept: "application/json, text/event-stream" },
          body: HttpBody.text(
            '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t3-test","version":"1.0.0"}}}',
            "application/json",
          ),
        });
        const sessionId = initialize.headers["mcp-session-id"] ?? "";
        const initialized = yield* initialize.text;
        expect(initialized).toContain("## bach");
        expect(initialized).toContain("never by hand");

        const send = (body: string) =>
          httpClient
            .post("/mcp", {
              headers: {
                accept: "application/json, text/event-stream",
                "mcp-session-id": sessionId,
                "mcp-protocol-version": "2025-06-18",
              },
              body: HttpBody.text(body, "application/json"),
            })
            .pipe(Effect.flatMap((response) => response.text));
        yield* send('{"jsonrpc":"2.0","method":"notifications/initialized"}');

        // Listed beside the host's own three, and read through to the extension.
        const listed = yield* send(
          '{"jsonrpc":"2.0","id":2,"method":"resources/list","params":{}}',
        );
        expect(listed).toContain("bach://notes");
        expect(listed).toContain(EXTENSION_GUIDE_URI);

        const read = yield* send(
          '{"jsonrpc":"2.0","id":3,"method":"resources/read","params":{"uri":"bach://notes"}}',
        );
        expect(read).toContain('{\\"agents\\":2}');
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeHttpServer.layerTest))),
  );
});
