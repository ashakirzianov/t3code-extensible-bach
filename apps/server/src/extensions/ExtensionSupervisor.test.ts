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

import * as ServerSettings from "../serverSettings.ts";
import { EXTENSION_ENV } from "./ExtensionIdentity.ts";
import * as ExtensionFolderWatcher from "./ExtensionFolderWatcher.ts";
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
  /** `--extension name=path` flags, as a desktop build passes for what it ships. */
  readonly launchFlags?: ReadonlyArray<{ readonly name: ExtensionName; readonly path: string }>;
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

  // A watcher the test drives by hand. `watched` records which folders got a
  // watcher at all, which is how "a disabled extension is not watched" is
  // checked without reaching for a real filesystem event.
  const folderTicks = yield* Queue.unbounded<void>();
  const watched = yield* Ref.make<ReadonlyArray<string>>([]);
  const watcher = ExtensionFolderWatcher.ExtensionFolderWatcher.of({
    changes: (watchedPath) =>
      Stream.unwrap(
        Ref.update(watched, (current) => [...current, watchedPath]).pipe(
          Effect.as(Stream.fromQueue(folderTicks)),
        ),
      ),
  });

  const registry = yield* ExtensionRegistry.make({
    environmentId,
    hostVersion: "0.0.38",
    dataRoot,
  });
  // The supervisor reads and writes the extension list through settings, so the
  // harness needs a real one. Built once and handed to both sides: a second
  // `layerTest()` would be a second in-memory store, and the test would be
  // reading settings the supervisor never wrote.
  const settings = yield* ServerSettings.ServerSettingsService.pipe(
    Effect.provide(ServerSettings.layerTest()),
  );
  const supervisor = yield* ExtensionSupervisor.make({
    dataRoot,
    websocketUrl: "ws://127.0.0.1:13773/ws",
    mintToken: (name) => Effect.succeed(`token-for-${name}`),
    nodePath: "/fake/node",
    runAsNode: true,
    cwd: "/workspace",
    minRestartDelay: Duration.millis(10),
    maxRestartDelay: Duration.millis(40),
    folderChangeDebounce: Duration.millis(500),
    ...(input.launchFlags === undefined ? {} : { launchFlags: input.launchFlags }),
  }).pipe(
    Effect.provideService(ExtensionRegistry.ExtensionRegistry, registry),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.provideService(ExtensionFolderWatcher.ExtensionFolderWatcher, watcher),
    Effect.provideService(ServerSettings.ServerSettingsService, settings),
  );

  return {
    registry,
    settings,
    supervisor,
    folder,
    dataRoot,
    spawns,
    launched,
    path,
    fs,
    /** Pretend the filesystem reported a change under the watched folder. */
    tickFolder: Queue.offer(folderTicks, undefined),
    watched,
  };
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
          yield* h.supervisor.reconcile(source(h.folder));
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
          yield* h.supervisor.reconcile(source(h.folder));
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
          yield* h.supervisor.reconcile(source(h.folder));
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
          yield* h.supervisor.reconcile([{ ...source(h.folder)[0]!, enabled: false }]);
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
          yield* h.supervisor.reconcile(source(h.folder));
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
          yield* h.supervisor.reconcile(source(h.folder));
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

/**
 * Waits for real asynchronous work to land.
 *
 * The rehash reads the folder from a real filesystem, and `TestClock.adjust`
 * moves virtual time without waiting for I/O — so after releasing the debounce
 * a test has to let the event loop turn before the registry can have been
 * written. Polling `setImmediate` is unaffected by the test clock, which is
 * exactly what is wanted here.
 */
const settleIo = Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));

const awaitChanged = (registry: ExtensionRegistry.ExtensionRegistryShape, expected: boolean) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const status = yield* registry.get("bach" as ExtensionName);
      if (status.changed === expected) return status;
      yield* settleIo;
    }
    return yield* registry.get("bach" as ExtensionName);
  });

describe("folder change detection", () => {
  it.effect("marks a running extension changed once the folder settles", () =>
    run(
      Effect.scoped(
        Effect.gen(function* () {
          const never = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
          const h = yield* harness({
            spawn: () => Effect.succeed(handle({ exit: Deferred.await(never) })),
          });
          yield* h.supervisor.reconcile(source(h.folder));
          yield* Queue.take(h.launched);
          expect((yield* h.registry.get("bach")).changed).toBe(false);

          // A build lands: several writes, then quiet.
          yield* h.fs.writeFileString(h.path.join(h.folder, "dist/server.js"), "// build 2");
          yield* h.tickFolder;
          yield* h.tickFolder;
          // Let the stream fiber pick the ticks up and reach its debounce sleep
          // before the clock moves; TestClock does not wake a fiber that has
          // not yet slept.
          yield* TestClock.adjust(Duration.zero);

          // Still within the debounce: nothing has been re-hashed yet, which is
          // what stops a half-written build from being announced.
          yield* TestClock.adjust(Duration.millis(200));
          expect((yield* h.registry.get("bach")).changed).toBe(false);

          yield* TestClock.adjust(Duration.millis(400));
          const after = yield* awaitChanged(h.registry, true);
          expect(after.changed).toBe(true);
          // The folder moved; the process did not.
          expect(after.state).toBe("running");
          expect(after.folderHash).not.toBe(after.runningHash);
          // And no restart was provoked by the change.
          expect((yield* Ref.get(h.spawns)).length).toBe(1);
        }),
      ),
    ),
  );

  it.effect("a tick that changed nothing leaves the extension unchanged", () =>
    run(
      Effect.scoped(
        Effect.gen(function* () {
          const never = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
          const h = yield* harness({
            spawn: () => Effect.succeed(handle({ exit: Deferred.await(never) })),
          });
          yield* h.supervisor.reconcile(source(h.folder));
          yield* Queue.take(h.launched);

          // Watchers tick spuriously — an editor's temp file, a poll on a quiet
          // folder. The hash is the arbiter, so this must be a no-op.
          yield* h.tickFolder;
          yield* Effect.yieldNow;
          yield* TestClock.adjust(Duration.seconds(1));
          expect((yield* h.registry.get("bach")).changed).toBe(false);
        }),
      ),
    ),
  );

  it.effect("deploy clears the changed flag by adopting the new build", () =>
    run(
      Effect.scoped(
        Effect.gen(function* () {
          const never = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
          const h = yield* harness({
            spawn: () => Effect.succeed(handle({ exit: Deferred.await(never) })),
          });
          yield* h.supervisor.reconcile(source(h.folder));
          yield* Queue.take(h.launched);

          yield* h.fs.writeFileString(h.path.join(h.folder, "dist/server.js"), "// build 2");
          yield* h.tickFolder;
          yield* TestClock.adjust(Duration.seconds(1));
          expect((yield* awaitChanged(h.registry, true)).changed).toBe(true);

          yield* Effect.scoped(h.supervisor.deploy("bach"));
          yield* Queue.take(h.launched);
          const after = yield* h.registry.get("bach");
          expect(after.changed).toBe(false);
          expect(after.folderHash).toBe(after.runningHash);
        }),
      ),
    ),
  );

  it.effect("a disabled extension is not watched", () =>
    run(
      Effect.scoped(
        Effect.gen(function* () {
          const never = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
          const h = yield* harness({
            spawn: () => Effect.succeed(handle({ exit: Deferred.await(never) })),
          });
          yield* h.supervisor.reconcile([
            { name: "bach" as ExtensionName, path: h.folder, enabled: false, source: "settings" },
          ]);
          yield* TestClock.adjust(Duration.seconds(1));
          // Nothing running means nothing to redeploy, so there is nothing to
          // watch for either.
          expect(yield* Ref.get(h.watched)).toEqual([]);
        }),
      ),
    ),
  );

  it.effect("stopping an extension takes its watcher with it", () =>
    run(
      Effect.scoped(
        Effect.gen(function* () {
          const never = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
          const h = yield* harness({
            spawn: () => Effect.succeed(handle({ exit: Deferred.await(never) })),
          });
          yield* h.supervisor.reconcile(source(h.folder));
          yield* Queue.take(h.launched);
          expect(yield* Ref.get(h.watched)).toEqual([h.folder]);

          yield* Effect.scoped(h.supervisor.setEnabled({ name: "bach", enabled: false }));
          yield* h.fs.writeFileString(h.path.join(h.folder, "dist/server.js"), "// build 2");
          yield* h.tickFolder;
          yield* TestClock.adjust(Duration.seconds(1));

          // The watcher died with the process scope, so the tick reaches nobody.
          expect((yield* h.registry.get("bach")).state).toBe("disabled");
        }),
      ),
    ),
  );

  it.effect("refreshFolderHashes catches a change the watcher missed", () =>
    run(
      Effect.scoped(
        Effect.gen(function* () {
          const never = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
          const h = yield* harness({
            spawn: () => Effect.succeed(handle({ exit: Deferred.await(never) })),
          });
          yield* h.supervisor.reconcile(source(h.folder));
          yield* Queue.take(h.launched);

          // A build lands and no event arrives — a dropped inotify event, a
          // filesystem with no recursive watch. Settings must still be right.
          yield* h.fs.writeFileString(h.path.join(h.folder, "dist/server.js"), "// build 2");
          expect((yield* h.registry.get("bach")).changed).toBe(false);

          yield* h.supervisor.refreshFolderHashes;
          expect((yield* h.registry.get("bach")).changed).toBe(true);
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
          yield* h.supervisor.reconcile(source(h.folder));
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
          yield* h.supervisor.reconcile(source(h.folder));
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
          yield* h.supervisor.reconcile([{ ...source(h.folder)[0]!, enabled: false }]);
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
          yield* h.supervisor.reconcile(source(h.folder));
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

describe("reconciling", () => {
  /** A spawner whose children never exit, so "running" stays observable. */
  const staysUp = Effect.fn("test.staysUp")(function* () {
    const never = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
    return () => Effect.succeed(handle({ exit: Deferred.await(never) }));
  });

  it.effect("starts an entry that appears and forgets one that goes", () =>
    run(
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness({ spawn: yield* staysUp() });
          yield* h.supervisor.reconcile(source(h.folder));
          yield* Queue.take(h.launched);
          expect((yield* h.registry.list).extensions.map((e) => e.name)).toStrictEqual(["bach"]);

          // Gone from settings: the record goes with it, so its tool names and
          // HTTP prefix are free again rather than held by something dead.
          yield* h.supervisor.reconcile([]);
          expect((yield* h.registry.list).extensions).toStrictEqual([]);
        }),
      ),
    ),
  );

  it.effect("leaves an unchanged list completely alone", () =>
    run(
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness({ spawn: yield* staysUp() });
          yield* h.supervisor.reconcile(source(h.folder));
          yield* Queue.take(h.launched);
          // Reconciling is called on every settings write, most of which have
          // nothing to do with extensions; a restart on each would be brutal.
          yield* h.supervisor.reconcile(source(h.folder));
          yield* h.supervisor.reconcile(source(h.folder));
          expect(yield* Ref.get(h.spawns)).toHaveLength(1);
        }),
      ),
    ),
  );

  it.effect("follows enabled from the entry, both ways", () =>
    run(
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness({ spawn: yield* staysUp() });
          yield* h.supervisor.reconcile(source(h.folder));
          yield* Queue.take(h.launched);

          yield* h.supervisor.reconcile([{ ...source(h.folder)[0]!, enabled: false }]);
          const off = (yield* h.registry.list).extensions[0]!;
          expect(off.state).toBe("disabled");
          expect(off.enabled).toBe(false);

          yield* h.supervisor.reconcile(source(h.folder));
          yield* Queue.take(h.launched);
          expect((yield* h.registry.list).extensions[0]!.enabled).toBe(true);
          expect(yield* Ref.get(h.spawns)).toHaveLength(2);
        }),
      ),
    ),
  );

  it.effect("restarts on the new folder when the entry's path moves", () =>
    run(
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness({ spawn: yield* staysUp() });
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          yield* h.supervisor.reconcile(source(h.folder));
          const first = yield* Queue.take(h.launched);

          // A second build of the same extension somewhere else. The name is
          // the same, so this is a path change rather than an install.
          const moved = yield* fs.makeTempDirectoryScoped({ prefix: "extension-moved-" });
          yield* fs.writeFileString(path.join(moved, "extension.json"), JSON.stringify(manifest));
          yield* fs.makeDirectory(path.join(moved, "dist"), { recursive: true });
          yield* fs.writeFileString(path.join(moved, "dist/server.js"), "// build 2");

          yield* h.supervisor.reconcile([{ ...source(h.folder)[0]!, path: moved }]);
          const second = yield* Queue.take(h.launched);
          expect(first.cwd).toBe(h.folder);
          expect(second.cwd).toBe(moved);
          expect((yield* h.registry.list).extensions[0]!.path).toBe(moved);
        }),
      ),
    ),
  );
});

describe("install and remove", () => {
  const staysUp = Effect.fn("test.staysUp")(function* () {
    const never = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
    return () => Effect.succeed(handle({ exit: Deferred.await(never) }));
  });

  it.effect("installs a folder by its manifest's name and starts it", () =>
    run(
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness({ spawn: yield* staysUp() });
          const name = yield* h.supervisor.install({ path: h.folder });
          expect(name).toBe("bach");
          yield* Queue.take(h.launched);
          expect((yield* h.registry.list).extensions[0]!.state).toBe("running");
          // The entry is what survives a restart, so it has to be written.
          const stored = yield* h.settings.getSettings;
          expect(stored.extensions).toStrictEqual([
            { name: "bach", path: h.folder, enabled: true },
          ]);
        }),
      ),
    ),
  );

  it.effect("refuses a folder that is not an extension, writing nothing", () =>
    run(
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness({ spawn: yield* staysUp() });
          const fs = yield* FileSystem.FileSystem;
          const empty = yield* fs.makeTempDirectoryScoped({ prefix: "extension-empty-" });

          const exit = yield* Effect.exit(h.supervisor.install({ path: empty }));
          expect(exit._tag).toBe("Failure");
          // A refused install must not leave an entry for the user to find
          // later and wonder about.
          expect((yield* h.settings.getSettings).extensions).toStrictEqual([]);
          expect((yield* h.registry.list).extensions).toStrictEqual([]);
        }),
      ),
    ),
  );

  it.effect("refuses a second folder claiming an installed name", () =>
    run(
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness({ spawn: yield* staysUp() });
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          yield* h.supervisor.install({ path: h.folder });
          yield* Queue.take(h.launched);

          const other = yield* fs.makeTempDirectoryScoped({ prefix: "extension-other-" });
          yield* fs.writeFileString(path.join(other, "extension.json"), JSON.stringify(manifest));
          yield* fs.makeDirectory(path.join(other, "dist"), { recursive: true });
          yield* fs.writeFileString(path.join(other, "dist/server.js"), "// other");

          const exit = yield* Effect.exit(h.supervisor.install({ path: other }));
          expect(exit._tag).toBe("Failure");
          // The first install still owns the name and its original path.
          expect((yield* h.settings.getSettings).extensions).toStrictEqual([
            { name: "bach", path: h.folder, enabled: true },
          ]);
        }),
      ),
    ),
  );

  it.effect("removes it, and keeps its data unless asked", () =>
    run(
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness({ spawn: yield* staysUp() });
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          yield* h.supervisor.install({ path: h.folder });
          yield* Queue.take(h.launched);
          const dataDir = path.join(h.dataRoot, "bach");
          yield* fs.makeDirectory(dataDir, { recursive: true });
          yield* fs.writeFileString(path.join(dataDir, "state.json"), "{}");

          yield* h.supervisor.remove({ name: "bach" as ExtensionName, deleteData: false });
          expect((yield* h.settings.getSettings).extensions).toStrictEqual([]);
          expect((yield* h.registry.list).extensions).toStrictEqual([]);
          // Removing to reinstall is the common case; discarding state silently
          // would make that lossy.
          expect(yield* fs.exists(dataDir)).toBe(true);
        }),
      ),
    ),
  );

  it.effect("deletes the data directory when asked", () =>
    run(
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness({ spawn: yield* staysUp() });
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          yield* h.supervisor.install({ path: h.folder });
          yield* Queue.take(h.launched);
          const dataDir = path.join(h.dataRoot, "bach");
          yield* fs.makeDirectory(dataDir, { recursive: true });
          yield* fs.writeFileString(path.join(dataDir, "state.json"), "{}");

          yield* h.supervisor.remove({ name: "bach" as ExtensionName, deleteData: true });
          expect(yield* fs.exists(dataDir)).toBe(false);
        }),
      ),
    ),
  );
});

describe("changing an extension's folder", () => {
  const bach = "bach" as ExtensionName;

  const staysUp = Effect.fn("test.staysUp")(function* () {
    const never = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
    return () => Effect.succeed(handle({ exit: Deferred.await(never) }));
  });

  /** A second build of the same extension somewhere else on disk. */
  const otherBuild = Effect.fn("test.otherBuild")(function* (prefix: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const folder = yield* fs.makeTempDirectoryScoped({ prefix });
    yield* fs.writeFileString(path.join(folder, "extension.json"), JSON.stringify(manifest));
    yield* fs.makeDirectory(path.join(folder, "dist"), { recursive: true });
    yield* fs.writeFileString(path.join(folder, "dist/server.js"), "// another build");
    return folder;
  });

  it.effect("repoints a settings-entry extension, restarting it on the new folder", () =>
    run(
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness({ spawn: yield* staysUp() });
          yield* h.supervisor.install({ path: h.folder });
          yield* Queue.take(h.launched);
          const other = yield* otherBuild("extension-repointed-");

          yield* h.supervisor.setPath({ name: bach, path: other });
          expect((yield* Queue.take(h.launched)).cwd).toBe(other);
          // An edit, not a second install: still one entry, same switch.
          expect((yield* h.settings.getSettings).extensions).toStrictEqual([
            { name: "bach", path: other, enabled: true },
          ]);
          const status = yield* h.registry.get(bach);
          expect(status.path).toBe(other);
        }),
      ),
    ),
  );

  it.effect("repointing a flag-started extension writes the entry that overrides the flag", () =>
    run(
      Effect.scoped(
        Effect.gen(function* () {
          // A harness only to get a built folder the flag can point at.
          const probe = yield* harness({ spawn: yield* staysUp() });
          const flagged = yield* harness({
            spawn: yield* staysUp(),
            launchFlags: [{ name: bach, path: probe.folder }],
          });
          yield* flagged.supervisor.watchSettings;
          expect((yield* Queue.take(flagged.launched)).cwd).toBe(probe.folder);
          expect((yield* flagged.registry.get(bach)).source).toBe("launch-flag");
          const mine = yield* otherBuild("extension-mine-");

          yield* flagged.supervisor.setPath({ name: bach, path: mine });
          expect((yield* Queue.take(flagged.launched)).cwd).toBe(mine);
          // Settings wins by name: the entry is what makes the new folder stick.
          expect((yield* flagged.settings.getSettings).extensions).toStrictEqual([
            { name: "bach", path: mine, enabled: true },
          ]);
          expect((yield* flagged.registry.get(bach)).source).toBe("settings");

          // The way back is Remove: dropping the entry lets the flag's folder
          // take over again, rather than the extension disappearing.
          yield* flagged.supervisor.remove({ name: bach, deleteData: false });
          expect((yield* Queue.take(flagged.launched)).cwd).toBe(probe.folder);
          expect((yield* flagged.registry.get(bach)).source).toBe("launch-flag");
        }),
      ),
    ),
  );

  it.effect("refuses a folder that is not an extension, changing nothing", () =>
    run(
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness({ spawn: yield* staysUp() });
          const fs = yield* FileSystem.FileSystem;
          yield* h.supervisor.install({ path: h.folder });
          yield* Queue.take(h.launched);
          const empty = yield* fs.makeTempDirectoryScoped({ prefix: "extension-empty-" });

          const exit = yield* Effect.exit(h.supervisor.setPath({ name: bach, path: empty }));
          expect(exit._tag).toBe("Failure");
          expect((yield* h.settings.getSettings).extensions).toStrictEqual([
            { name: "bach", path: h.folder, enabled: true },
          ]);
          expect(yield* Ref.get(h.spawns)).toHaveLength(1);
        }),
      ),
    ),
  );
});

describe("the enabled switch is kept in settings", () => {
  const bach = "bach" as ExtensionName;

  const staysUp = Effect.fn("test.staysUp")(function* () {
    const never = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
    return () => Effect.succeed(handle({ exit: Deferred.await(never) }));
  });

  it.effect("a disable survives the next reconcile rather than being undone by it", () =>
    run(
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness({ spawn: yield* staysUp() });
          yield* h.supervisor.install({ path: h.folder });
          yield* Queue.take(h.launched);

          yield* h.supervisor.setEnabled({ name: bach, enabled: false });
          expect((yield* h.settings.getSettings).extensions).toStrictEqual([
            { name: "bach", path: h.folder, enabled: false },
          ]);
          // Every settings write reconciles. Before the switch was persisted,
          // this re-read `enabled: true` and quietly started it again.
          yield* h.supervisor.watchSettings;
          expect((yield* h.registry.get(bach)).state).toBe("disabled");
          expect(yield* Ref.get(h.spawns)).toHaveLength(1);
        }),
      ),
    ),
  );

  it.effect("disabling a flag-started extension writes an entry that keeps it off", () =>
    run(
      Effect.scoped(
        Effect.gen(function* () {
          const probe = yield* harness({ spawn: yield* staysUp() });
          const h = yield* harness({
            spawn: yield* staysUp(),
            launchFlags: [{ name: bach, path: probe.folder }],
          });
          yield* h.supervisor.watchSettings;
          yield* Queue.take(h.launched);

          yield* h.supervisor.setEnabled({ name: bach, enabled: false });
          // The launch flag alone cannot say "off"; the settings entry can.
          expect((yield* h.settings.getSettings).extensions).toStrictEqual([
            { name: "bach", path: probe.folder, enabled: false },
          ]);
          yield* h.supervisor.watchSettings;
          expect((yield* h.registry.get(bach)).state).toBe("disabled");
          expect(yield* Ref.get(h.spawns)).toHaveLength(1);

          yield* h.supervisor.setEnabled({ name: bach, enabled: true });
          yield* Queue.take(h.launched);
          expect((yield* h.registry.get(bach)).enabled).toBe(true);
        }),
      ),
    ),
  );
});
