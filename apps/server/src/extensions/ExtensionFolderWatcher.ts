/**
 * Watching an extension's built folder so a finished build announces itself.
 *
 * Design §6.3 wants the Deploy affordance to light up on its own: an agent
 * rebuilds, and the nav entry says so without anyone opening Settings. That
 * needs something watching the folder, because the folder hash is otherwise
 * only read when a process starts.
 *
 * A service rather than a direct `node:fs` call so the supervisor's tests can
 * drive changes without a real filesystem, and so the platform's awkwardness
 * lives in one place. `FileSystem.watch` from Effect is not usable here: it is
 * declared on the interface but the Node layer does not implement it, so it
 * fails with "not found" at runtime.
 *
 * Emits a bare tick, not a description of what changed. The hash is the source
 * of truth for whether anything actually moved, so the event only has to say
 * "look again" — which is also what keeps the polling fallback honest.
 */
// @effect-diagnostics nodeBuiltinImport:off - Node's watcher is the thing being wrapped.
import * as NodeFS from "node:fs";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

/** How often the fallback looks, when the platform has no recursive watch. */
export const FOLDER_POLL_INTERVAL = Duration.seconds(10);

export interface ExtensionFolderWatcherShape {
  /**
   * Ticks whenever anything under `path` may have changed.
   *
   * May tick spuriously — an editor writing a temp file, a poll firing on an
   * unchanged folder. Callers re-hash and compare, so a false tick costs one
   * hash and changes nothing.
   */
  readonly changes: (path: string) => Stream.Stream<void>;
}

export class ExtensionFolderWatcher extends Context.Service<
  ExtensionFolderWatcher,
  ExtensionFolderWatcherShape
>()("t3/extensions/ExtensionFolderWatcher") {}

/**
 * `fs.watch` with `recursive: true`, falling back to polling.
 *
 * Recursive watching is native on macOS and Windows and has been supported on
 * Linux since Node 20, but it is still the one option here that can throw
 * `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` — on some network and container
 * filesystems it is simply absent. Falling back to a slow poll keeps the
 * affordance working there instead of silently never firing.
 */
const nodeChanges = (path: string): Stream.Stream<void> =>
  Stream.unwrap(
    Effect.sync(() => {
      try {
        // Opened eagerly so an unsupported platform throws here, where the
        // fallback can catch it, rather than inside the stream's scope.
        const watcher = NodeFS.watch(path, { recursive: true, persistent: false });
        return Stream.callback<void>((queue) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              watcher.on("change", () => Queue.offerUnsafe(queue, undefined));
              // A watcher that dies later — the folder was removed, handles ran
              // out — must not take the supervisor with it. One last tick makes
              // the next hash read the truth.
              watcher.on("error", () => Queue.offerUnsafe(queue, undefined));
              return watcher;
            }),
            () => Effect.sync(() => watcher.close()),
          ),
        );
      } catch {
        // No recursive watch here. Poll instead, slowly.
        return Stream.tick(FOLDER_POLL_INTERVAL);
      }
    }),
  );

export const layer: Layer.Layer<ExtensionFolderWatcher> = Layer.succeed(ExtensionFolderWatcher)(
  ExtensionFolderWatcher.of({ changes: nodeChanges }),
);

/** Never ticks. For tests and for any host that would rather not watch. */
export const layerNever: Layer.Layer<ExtensionFolderWatcher> = Layer.succeed(
  ExtensionFolderWatcher,
)(ExtensionFolderWatcher.of({ changes: () => Stream.never }));
