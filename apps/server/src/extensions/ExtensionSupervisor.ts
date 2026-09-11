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
  ExtensionAlreadyInstalledError,
  ExtensionFolderError,
  ExtensionNotFoundError,
  ExtensionNotRemovableError,
  type ExtensionName,
  type ExtensionSettingsEntry,
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
import {
  resolveExtensionSources,
  type ExtensionLaunchFlag,
  type ResolvedExtensionSource,
} from "./ExtensionSources.ts";
import { ServerSettingsService } from "../serverSettings.ts";

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
  /**
   * The process's `--extension` flags. Held here rather than re-read per
   * reconcile because they cannot change while the server runs.
   */
  readonly launchFlags?: ReadonlyArray<ExtensionLaunchFlag>;
  readonly minRestartDelay?: Duration.Duration;
  readonly maxRestartDelay?: Duration.Duration;
  /** How long the folder must be quiet before a rebuild counts as finished. */
  readonly folderChangeDebounce?: Duration.Duration;
}

export interface ExtensionSupervisorShape {
  /**
   * Make the running set match `sources`.
   *
   * Idempotent, and the only way the set changes: startup calls it with the
   * resolved sources, and every settings change calls it again. A name that is
   * new starts, one that has gone stops and is forgotten, one whose path moved
   * restarts on the new folder, and one whose `enabled` flipped follows it.
   * Calling it with an unchanged list does nothing, which is what lets the
   * install and remove RPCs both write settings and reconcile without caring
   * whether the change stream got there first.
   */
  readonly reconcile: (
    sources: ReadonlyArray<ResolvedExtensionSource>,
  ) => Effect.Effect<void, never, Scope.Scope>;
  /**
   * Reconcile now, then keep reconciling as settings change. Called once at
   * startup; the fiber it forks lives as long as the server.
   */
  readonly watchSettings: Effect.Effect<void, never, Scope.Scope>;
  readonly deploy: (
    name: ExtensionName,
  ) => Effect.Effect<void, ExtensionNotFoundError | ExtensionFolderError, Scope.Scope>;
  /**
   * Add a folder to this environment's settings and start it.
   *
   * The folder is read before anything is written, so a path that is not an
   * extension is refused without leaving a broken entry behind for the user to
   * find later.
   */
  readonly install: (input: {
    readonly path: string;
  }) => Effect.Effect<
    ExtensionName,
    ExtensionFolderError | ExtensionAlreadyInstalledError,
    Scope.Scope
  >;
  /**
   * Stop it, drop its settings entry, and forget it. The data directory is kept
   * unless asked for: an extension is usually removed to reinstall it, and
   * silently discarding its state would make that lossy.
   */
  readonly remove: (input: {
    readonly name: ExtensionName;
    readonly deleteData: boolean;
  }) => Effect.Effect<void, ExtensionNotFoundError | ExtensionNotRemovableError>;
  /**
   * Turn it on or off, and keep it that way.
   *
   * Written to settings rather than only to the running registry: the settings
   * are what every reconcile — and every restart — reads, so a switch that
   * lived only in memory would be undone by the next unrelated settings write.
   * For an extension a launch flag started, this writes the overriding entry
   * with `enabled: false`, which is the documented way to turn a shipped
   * extension off.
   */
  readonly setEnabled: (input: {
    readonly name: ExtensionName;
    readonly enabled: boolean;
  }) => Effect.Effect<void, ExtensionNotFoundError, Scope.Scope>;
  /**
   * Point an installed extension at another folder: rewrite its settings entry
   * (creating the override if a launch flag is what named it) and reconcile,
   * whose moved-path branch stops the old process and starts the new folder.
   * The folder is read first, so a path that is not an extension changes
   * nothing.
   */
  readonly setPath: (input: {
    readonly name: ExtensionName;
    readonly path: string;
  }) => Effect.Effect<void, ExtensionNotFoundError | ExtensionFolderError, Scope.Scope>;
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
  const serverSettings = yield* ServerSettingsService;
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

  const absolutePath = (value: string) =>
    path.isAbsolute(value) ? value : path.resolve(options.cwd, value);

  /** Register one source and start it if it is enabled and readable. */
  const load = Effect.fn("ExtensionSupervisor.load")(function* (
    source: ResolvedExtensionSource & { readonly path: string },
  ) {
    const loaded = yield* readFolder({ path: source.path }).pipe(
      Effect.map((folder) => ({ manifest: folder.manifest, folderHash: folder.hash })),
      Effect.catchTag("ExtensionFolderError", (error) =>
        Effect.succeed({ loadError: error.message }),
      ),
    );
    yield* registry.upsertSource({ ...source, ...loaded });
    if (!source.enabled) return;
    if ("loadError" in loaded) {
      yield* registry.setState({
        name: source.name,
        state: "crashed",
        lastError: loaded.loadError,
      });
      return;
    }
    // Marked before the fiber is forked, so a later "stopped" always means
    // the process ran and exited rather than never having begun — which is
    // what lets readiness treat it as settled.
    yield* registry.setState({ name: source.name, state: "starting" });
    yield* start({ name: source.name, path: source.path });
  });

  const reconcile: ExtensionSupervisorShape["reconcile"] = Effect.fn(
    "ExtensionSupervisor.reconcile",
  )(function* (sources) {
    const known = new Map(
      (yield* registry.list).extensions.map((status) => [status.name, status] as const),
    );
    const desired = sources.map((source) => ({ ...source, path: absolutePath(source.path) }));
    const desiredNames = new Set(desired.map((source) => source.name));

    // Gone from settings: stop it and forget it, so its tool names and HTTP
    // prefix are free again rather than held by a record nothing can start.
    for (const name of known.keys()) {
      if (desiredNames.has(name)) continue;
      yield* stop(name);
      yield* registry.removeSource(name);
    }

    for (const source of desired) {
      const existing = known.get(source.name);
      if (!existing) {
        yield* load(source);
        continue;
      }
      // A moved path is a different extension wearing the same name: the old
      // process is running the wrong folder, so it stops before the new one
      // is read.
      if (existing.path !== source.path) {
        yield* stop(source.name);
        yield* load(source);
        continue;
      }
      if (existing.enabled === source.enabled) {
        // Same folder, same switch — but which source names it can still have
        // changed (a settings entry written over a launch flag at the flag's own
        // folder). That is metadata: record it, restart nothing.
        if (existing.source !== source.source) yield* registry.upsertSource(source);
        continue;
      }
      if (source.enabled) {
        yield* registry.setEnabled({ name: source.name, enabled: true }).pipe(Effect.ignore);
        yield* load(source);
      } else {
        yield* stop(source.name);
        // Carries the source too: disabling a flag-started extension is what
        // writes its settings entry.
        yield* registry.upsertSource(source);
        yield* registry.setState({ name: source.name, state: "disabled" });
      }
    }
    // Only now is the list final, so readiness can start resolving. Before
    // this, an empty registry would look like "nothing to wait for". Safe to
    // repeat: later reconciles find it already resolved.
    yield* registry.markSourcesResolved;
  });

  /**
   * Reconcile against whatever the settings say right now.
   *
   * Launch flags are read from the process config rather than re-derived: they
   * cannot change while the server runs, and a settings entry still wins by
   * name (`ExtensionSources.ts`).
   */
  const reconcileFromSettings = Effect.gen(function* () {
    const stored = yield* serverSettings.getSettings.pipe(
      Effect.map((current) => current.extensions),
      // A settings file this build cannot read is a reason to run no
      // extensions, not a reason to tear down the ones already running.
      Effect.orElseSucceed((): ReadonlyArray<ExtensionSettingsEntry> => []),
    );
    yield* reconcile(
      resolveExtensionSources({
        settingsEntries: stored,
        launchFlags: options.launchFlags ?? [],
      }),
    );
  }).pipe(Effect.withSpan("ExtensionSupervisor.reconcileFromSettings"));

  /**
   * Follow settings for the life of the supervisor, so installing or removing
   * an extension takes effect without a restart.
   *
   * The subscription is acquired before the first reconcile so a change landing
   * between the two is not lost — that is what `subscribeChanges` exists for.
   */
  const watchSettings = Effect.gen(function* () {
    const changes = yield* serverSettings.subscribeChanges;
    yield* reconcileFromSettings;
    yield* Stream.runForEach(changes, () => Effect.scoped(reconcileFromSettings)).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("The extension settings watcher stopped.", { cause }),
      ),
      Effect.forkIn(supervisorScope),
    );
  });

  const install: ExtensionSupervisorShape["install"] = Effect.fn("ExtensionSupervisor.install")(
    function* (input) {
      const resolved = absolutePath(input.path.trim());
      // Read first: the manifest is what supplies the name, and a folder that
      // is not an extension must not leave a settings entry behind.
      const loaded = yield* readFolder({ path: resolved });
      const name = loaded.manifest.name;
      const entries = (yield* serverSettings.getSettings.pipe(Effect.orDie)).extensions;
      if (entries.some((entry) => entry.name === name)) {
        return yield* new ExtensionAlreadyInstalledError({ extensionName: name });
      }
      // A launch flag of the same name is not a conflict: a settings entry wins
      // by name, and overriding a shipped extension with a local build is the
      // documented way to do it. Reconciling picks the new path up.
      // A settings write that fails is an internal fault the caller cannot act
      // on, and the RPC's error union is the admin errors only.
      yield* serverSettings
        .updateSettings({ extensions: [...entries, { name, path: resolved, enabled: true }] })
        .pipe(Effect.orDie);
      yield* reconcileFromSettings;
      return name;
    },
  );

  const remove: ExtensionSupervisorShape["remove"] = Effect.fn("ExtensionSupervisor.remove")(
    function* (input) {
      const status = yield* registry.get(input.name);
      const settings = yield* serverSettings.getSettings.pipe(Effect.orDie);
      // Only a settings entry can be removed. Refused before anything is
      // touched: with no entry, the launch flag names it again on the next
      // reconcile, so the data directory would be deleted from under a process
      // that goes on running.
      if (!settings.extensions.some((entry) => entry.name === input.name)) {
        return yield* new ExtensionNotRemovableError({ extensionName: input.name });
      }
      yield* serverSettings
        .updateSettings({
          extensions: settings.extensions.filter((entry) => entry.name !== input.name),
        })
        .pipe(Effect.orDie);
      // Reconciling is what stops and unregisters it; doing it here rather than
      // waiting for the change stream is what makes the RPC's answer mean the
      // work is done.
      yield* Effect.scoped(reconcileFromSettings);
      if (!input.deleteData) return;
      // Best effort: the extension is already gone from the user's point of
      // view, and a directory that will not delete is not worth failing over.
      yield* fs.remove(path.join(options.dataRoot, status.name), { recursive: true }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not delete the extension's data directory.", {
            name: status.name,
            cause,
          }),
        ),
      );
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

  /**
   * Rewrite this environment's settings entry for `name` and reconcile.
   *
   * When only a launch flag names the extension there is no entry yet, so this
   * writes the overriding one — carrying the current path unless `update`
   * changes it. Reconciling is what acts on the change; doing it here rather
   * than waiting for the settings stream is what makes an RPC's answer mean the
   * work is done.
   */
  const writeEntry = Effect.fn("ExtensionSupervisor.writeEntry")(function* (
    status: { readonly name: ExtensionName; readonly path: string; readonly enabled: boolean },
    update: (entry: ExtensionSettingsEntry) => ExtensionSettingsEntry,
  ) {
    const entries = (yield* serverSettings.getSettings.pipe(Effect.orDie)).extensions;
    const existing = entries.find((entry) => entry.name === status.name);
    const next = update(
      existing ?? { name: status.name, path: status.path, enabled: status.enabled },
    );
    yield* serverSettings
      .updateSettings({
        extensions:
          existing === undefined
            ? [...entries, next]
            : entries.map((entry) => (entry.name === status.name ? next : entry)),
      })
      .pipe(Effect.orDie);
    yield* reconcileFromSettings;
  });

  const setEnabled: ExtensionSupervisorShape["setEnabled"] = Effect.fn(
    "ExtensionSupervisor.setEnabled",
  )(function* (input) {
    const status = yield* registry.get(input.name);
    yield* writeEntry(status, (entry) => ({ ...entry, enabled: input.enabled }));
  });

  const setPath: ExtensionSupervisorShape["setPath"] = Effect.fn("ExtensionSupervisor.setPath")(
    function* (input) {
      const status = yield* registry.get(input.name);
      const resolved = absolutePath(input.path.trim());
      // Read first, as install does: a folder that is not an extension must
      // not replace one that works. The manifest's own name is not compared —
      // the host's name is authoritative (`ExtensionFolderError`'s note).
      yield* readFolder({ path: resolved });
      // The switch the user sees is kept: repointing a disabled extension must
      // not quietly start it.
      yield* writeEntry(status, (entry) => ({ ...entry, path: resolved, enabled: status.enabled }));
    },
  );

  const stopAll: ExtensionSupervisorShape["stopAll"] = Effect.gen(function* () {
    const current = yield* SynchronizedRef.get(running);
    yield* Effect.forEach([...current.keys()], stop, { discard: true });
  });

  return ExtensionSupervisor.of({
    reconcile,
    watchSettings,
    install,
    remove,
    setPath,
    deploy,
    setEnabled,
    refreshFolderHashes,
    stopAll,
  });
});

export const layer = (options: ExtensionSupervisorOptions) =>
  Layer.effect(ExtensionSupervisor, make(options));

export { decodeUtf8 };
