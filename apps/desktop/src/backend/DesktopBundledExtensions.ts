/**
 * Extensions the desktop build ships, handed to the server as launch flags.
 *
 * There is no "bundled" concept in the server (design §6.2): a shipped
 * extension is just a folder the desktop names with `--extension name=path`,
 * exactly as a developer would on the command line. That is what makes it
 * overridable — a settings entry of the same name wins, so pointing `bach` at
 * a local build, or disabling it, needs no desktop change.
 *
 * The folder ships as `extraResources` rather than inside `app.asar`: a path
 * inside an asar cannot be a process `cwd`, and the server spawns each
 * extension in its own folder
 * (`docs/internals/extensions/spikes/electron-runtime.md` §3).
 */
import { EXTENSION_MANIFEST_FILE, ExtensionName } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

/** The directory name looked for beside `resource-monitor`. */
export const BUNDLED_EXTENSIONS_DIR = "extensions";

export interface BundledExtension {
  readonly name: ExtensionName;
  readonly path: string;
}

const isExtensionName = Schema.is(ExtensionName);

/**
 * Every immediate subfolder of `root` that carries a manifest, sorted by name
 * so the launch flags — and therefore the server's start order, which settles
 * tool-name collisions — do not depend on readdir order.
 *
 * A folder is skipped rather than reported when it has no manifest or its name
 * is not an extension identifier: the shipped set is decided at build time, so
 * anything unreadable here is a packaging mistake, not something a user can
 * fix by being told about it at every launch.
 */
export const readBundledExtensions = Effect.fn("desktop.readBundledExtensions")(function* (input: {
  readonly root: string;
  readonly join: (...segments: ReadonlyArray<string>) => string;
}): Effect.fn.Return<ReadonlyArray<BundledExtension>, never, FileSystem.FileSystem> {
  const fileSystem = yield* FileSystem.FileSystem;
  const entries = yield* fileSystem
    .readDirectory(input.root)
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  const found: Array<BundledExtension> = [];
  for (const entry of [...entries].sort()) {
    if (!isExtensionName(entry)) continue;
    const folder = input.join(input.root, entry);
    const manifest = input.join(folder, EXTENSION_MANIFEST_FILE);
    const hasManifest = yield* fileSystem.exists(manifest).pipe(Effect.orElseSucceed(() => false));
    if (!hasManifest) continue;
    found.push({ name: entry, path: folder });
  }
  return found;
});

/** `--extension name=path` per folder, in the order they will be started. */
export const bundledExtensionArgs = (
  extensions: ReadonlyArray<BundledExtension>,
): ReadonlyArray<string> =>
  extensions.flatMap((extension) => ["--extension", `${extension.name}=${extension.path}`]);
