/**
 * Reading a built extension folder: its manifest, and a content hash of
 * everything in it.
 *
 * The folder is the unit of distribution (design §6.1) and the host only ever
 * reads it — it never installs, compiles, or writes there. The folder may be
 * read-only and may sit inside a packaged app bundle; the spike measured the
 * hash as byte-identical across loose, read-only, and in-asar shapes
 * (`docs/internals/extensions/spikes/electron-runtime.md` §3), so nothing here
 * special-cases the packaged layout.
 */
import { ExtensionFolderError, ExtensionManifest, type ExtensionName } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export const EXTENSION_MANIFEST_FILE = "extension.json";

/**
 * Skipped when hashing and when walking. `node_modules` is not merely large:
 * a self-contained entry means it should not be there at all, and hashing one
 * an author left behind would make every install look like a new build.
 */
const IGNORED_ENTRIES = new Set([".git", "node_modules", ".DS_Store"]);

/** How deep the walk goes before it gives up, so a symlink loop cannot hang startup. */
const MAX_DEPTH = 12;

export interface LoadedExtensionFolder {
  readonly path: string;
  readonly manifest: ExtensionManifest;
  readonly hash: string;
}

const decodeManifestJson = Schema.decodeUnknownEffect(Schema.fromJsonString(ExtensionManifest));

const folderError = (
  path: string,
  reason: ExtensionFolderError["reason"],
  input: { readonly extensionName?: ExtensionName; readonly detail?: string } = {},
) =>
  new ExtensionFolderError({
    path,
    reason,
    ...(input.extensionName === undefined ? {} : { extensionName: input.extensionName }),
    ...(input.detail === undefined ? {} : { detail: input.detail.slice(0, 1024) }),
  });

/**
 * Every file under `folder`, relative and sorted, so two machines that hold the
 * same bytes produce the same list regardless of readdir order.
 */
export const listFolderFiles = Effect.fn("ExtensionFolder.listFolderFiles")(function* (
  folder: string,
): Effect.fn.Return<
  ReadonlyArray<string>,
  ExtensionFolderError,
  FileSystem.FileSystem | Path.Path
> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const files: string[] = [];
  const walk = (relative: string, depth: number): Effect.Effect<void, ExtensionFolderError> =>
    Effect.gen(function* () {
      if (depth > MAX_DEPTH) return;
      const absolute = relative === "" ? folder : path.join(folder, relative);
      const entries = yield* fs
        .readDirectory(absolute)
        .pipe(
          Effect.mapError((cause) => folderError(folder, "unreadable", { detail: cause.message })),
        );
      for (const entry of [...entries].sort()) {
        if (IGNORED_ENTRIES.has(entry)) continue;
        const entryRelative = relative === "" ? entry : `${relative}/${entry}`;
        const info = yield* fs
          .stat(path.join(folder, entryRelative))
          .pipe(
            Effect.mapError(() => folderError(folder, "unreadable", { detail: entryRelative })),
          );
        if (info.type === "Directory") {
          yield* walk(entryRelative, depth + 1);
        } else if (info.type === "File") {
          files.push(entryRelative);
        }
      }
    });
  yield* walk("", 0);
  return files;
});

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/**
 * A content hash of the folder: every relative path and the bytes behind it.
 *
 * Deploy is gated on this changing (design §6.3), so it has to notice a rebuild
 * that keeps every filename — the normal case — and must not move when only
 * mtimes do. Files are digested one at a time and the digests folded into a
 * listing, so a large bundle never has to be held in memory twice.
 */
export const hashFolder = Effect.fn("ExtensionFolder.hashFolder")(function* (
  folder: string,
): Effect.fn.Return<
  string,
  ExtensionFolderError,
  Crypto.Crypto | FileSystem.FileSystem | Path.Path
> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const files = yield* listFolderFiles(folder);
  const lines: string[] = [];
  for (const relative of files) {
    const contents = yield* fs
      .readFile(path.join(folder, relative))
      .pipe(Effect.mapError(() => folderError(folder, "unreadable", { detail: relative })));
    const digest = yield* crypto
      .digest("SHA-256", contents)
      .pipe(Effect.mapError(() => folderError(folder, "unreadable", { detail: relative })));
    lines.push(`${relative}\u0000${toHex(digest)}`);
  }
  const listing = yield* crypto
    .digest("SHA-256", new TextEncoder().encode(lines.join("\n")))
    .pipe(Effect.mapError(() => folderError(folder, "unreadable")));
  return toHex(listing).slice(0, 32);
});

/**
 * Read and validate one folder.
 *
 * The manifest's `name` is recorded but not enforced against the name the host
 * installed the folder under: the host's name is authoritative (it is what
 * `T3_EXT_NAME` carries), so one built folder can be installed more than once.
 */
export const loadFolder = Effect.fn("ExtensionFolder.loadFolder")(function* (input: {
  readonly path: string;
}): Effect.fn.Return<
  LoadedExtensionFolder,
  ExtensionFolderError,
  Crypto.Crypto | FileSystem.FileSystem | Path.Path
> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const folder = input.path;
  const exists = yield* fs.exists(folder).pipe(Effect.orElseSucceed(() => false));
  if (!exists) return yield* folderError(folder, "missing");
  const manifestPath = path.join(folder, EXTENSION_MANIFEST_FILE);
  const raw = yield* fs.readFileString(manifestPath).pipe(
    Effect.mapError(() =>
      folderError(folder, "invalid-manifest", {
        detail: `${EXTENSION_MANIFEST_FILE} is missing`,
      }),
    ),
  );
  const manifest = yield* decodeManifestJson(raw).pipe(
    Effect.mapError((issue) => folderError(folder, "invalid-manifest", { detail: issue.message })),
  );
  const entryExists = yield* fs
    .exists(path.join(folder, manifest.server.entry))
    .pipe(Effect.orElseSucceed(() => false));
  if (!entryExists) {
    return yield* folderError(folder, "invalid-manifest", {
      extensionName: manifest.name,
      detail: `server entry ${manifest.server.entry} does not exist`,
    });
  }
  const hash = yield* hashFolder(folder);
  return { path: folder, manifest, hash };
});
