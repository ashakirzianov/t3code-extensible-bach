/**
 * Starting, watching, and redeploying extension processes.
 *
 * The host runs an extension on **its own Node** — under Electron, the app's
 * binary with `ELECTRON_RUN_AS_NODE=1`, which the spike measured as a plain
 * Node 24 child with `node:sqlite` and no flags
 * (`docs/internals/extensions/spikes/electron-runtime.md` §2). The folder is
 * the cwd and may be read-only; everything the extension writes goes to the
 * data directory this module creates for it.
 *
 * The extension is handed its token, socket URL, data directory, and protocol
 * version through the environment, the same way agent MCP credentials travel.
 *
 * **Deploy is stop, rehash, start** (design §6.3) — one rule that covers a
 * fresh build from an agent, a downloaded update, and an app update carrying a
 * newer shipped version. It is host-initiated only: nothing an extension or an
 * agent can call reaches it.
 */
import {
  EXTENSION_PROTOCOL_VERSION,
  ExtensionFolderError,
  ExtensionNotFoundError,
  type ExtensionName,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as Context from "effect/Context";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { decodeUtf8 } from "../stream/collectUint8StreamText.ts";
import { EXTENSION_ENV } from "./ExtensionIdentity.ts";
import * as ExtensionFolderWatcher from "./ExtensionFolderWatcher.ts";
import { ExtensionRegistry } from "./ExtensionRegistry.ts";
import { loadFolder } from "./ExtensionFolder.ts";
import type { ResolvedExtensionSource } from "./ExtensionSources.ts";

/**
 * Restart backoff. A crash loop is usually a broken build, so the ceiling is
 * low enough to recover quickly once a fix lands and high enough that a
 * genuinely broken extension does not spin.
 */
export /**
 * How long a folder must stop changing before its rebuild counts as done.
 * Long enough to collapse a build's many writes into one hash, short enough
 * that the nav updates while the user is still looking at it.
 */
const EXTENSION_FOLDER_CHANGE_DEBOUNCE = Duration.millis(500);

const EXTENSION_RESTART_MIN_DELAY = Duration.seconds(1);
export const EXTENSION_RESTART_MAX_DELAY = Duration.seconds(30);

export interface ExtensionTokenMint {
  /** Minted per start, with the `extension` scope and a subject naming the extension. */
  readonly mint: (name: ExtensionName) => Effect.Effect<string>;
}

export interface ExtensionSupervisorOptions {
  readonly dataRoot: string;
  /** The socket an extension dials back on, as the host sees itself. */
  readonly websocketUrl: string;
  readonly mintToken: ExtensionTokenMint["mint"];
  /** `process.execPath` in production; overridden in tests. */
  readonly nodePath: string;
  /** Resolves relative source paths, so nothing here reads `process.cwd()`. */
  readonly cwd: string;
  /** Electron needs `ELECTRON_RUN_AS_NODE`; a plain Node host does not. */
  readonly runAsNode: boolean;
  readonly minRestartDelay?: Duration.Duration;
  readonly maxRestartDelay?: Duration.Duration;
  /** How long the folder must be quiet before a rebuild counts as finished. */
  readonly folderChangeDebounce?: Duration.Duration;
}

export interface ExtensionSupervisorShape {
  /** Read each source's folder, register it, and start the enabled ones. */
  readonly startAll: (
    sources: ReadonlyArray<ResolvedExtensionSource>,
  ) => Effect.Effect<void, never, Scope.Scope>;
  readonly deploy: (
    name: ExtensionName,
  ) => Effect.Effect<void, ExtensionNotFoundError | ExtensionFolderError, Scope.Scope>;
  readonly setEnabled: (input: {
    readonly name: ExtensionName;
    readonly enabled: boolean;
  }) => Effect.Effect<void, ExtensionNotFoundError, Scope.Scope>;
  /**
   * Re-read every known folder's hash, so `changed` is right even if a watcher
   * missed an event. Called when Settings reads the list or opens its stream:
   * cheap, on demand, and it makes the watcher an optimisation rather than the
   * only thing standing between the user and a stale screen.
   */
  readonly refreshFolderHashes: Effect.Effect<void>;
  readonly stopAll: Effect.Effect<void>;
}

export class ExtensionSupervisor extends Context.Service<
  ExtensionSupervisor,
  ExtensionSupervisorShape
>()("t3/extensions/ExtensionSupervisor") {}

interface RunningExtension {
  readonly fiber: Fiber.Fiber<void>;
}

const lines = (stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.filter((line) => line.trim() !== ""),
  );

export const make = Effect.fnUntraced(function* (options: ExtensionSupervisorOptions) {
  // The scope this layer is built in, which lives as long as the server. Every
  // supervisor fiber is forked into it rather than into whatever scope happened
  // to call `start` — see the note in `start`.
  const supervisorScope = yield* Effect.scope;
  const registry = yield* ExtensionRegistry;
  const watcher = yield* ExtensionFolderWatcher.ExtensionFolderWatcher;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  /** The folder reader with this layer's platform services already supplied. */
  const readFolder = (input: Parameters<typeof loadFolder>[0]) =>
    loadFolder(input).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(Crypto.Crypto, crypto),
    );
  const running = yield* SynchronizedRef.make<ReadonlyMap<ExtensionName, RunningExtension>>(
    new Map(),
  );

  /**
   * Re-read one folder and publish its hash.
   *
   * `setFolderHash` writes only `folderHash`; `changed` is derived from it
   * differing from `runningHash`, so this is the whole "mark changed" step —
   * and the same write is what wakes the registry's change stream.
   *
   * A folder that has become unreadable is left alone rather than reported: the
   * running process is still fine, and a build that briefly empties its output
   * directory should not flash an error at the user.
   */
  const refreshFolderHash = Effect.fn("ExtensionSupervisor.refreshFolderHash")(function* (input: {
    readonly name: ExtensionName;
    readonly path: string;
  }) {
    const loaded = yield* readFolder({ path: input.path }).pipe(Effect.option);
    if (Option.isNone(loaded)) return;
    yield* registry.setFolderHash({
      name: input.name,
      folderHash: loaded.value.hash,
      manifest: loaded.value.manifest,
    });
  });

  const refreshFolderHashes: ExtensionSupervisorShape["refreshFolderHashes"] = Effect.gen(
    function* () {
      const listed = yield* registry.list;
      yield* Effect.forEach(
        listed.extensions,
        (status) => refreshFolderHash({ name: status.name, path: status.path }),
        { discard: true, concurrency: 4 },
      );
    },
  ).pipe(Effect.withSpan("ExtensionSupervisor.refreshFolderHashes"));

  const stop = Effect.fn("ExtensionSupervisor.stop")(function* (name: ExtensionName) {
    const entry = yield* SynchronizedRef.modify(running, (current) => {
      const found = current.get(name);
      if (!found) return [undefined, current] as const;
      const next = new Map(current);
      next.delete(name);
      return [found, next] as const;
    });
    if (!entry) return;
    // Interrupting the supervision fiber releases its scope, which kills the
    // child and closes the log pumps with it.
    yield* Fiber.interrupt(entry.fiber);
  });

  /**
   * Fork a folder watcher into the current scope.
   *
   * Debounced because a build writes many files: without it a single `pnpm
   * build` would hash the folder once per file written. The debounce is also
   * what makes "changed" mean "a build finished" rather than "a build started".
   */
  const watchFolder = Effect.fn("ExtensionSupervisor.watchFolder")(function* (input: {
    readonly name: ExtensionName;
    readonly path: string;
  }) {
    yield* watcher.changes(input.path).pipe(
      Stream.debounce(options.folderChangeDebounce ?? EXTENSION_FOLDER_CHANGE_DEBOUNCE),
      Stream.runForEach(() => refreshFolderHash(input)),
      // The watcher is an optimisation; `refreshFolderHashes` covers the
      // same ground on demand. If it dies, the extension keeps running.
      Effect.ignore,
      Effect.forkScoped,
    );
  });

  /**
   * One process run, start to exit. Returns normally when the child exits;
   * the caller's retry schedule decides whether to go again.
   */
  const runOnce = Effect.fn("ExtensionSupervisor.runOnce")(function* (input: {
    readonly name: ExtensionName;
    readonly folder: string;
    readonly entry: string;
    readonly hash: string;
  }) {
    const dataDirectory = path.join(options.dataRoot, input.name);
    yield* fs.makeDirectory(dataDirectory, { recursive: true }).pipe(Effect.orDie);
    const token = yield* options.mintToken(input.name);
    yield* registry.setState({
      name: input.name,
      state: "starting",
      runningHash: input.hash,
    });
    const child = yield* spawner
      .spawn(
        ChildProcess.make(options.nodePath, [input.entry], {
          cwd: input.folder,
          extendEnv: true,
          env: {
            ...(options.runAsNode ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
            [EXTENSION_ENV.name]: input.name,
            [EXTENSION_ENV.token]: token,
            [EXTENSION_ENV.url]: options.websocketUrl,
            [EXTENSION_ENV.dataDir]: dataDirectory,
            [EXTENSION_ENV.protocol]: String(EXTENSION_PROTOCOL_VERSION),
          },
        }),
      )
      .pipe(
        Effect.tapError((cause) =>
          registry.setState({
            name: input.name,
            state: "crashed",
            lastError: `Could not start ${input.entry}: ${cause.message}`,
          }),
        ),
      );
    yield* registry.setState({ name: input.name, state: "running", runningHash: input.hash });
    const pump = (stream: typeof child.stdout, kind: "stdout" | "stderr") =>
      Stream.runForEach(lines(stream), (line) =>
        registry.appendLog({ name: input.name, stream: kind, line }),
      ).pipe(Effect.ignore, Effect.forkScoped);
    const pumps = [yield* pump(child.stdout, "stdout"), yield* pump(child.stderr, "stderr")];
    const code = yield* child.exitCode.pipe(Effect.orDie);
    // Drain before reporting the exit: a crashed extension's last stderr line
    // is the one worth reading, and the scope closes right after this.
    yield* Effect.forEach(pumps, Fiber.await, { discard: true });
    yield* registry.setState({
      name: input.name,
      state: code === 0 ? "stopped" : "crashed",
      countRestart: true,
      ...(code === 0 ? {} : { lastError: `Extension exited with code ${code}.` }),
    });
    return code;
  });

  /**
   * Supervise one extension until interrupted. Every restart re-reads the
   * folder, so a build that lands while an extension is crash-looping is
   * picked up without a Deploy click — the click is for the running case,
   * where replacing a live process is the user's call.
   */
  const supervise = (name: ExtensionName, source: { readonly path: string }) =>
    Effect.gen(function* () {
      const loaded = yield* readFolder({ path: source.path }).pipe(
        Effect.tapError((error) =>
          registry.setState({ name, state: "crashed", lastError: error.message }),
        ),
      );
      yield* registry.setFolderHash({
        name,
        folderHash: loaded.hash,
        manifest: loaded.manifest,
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          // Watch for the duration of this run, so a stopped or disabled
          // extension has no watcher: the scope closes with the process.
          yield* watchFolder({ name, path: loaded.path });
          yield* runOnce({
            name,
            folder: loaded.path,
            entry: loaded.manifest.server.entry,
            hash: loaded.hash,
          });
        }),
      );
    }).pipe(
      Effect.ignore,
      Effect.repeat(
        // `min` takes the shorter of the two delays, which is how the
        // exponential ramp gets capped instead of running away.
        Schedule.min([
          Schedule.exponential(options.minRestartDelay ?? EXTENSION_RESTART_MIN_DELAY),
          Schedule.spaced(options.maxRestartDelay ?? EXTENSION_RESTART_MAX_DELAY),
        ]),
      ),
      Effect.asVoid,
    );

  const start = Effect.fn("ExtensionSupervisor.start")(function* (source: {
    readonly name: ExtensionName;
    readonly path: string;
  }) {
    yield* stop(source.name);
    // Fork into the supervisor's own scope, not the caller's. `deploy` and
    // `setEnabled` are reached from an RPC handler wrapped in `Effect.scoped`,
    // so `forkScoped` attached the new fiber to that request's scope and
    // interrupted it the moment the call returned — which left the extension
    // stopped and its folder hash never re-read.
    const fiber = yield* Effect.forkIn(supervise(source.name, source), supervisorScope);
    yield* SynchronizedRef.update(running, (current) => {
      const next = new Map(current);
      next.set(source.name, { fiber });
      return next;
    });
  });

  const startAll: ExtensionSupervisorShape["startAll"] = Effect.fn("ExtensionSupervisor.startAll")(
    function* (sources) {
      for (const source of sources) {
        const resolved = path.isAbsolute(source.path)
          ? source.path
          : path.resolve(options.cwd, source.path);
        const loaded = yield* readFolder({ path: resolved }).pipe(
          Effect.map((folder) => ({ manifest: folder.manifest, folderHash: folder.hash })),
          Effect.catchTag("ExtensionFolderError", (error) =>
            Effect.succeed({ loadError: error.message }),
          ),
        );
        yield* registry.upsertSource({ ...source, path: resolved, ...loaded });
        if (!source.enabled) continue;
        if ("loadError" in loaded) {
          yield* registry.setState({
            name: source.name,
            state: "crashed",
            lastError: loaded.loadError,
          });
          continue;
        }
        // Marked before the fiber is forked, so a later "stopped" always means
        // the process ran and exited rather than never having begun — which is
        // what lets readiness treat it as settled.
        yield* registry.setState({ name: source.name, state: "starting" });
        yield* start({ name: source.name, path: resolved });
      }
      // Only now is the list final, so readiness can start resolving. Before
      // this, an empty registry would look like "nothing to wait for".
      yield* registry.markSourcesResolved;
    },
  );

  const deploy: ExtensionSupervisorShape["deploy"] = Effect.fn("ExtensionSupervisor.deploy")(
    function* (name) {
      const status = yield* registry.get(name);
      if (!status.enabled) {
        // Nothing to replace, but the folder may still have moved; refreshing
        // the hash is what clears the "changed" marker Settings is showing.
        const loaded = yield* readFolder({ path: status.path });
        yield* registry.setFolderHash({
          name,
          folderHash: loaded.hash,
          manifest: loaded.manifest,
        });
        return;
      }
      // Stop, rehash, start. The rehash happens inside `supervise`, so the
      // three steps are the two here plus the load the new fiber does.
      yield* stop(name);
      yield* registry.setState({ name, state: "stopped" });
      yield* start({ name, path: status.path });
    },
  );

  const setEnabled: ExtensionSupervisorShape["setEnabled"] = Effect.fn(
    "ExtensionSupervisor.setEnabled",
  )(function* (input) {
    const status = yield* registry.get(input.name);
    yield* registry.setEnabled(input);
    if (input.enabled) {
      yield* start({ name: input.name, path: status.path });
    } else {
      yield* stop(input.name);
      yield* registry.setState({ name: input.name, state: "disabled" });
    }
  });

  const stopAll: ExtensionSupervisorShape["stopAll"] = Effect.gen(function* () {
    const current = yield* SynchronizedRef.get(running);
    yield* Effect.forEach([...current.keys()], stop, { discard: true });
  });

  return ExtensionSupervisor.of({ startAll, deploy, setEnabled, refreshFolderHashes, stopAll });
});

export const layer = (options: ExtensionSupervisorOptions) =>
  Layer.effect(ExtensionSupervisor, make(options));

export { decodeUtf8 };
