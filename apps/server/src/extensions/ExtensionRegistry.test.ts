// @effect-diagnostics preferSchemaOverJson:off - the fixture echoes the caller back as a JSON string.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  EXTENSION_PROTOCOL_VERSION,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type ExtensionManifest,
  type ExtensionStreamEvent,
  type ExtensionToolCaller,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";

import { EXTENSION_SUBJECT_PREFIX } from "./ExtensionIdentity.ts";
import { make, type ExtensionRegistryShape } from "./ExtensionRegistry.ts";

const manifest = {
  name: "bach",
  version: "1.0.0",
  protocolVersion: EXTENSION_PROTOCOL_VERSION,
  server: { entry: "dist/server.js" },
} satisfies ExtensionManifest;

const caller: ExtensionToolCaller = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
  providerSessionId: "provider-session-1",
  providerInstanceId: ProviderInstanceId.make("claude"),
};

const spawnTool = {
  name: "spawn_agent",
  description: "Spawn a Bach agent.",
  inputSchema: { type: "object" },
};

const makeRegistry = (options: { readonly callTimeoutMs?: number } = {}) =>
  make({
    environmentId: caller.environmentId,
    hostVersion: "0.0.38",
    dataRoot: "/home/dev/.t3/userdata/extensions",
    ...options,
  }).pipe(Effect.provide(NodeServices.layer));

type Registry = ExtensionRegistryShape;

/** Register `bach` as a known source and complete its handshake. */
const withHandshake = Effect.fn("test.withHandshake")(function* (registry: Registry) {
  yield* registry.upsertSource({
    name: "bach",
    path: "/opt/bach",
    enabled: true,
    source: "settings",
  });
  return yield* registry.hello({
    protocolVersion: EXTENSION_PROTOCOL_VERSION,
    manifest,
    name: "bach",
    subject: `${EXTENSION_SUBJECT_PREFIX}bach`,
  });
});

/** The stream, with `attached` peeled off and its connection id captured. */
const attach = (
  events: Stream.Stream<ExtensionStreamEvent>,
  onAttached: (connectionId: string) => void,
): Stream.Stream<Exclude<ExtensionStreamEvent, { readonly type: "attached" }>> =>
  events.pipe(
    Stream.filterMap((event) => {
      if (event.type === "attached") {
        onAttached(event.connectionId);
        return Result.failVoid;
      }
      return Result.succeed(event);
    }),
  );

describe("handshake", () => {
  it.effect("answers hello with the host's facts and the extension's own paths", () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry();
      const ack = yield* withHandshake(registry);
      expect(ack.protocolVersion).toBe(EXTENSION_PROTOCOL_VERSION);
      expect(ack.hostVersion).toBe("0.0.38");
      expect(ack.extensionPath).toBe("/opt/bach");
      expect(ack.dataDirectory).toBe("/home/dev/.t3/userdata/extensions/bach");
    }),
  );

  it.effect("rejects a protocol version this host does not speak", () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry();
      yield* registry.upsertSource({
        name: "bach",
        path: "/opt/bach",
        enabled: true,
        source: "settings",
      });
      const error = yield* registry
        .hello({
          protocolVersion: EXTENSION_PROTOCOL_VERSION + 1,
          manifest: { ...manifest, protocolVersion: EXTENSION_PROTOCOL_VERSION + 1 },
          name: "bach",
        })
        .pipe(Effect.flip);
      expect(error._tag).toBe("ExtensionProtocolMismatchError");
    }),
  );

  it.effect("refuses an extension that introduces itself as another installation", () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry();
      yield* registry.upsertSource({
        name: "bach",
        path: "/opt/bach",
        enabled: true,
        source: "settings",
      });
      // Spawned as `bach`, but the manifest in the folder says `notes`. The
      // host's name is authoritative, so this is refused rather than silently
      // relabelled.
      const error = yield* registry
        .hello({
          protocolVersion: EXTENSION_PROTOCOL_VERSION,
          manifest: { ...manifest, name: "notes" },
          name: "bach",
          subject: `${EXTENSION_SUBJECT_PREFIX}bach`,
        })
        .pipe(Effect.flip);
      expect(error._tag).toBe("ExtensionNotFoundError");
    }),
  );

  it.effect("refuses a token minted for a different extension", () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry();
      yield* registry.upsertSource({
        name: "bach",
        path: "/opt/bach",
        enabled: true,
        source: "settings",
      });
      const error = yield* registry
        .hello({
          protocolVersion: EXTENSION_PROTOCOL_VERSION,
          manifest,
          name: "bach",
          subject: `${EXTENSION_SUBJECT_PREFIX}notes`,
        })
        .pipe(Effect.flip);
      expect(error._tag).toBe("ExtensionNotFoundError");
    }),
  );

  it.effect("refuses to register anything before hello", () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry();
      yield* registry.upsertSource({
        name: "bach",
        path: "/opt/bach",
        enabled: true,
        source: "settings",
      });
      const error = yield* registry
        .registerTools({ name: "bach", tools: [spawnTool] })
        .pipe(Effect.flip);
      expect(error._tag).toBe("ExtensionHandshakeRequiredError");
    }),
  );
});

describe("registration", () => {
  it.effect("accepts a tool set and reports it to MCP in start order", () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry();
      yield* withHandshake(registry);
      const result = yield* registry.registerTools({ name: "bach", tools: [spawnTool] });
      expect(result.tools).toStrictEqual([{ status: "accepted", name: "spawn_agent" }]);
      expect((yield* registry.listTools).map((tool) => tool.definition.name)).toStrictEqual([
        "spawn_agent",
      ]);
    }),
  );

  it.effect("rejects a name another extension already owns, and keeps the rest", () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry();
      yield* withHandshake(registry);
      yield* registry.registerTools({ name: "bach", tools: [spawnTool] });
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
      });
      const result = yield* registry.registerTools({
        name: "notes",
        tools: [spawnTool, { ...spawnTool, name: "take_note" }],
      });
      expect(result.tools[0]).toMatchObject({ status: "rejected", reason: "name-collision" });
      expect(result.tools[0]).toHaveProperty("message", expect.stringContaining("bach"));
      expect(result.tools[1]).toStrictEqual({ status: "accepted", name: "take_note" });
    }),
  );

  it.effect("re-registering replaces the previous set, so a redeploy can drop a tool", () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry();
      yield* withHandshake(registry);
      yield* registry.registerTools({
        name: "bach",
        tools: [spawnTool, { ...spawnTool, name: "old_tool" }],
      });
      yield* registry.registerTools({ name: "bach", tools: [spawnTool] });
      expect((yield* registry.listTools).map((tool) => tool.definition.name)).toStrictEqual([
        "spawn_agent",
      ]);
    }),
  );

  it.effect("refuses a prefix the host reserves and one another extension took", () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry();
      yield* withHandshake(registry);
      const reserved = yield* registry
        .registerHttpPrefix({ name: "bach", prefix: "api" })
        .pipe(Effect.flip);
      expect(reserved._tag).toBe("ExtensionHttpPrefixCollisionError");
      const mounted = yield* registry.registerHttpPrefix({ name: "bach", prefix: "bach-api" });
      expect(mounted.basePath).toBe(`/ext-api/${caller.environmentId}/bach-api`);

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
      });
      const taken = yield* registry
        .registerHttpPrefix({ name: "notes", prefix: "bach-api" })
        .pipe(Effect.flip);
      expect(taken).toMatchObject({ prefix: "bach-api", owner: "bach" });
    }),
  );
});

describe("brokered calls", () => {
  it.effect("carries the caller's identity through and correlates the answer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* makeRegistry();
        yield* withHandshake(registry);
        yield* registry.registerTools({ name: "bach", tools: [spawnTool] });
        let connectionId = "";
        const events = attach(
          yield* registry.connect({ name: "bach" }),
          (id) => (connectionId = id),
        );
        yield* Stream.runForEach(events, (event) =>
          event.type === "invokeTool"
            ? registry.respondTool({
                connectionId: event.connectionId,
                invocationId: event.invocation.invocationId,
                content: [{ type: "text", text: JSON.stringify(event.invocation.caller) }],
              })
            : Effect.void,
        ).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;

        const result = yield* registry.invokeTool({
          name: "spawn_agent",
          arguments: { prompt: "ship it" },
          caller,
        });
        expect(connectionId).not.toBe("");
        expect(result.content[0]).toStrictEqual({
          type: "text",
          text: JSON.stringify(caller),
        });
      }),
    ),
  );

  it.effect("tells the agent the extension is not running rather than hiding the tool", () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry();
      yield* withHandshake(registry);
      yield* registry.registerTools({ name: "bach", tools: [spawnTool] });
      const error = yield* registry
        .invokeTool({ name: "spawn_agent", arguments: {}, caller })
        .pipe(Effect.flip);
      expect(error._tag).toBe("ExtensionUnavailableError");
      expect(error.message).toContain("spawn_agent");
      // The tool is still in the catalogue: an MCP client cached it at connect
      // and a tool that vanishes is invisible, while one that errors is not.
      expect((yield* registry.listTools).length).toBe(1);
    }),
  );

  it.effect("reports an unknown tool separately from an unavailable one", () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry();
      const error = yield* registry
        .invokeTool({ name: "nothing_here", arguments: {}, caller })
        .pipe(Effect.flip);
      expect(error._tag).toBe("ExtensionUnknownToolError");
    }),
  );

  it.effect("fails an in-flight call when the extension reconnects under it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* makeRegistry();
        yield* withHandshake(registry);
        yield* registry.registerTools({ name: "bach", tools: [spawnTool] });
        const first = yield* registry.connect({ name: "bach" });
        yield* Stream.runForEach(first, () => Effect.void).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;

        const call = yield* Effect.forkChild(
          registry.invokeTool({ name: "spawn_agent", arguments: {}, caller }),
        );
        yield* Effect.yieldNow;
        // A restarted extension opens a new stream. Acquisition happens when
        // the stream is consumed, which is what the RPC layer does, so the
        // test has to consume it too.
        const second = yield* registry.connect({ name: "bach" });
        yield* Stream.runForEach(second, () => Effect.void).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        const exit = yield* Fiber.await(call);
        expect(exit._tag).toBe("Failure");
      }),
    ),
  );

  it.effect("ignores an answer that quotes a stale connection", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* makeRegistry();
        yield* withHandshake(registry);
        yield* registry.registerTools({ name: "bach", tools: [spawnTool] });
        const events = attach(yield* registry.connect({ name: "bach" }), () => {});
        // A dead process answers first, quoting the connection it had. The
        // live one answers after; only the second may settle the call.
        yield* Stream.runForEach(events, (event) =>
          event.type === "invokeTool"
            ? registry
                .respondTool({
                  connectionId: "connection-from-a-dead-process",
                  invocationId: event.invocation.invocationId,
                  content: [{ type: "text", text: "stale" }],
                })
                .pipe(
                  Effect.andThen(
                    registry.respondTool({
                      connectionId: event.connectionId,
                      invocationId: event.invocation.invocationId,
                      content: [{ type: "text", text: "live" }],
                    }),
                  ),
                )
            : Effect.void,
        ).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;

        const result = yield* registry.invokeTool({
          name: "spawn_agent",
          arguments: {},
          caller,
        });
        expect(result.content[0]).toStrictEqual({ type: "text", text: "live" });
      }),
    ),
  );
});
describe("status and logs", () => {
  it.effect("flags a folder that changed under a running process", () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry();
      yield* withHandshake(registry);
      yield* registry.setState({ name: "bach", state: "running", runningHash: "aaaa" });
      expect((yield* registry.get("bach")).changed).toBe(false);
      yield* registry.setFolderHash({ name: "bach", folderHash: "bbbb" });
      const status = yield* registry.get("bach");
      expect(status.changed).toBe(true);
      expect(status.state).toBe("running");
    }),
  );

  it.effect("clears the badge when the extension stops, so the nav cannot lie", () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry();
      yield* withHandshake(registry);
      yield* registry.setBadge({ name: "bach", badge: { kind: "count", count: 3 } });
      expect((yield* registry.get("bach")).badge).toStrictEqual({ kind: "count", count: 3 });
      yield* registry.setState({ name: "bach", state: "crashed", lastError: "exit 1" });
      const status = yield* registry.get("bach");
      expect(status.badge).toBeUndefined();
      expect(status.lastError).toBe("exit 1");
    }),
  );

  it.effect("keeps only the most recent log lines", () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry();
      yield* withHandshake(registry);
      yield* Effect.forEach(
        Array.from({ length: 520 }, (_unused, index) => index),
        (index) => registry.appendLog({ name: "bach", stream: "stdout", line: `line ${index}` }),
        { discard: true },
      );
      const all = yield* registry.logs({ name: "bach" });
      expect(all.entries.length).toBe(500);
      expect(all.entries[0]?.line).toBe("line 20");
      const tail = yield* registry.logs({ name: "bach", limit: 2 });
      expect(tail.entries.map((entry) => entry.line)).toStrictEqual(["line 518", "line 519"]);
    }),
  );

  it.effect("reports a disabled extension as disabled and leaves it listed", () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry();
      yield* withHandshake(registry);
      yield* registry.setEnabled({ name: "bach", enabled: false });
      const { extensions } = yield* registry.list;
      expect(extensions).toHaveLength(1);
      expect(extensions[0]).toMatchObject({ name: "bach", enabled: false, state: "disabled" });
    }),
  );
});

describe("ExtensionRegistry.changes", () => {
  it.effect("opens with the current list and re-emits only when the list moves", () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry();
      yield* registry.upsertSource({
        name: "bach",
        path: "/opt/bach",
        enabled: true,
        source: "settings",
      });

      // Subscribing before any write, and taking one emission per write, is what
      // makes this deterministic: a suppressed emission is visible as the next
      // take returning the *following* change rather than a repeat.
      const queue = yield* Stream.toQueue(registry.changes, { capacity: "unbounded" });
      const opening = yield* Queue.take(queue);
      // The stream opens with the list as it already was, so a subscriber never
      // has to `list` before subscribing.
      expect(opening.extensions[0]?.state).toBe("stopped");
      expect(opening.extensions[0]?.version).toBeUndefined();

      yield* registry.hello({
        protocolVersion: EXTENSION_PROTOCOL_VERSION,
        manifest,
        name: "bach",
        subject: `${EXTENSION_SUBJECT_PREFIX}bach`,
      });
      expect((yield* Queue.take(queue)).extensions[0]?.version).toBe("1.0.0");

      yield* registry.setBadge({
        badge: { kind: "count", count: 2 },
        name: "bach",
        subject: `${EXTENSION_SUBJECT_PREFIX}bach`,
      });
      expect((yield* Queue.take(queue)).extensions[0]?.badge).toEqual({ kind: "count", count: 2 });

      // Re-sending the same badge is a write that leaves the list identical.
      // Registration is idempotent by design, so this happens on every
      // reconnect and must not wake every connected client.
      yield* registry.setBadge({
        badge: { kind: "count", count: 2 },
        name: "bach",
        subject: `${EXTENSION_SUBJECT_PREFIX}bach`,
      });
      yield* registry.setState({ name: "bach", state: "running" });
      const next = yield* Queue.take(queue);
      expect(next.extensions[0]?.state).toBe("running");
    }).pipe(Effect.scoped),
  );
});

describe("ExtensionRegistry rejections", () => {
  it.effect("keeps the refusals it answered with on the status, and replaces them", () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry();
      yield* withHandshake(registry);
      yield* registry.registerTools({ name: "bach", tools: [spawnTool] });
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
      });

      yield* registry.registerTools({
        name: "notes",
        tools: [spawnTool, { ...spawnTool, name: "take_note" }],
      });
      const collided = yield* registry.get("notes");
      expect(collided.tools).toStrictEqual(["take_note"]);
      expect(collided.rejections).toHaveLength(1);
      expect(collided.rejections[0]).toMatchObject({ kind: "tool", subject: "spawn_agent" });
      // The message names the other owner, which is the only thing that makes
      // the collision actionable.
      expect(collided.rejections[0]?.message).toContain("bach");

      // A second registration describes the current state, not a history.
      yield* registry.registerTools({
        name: "notes",
        tools: [{ ...spawnTool, name: "take_note" }],
      });
      expect((yield* registry.get("notes")).rejections).toStrictEqual([]);
    }),
  );

  it.effect("records a refused HTTP prefix and drops it once one is accepted", () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry();
      yield* withHandshake(registry);
      yield* registry.registerHttpPrefix({ name: "bach", prefix: "api" }).pipe(Effect.ignore);
      const refused = yield* registry.get("bach");
      expect(refused.rejections).toMatchObject([{ kind: "http-prefix", subject: "api" }]);
      expect(refused.httpPrefix).toBeUndefined();

      yield* registry.registerHttpPrefix({ name: "bach", prefix: "bach" });
      const accepted = yield* registry.get("bach");
      expect(accepted.rejections).toStrictEqual([]);
      expect(accepted.httpPrefix).toBe("bach");
    }),
  );

  it.effect("clears them when the extension starts again, since it re-registers", () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry();
      yield* withHandshake(registry);
      yield* registry.registerHttpPrefix({ name: "bach", prefix: "api" }).pipe(Effect.ignore);
      expect((yield* registry.get("bach")).rejections).toHaveLength(1);
      yield* registry.setState({ name: "bach", state: "starting" });
      expect((yield* registry.get("bach")).rejections).toStrictEqual([]);
    }),
  );
});
