// @effect-diagnostics preferSchemaOverJson:off - the fixture writes a manifest as raw JSON.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { EXTENSION_PROTOCOL_VERSION, EnvironmentId, type ExtensionName } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { EXTENSION_ENV } from "./ExtensionIdentity.ts";
import * as ExtensionRegistry from "./ExtensionRegistry.ts";
import * as ExtensionSupervisor from "./ExtensionSupervisor.ts";

interface SpawnRecord {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
}

// The spawner's command object keeps its fields private; tests read them the
// same way `processRunner.test.ts` does.
const readCommand = (command: unknown): SpawnRecord => {
  const raw = command as {
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly options?: {
      readonly cwd?: string;
      readonly env?: Readonly<Record<string, string | undefined>>;
    };
  };
  return {
    command: raw.command,
    args: raw.args,
    cwd: raw.options?.cwd,
    env: raw.options?.env ?? {},
  };
};

const handle = (input: {
  readonly code?: number;
  readonly exit?: Effect.Effect<ChildProcessSpawner.ExitCode>;
  readonly stdout?: string;
  readonly stderr?: string;
}) =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: input.exit ?? Effect.succeed(ChildProcessSpawner.ExitCode(input.code ?? 0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout:
      input.stdout === undefined ? Stream.empty : Stream.encodeText(Stream.make(input.stdout)),
    stderr:
      input.stderr === undefined ? Stream.empty : Stream.encodeText(Stream.make(input.stderr)),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });

const manifest = {
  name: "bach",
  version: "1.0.0",
  protocolVersion: EXTENSION_PROTOCOL_VERSION,
  server: { entry: "dist/server.js" },
};

const environmentId = EnvironmentId.make("environment-1");

/** A registry, a fake spawner that records every launch, and a built folder. */
const harness = Effect.fn("test.harness")(function* (input: {
  readonly spawn: (
    record: SpawnRecord,
    attempt: number,
  ) => Effect.Effect<ChildProcessSpawner.ChildProcessHandle, PlatformError.PlatformError>;
  readonly manifestOverrides?: Partial<typeof manifest>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const folder = yield* fs.makeTempDirectoryScoped({ prefix: "extension-supervisor-" });
  const dataRoot = yield* fs.makeTempDirectoryScoped({ prefix: "extension-data-" });
  const written = { ...manifest, ...input.manifestOverrides };
  yield* fs.writeFileString(path.join(folder, "extension.json"), JSON.stringify(written));
  yield* fs.makeDirectory(path.join(folder, "dist"), { recursive: true });
  yield* fs.writeFileString(path.join(folder, "dist/server.js"), "// build 1");

  const spawns = yield* Ref.make<ReadonlyArray<SpawnRecord>>([]);
  // Every launch is published here, so a test waits on the spawn actually
  // happening instead of guessing how many scheduler turns it takes.
  const launched = yield* Queue.unbounded<SpawnRecord>();
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      const record = readCommand(command);
      const attempt = yield* Ref.modify(spawns, (current) => [
        current.length,
        [...current, record],
      ]);
      yield* Queue.offer(launched, record);
      return yield* input.spawn(record, attempt);
    }),
  );

  const registry = yield* ExtensionRegistry.make({
    environmentId,
    hostVersion: "0.0.38",
    dataRoot,
  });
  const supervisor = yield* ExtensionSupervisor.make({
    dataRoot,
    websocketUrl: "ws://127.0.0.1:13773/ws",
    mintToken: (name) => Effect.succeed(`token-for-${name}`),
    nodePath: "/fake/node",
    runAsNode: true,
    cwd: "/workspace",
    minRestartDelay: Duration.millis(10),
    maxRestartDelay: Duration.millis(40),
  }).pipe(
    Effect.provideService(ExtensionRegistry.ExtensionRegistry, registry),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
  );

  return { registry, supervisor, folder, dataRoot, spawns, launched, path, fs };
});

const source = (folder: string) => [
  { name: "bach" as ExtensionName, path: folder, enabled: true, source: "settings" as const },
];

const run = <A, E>(
  effect: Effect.Effect<A, E, Crypto.Crypto | FileSystem.FileSystem | Path.Path | Scope.Scope>,
) => effect.pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, TestClock.layer())));

describe("starting", () => {
  it.effect("runs the manifest's entry on the host's own Node, in the folder", () =>
    run(
      Effect.scoped(
        Effect.gen(function* () {
          const never = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
          const h = yield* harness({
            spawn: () => Effect.succeed(handle({ exit: Deferred.await(never) })),
          });
          yield* h.supervisor.startAll(source(h.folder));
          const spawn = yield* Queue.take(h.launched);
          expect(spawn.command).toBe("/fake/node");
          expect(spawn.args).toStrictEqual(["dist/server.js"]);
          expect(spawn.cwd).toBe(h.folder);
          expect(spawn.env).toMatchObject({
            ELECTRON_RUN_AS_NODE: "1",
            [EXTENSION_ENV.name]: "bach",
            [EXTENSION_ENV.token]: "token-for-bach",
            [EXTENSION_ENV.url]: "ws://127.0.0.1:13773/ws",
            [EXTENSION_ENV.protocol]: String(EXTENSION_PROTOCOL_VERSION),
          });
          expect(yield* h.registry.get("bach")).toMatchObject({
            state: "running",
            version: "1.0.0",
          });
        }),
      ),
    ),
  );

  it.effect("creates the data directory it hands the extension", () =>
    run(
      Effect.scoped(
        Effect.gen(function* () {
          const never = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
          const h = yield* harness({
            spawn: () => Effect.succeed(handle({ exit: Deferred.await(never) })),
          });
          yield* h.supervisor.startAll(source(h.folder));
          const spawn = yield* Queue.take(h.launched);
          const dataDirectory = spawn.env[EXTENSION_ENV.dataDir];
          expect(dataDirectory).toBe(h.path.join(h.dataRoot, "bach"));
          expect(yield* h.fs.exists(dataDirectory ?? "")).toBe(true);
        }),
      ),
    ),
  );

  it.effect("records a broken folder instead of spawning it", () =>
    run(
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness({ spawn: () => Effect.succeed(handle({})) });
          yield* h.fs.remove(h.path.join(h.folder, "dist/server.js"));
          yield* h.supervisor.startAll(source(h.folder));
          expect(yield* Ref.get(h.spawns)).toStrictEqual([]);
          const status = yield* h.registry.get("bach");
          expect(status.state).toBe("crashed");
          expect(status.lastError).toContain("dist/server.js");
        }),
      ),
    ),
  );

  it.effect("does not start a disabled extension but still lists it", () =>
    run(
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness({ spawn: () => Effect.succeed(handle({})) });
          yield* h.supervisor.startAll([{ ...source(h.folder)[0]!, enabled: false }]);
          expect(yield* Ref.get(h.spawns)).toStrictEqual([]);
          expect(yield* h.registry.get("bach")).toMatchObject({
            state: "disabled",
            enabled: false,
          });
        }),
      ),
    ),
  );

  it.effect("captures the child's output into the extension's own log", () =>
    run(
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness({
            spawn: () =>
              Effect.succeed(handle({ code: 1, stdout: "ready\nlistening", stderr: "warn" })),
          });
          yield* h.supervisor.startAll(source(h.folder));
          yield* Queue.take(h.launched);
          // The run drains its output before reporting the exit, so waiting for
          // the restart is waiting for run one's logs to be complete.
          yield* TestClock.adjust(Duration.millis(20));
          yield* Queue.take(h.launched);

          const { entries } = yield* h.registry.logs({ name: "bach" });
          expect(entries.map((entry) => `${entry.stream}:${entry.line}`)).toContain(
            "stdout:listening",
          );
          expect(entries.map((entry) => `${entry.stream}:${entry.line}`)).toContain("stderr:warn");
        }),
      ),
    ),
  );
});

describe("restarting", () => {
  it.effect("restarts a crashed extension on a backoff that is capped", () =>
    run(
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness({
            spawn: () => Effect.succeed(handle({ code: 1 })),
          });
          yield* h.supervisor.startAll(source(h.folder));
          yield* Queue.take(h.launched);

          // The exit lands, and nothing is retried before the minimum delay.
          yield* TestClock.adjust(Duration.millis(5));
          expect((yield* Ref.get(h.spawns)).length).toBe(1);
          expect(yield* h.registry.get("bach")).toMatchObject({ state: "crashed" });

          // Past the floor, the retry happens; waiting on the launch itself
          // keeps the test independent of the ramp's exact arithmetic.
          yield* TestClock.adjust(Duration.millis(50));
          yield* Queue.take(h.launched);
          expect((yield* Ref.get(h.spawns)).length).toBeGreaterThanOrEqual(2);

          // The ramp is capped: every further attempt still lands inside the
          // maximum delay. Uncapped, the fourth would need 80ms and this would
          // hang rather than fail.
          yield* Effect.forEach(
            [1, 2, 3, 4],
            () =>
              TestClock.adjust(Duration.millis(45)).pipe(Effect.andThen(Queue.take(h.launched))),
            { discard: true },
          );
          expect((yield* Ref.get(h.spawns)).length).toBeGreaterThanOrEqual(6);
          // Every completed run counted, which is what Settings shows next to
          // a crash-looping extension.
          expect((yield* h.registry.get("bach")).restartCount).toBeGreaterThanOrEqual(5);
        }),
      ),
    ),
  );
});

describe("deploy and enablement", () => {
  it.effect("deploy stops the process, rehashes the folder, and starts the new build", () =>
    run(
      Effect.scoped(
        Effect.gen(function* () {
          const never = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
          const h = yield* harness({
            spawn: () => Effect.succeed(handle({ exit: Deferred.await(never) })),
          });
          yield* h.supervisor.startAll(source(h.folder));
          yield* Queue.take(h.launched);
          const before = yield* h.registry.get("bach");
          expect(before.changed).toBe(false);

          yield* h.fs.writeFileString(h.path.join(h.folder, "dist/server.js"), "// build 2");
          yield* h.supervisor.deploy("bach");
          yield* Queue.take(h.launched);

          expect((yield* Ref.get(h.spawns)).length).toBe(2);
          const after = yield* h.registry.get("bach");
          expect(after.state).toBe("running");
          expect(after.changed).toBe(false);
          expect(after.runningHash).not.toBe(before.runningHash);
        }),
      ),
    ),
  );

  // Regression: `deploy` is reached from an RPC handler wrapped in its own
  // `Effect.scoped`, which closes as soon as the call returns. Forking the new
  // supervisor fiber into *that* scope interrupted it immediately, leaving the
  // extension stopped and its hash never re-read. The test above could not see
  // it because it shares one scope for the supervisor and the deploy.
  it.effect("deploy survives the caller's scope closing, as it does over RPC", () =>
    run(
      Effect.scoped(
        Effect.gen(function* () {
          const never = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
          const h = yield* harness({
            spawn: () => Effect.succeed(handle({ exit: Deferred.await(never) })),
          });
          yield* h.supervisor.startAll(source(h.folder));
          yield* Queue.take(h.launched);
          const before = yield* h.registry.get("bach");

          yield* h.fs.writeFileString(h.path.join(h.folder, "dist/server.js"), "// build 2");
          // The shape ws.ts uses: a scope that ends with the request.
          yield* Effect.scoped(h.supervisor.deploy("bach"));
          yield* Queue.take(h.launched);

          const after = yield* h.registry.get("bach");
          expect(after.state).toBe("running");
          expect(after.runningHash).not.toBe(before.runningHash);
          expect((yield* Ref.get(h.spawns)).length).toBe(2);
        }),
      ),
    ),
  );

  it.effect("deploying a disabled extension refreshes its hash without starting it", () =>
    run(
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness({ spawn: () => Effect.succeed(handle({})) });
          yield* h.supervisor.startAll([{ ...source(h.folder)[0]!, enabled: false }]);
          const before = yield* h.registry.get("bach");

          yield* h.fs.writeFileString(h.path.join(h.folder, "dist/server.js"), "// build 2");
          yield* h.supervisor.deploy("bach");

          expect(yield* Ref.get(h.spawns)).toStrictEqual([]);
          const after = yield* h.registry.get("bach");
          expect(after.state).toBe("disabled");
          expect(after.folderHash).not.toBe(before.folderHash);
        }),
      ),
    ),
  );

  it.effect("disabling stops the process; enabling starts it again", () =>
    run(
      Effect.scoped(
        Effect.gen(function* () {
          const never = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
          const h = yield* harness({
            spawn: () => Effect.succeed(handle({ exit: Deferred.await(never) })),
          });
          yield* h.supervisor.startAll(source(h.folder));
          yield* Queue.take(h.launched);

          yield* h.supervisor.setEnabled({ name: "bach", enabled: false });
          expect(yield* h.registry.get("bach")).toMatchObject({
            state: "disabled",
            enabled: false,
          });

          yield* h.supervisor.setEnabled({ name: "bach", enabled: true });
          yield* Queue.take(h.launched);
          expect((yield* Ref.get(h.spawns)).length).toBe(2);
          expect(yield* h.registry.get("bach")).toMatchObject({ state: "running", enabled: true });
        }),
      ),
    ),
  );
});
