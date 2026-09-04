// @effect-diagnostics preferSchemaOverJson:off - fixtures write manifests as raw JSON, including invalid ones.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { EXTENSION_PROTOCOL_VERSION } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";

import { hashFolder, loadFolder } from "./ExtensionFolder.ts";

const manifest = {
  name: "bach",
  version: "1.0.0",
  protocolVersion: EXTENSION_PROTOCOL_VERSION,
  server: { entry: "dist/server.js" },
};

/** A built folder on disk, torn down with the test's scope. */
const makeFolder = Effect.fn("test.makeFolder")(function* (
  overrides: Partial<typeof manifest> & { readonly entryContents?: string } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const folder = yield* fs.makeTempDirectoryScoped({ prefix: "extension-folder-" });
  const { entryContents, ...manifestOverrides } = overrides;
  const written = { ...manifest, ...manifestOverrides };
  yield* fs.writeFileString(path.join(folder, "extension.json"), JSON.stringify(written));
  yield* fs.makeDirectory(path.join(folder, "dist"), { recursive: true });
  yield* fs.writeFileString(
    path.join(folder, written.server.entry),
    entryContents ?? "console.log('hi')",
  );
  return folder;
});

const run = <A, E>(
  effect: Effect.Effect<A, E, Crypto.Crypto | FileSystem.FileSystem | Path.Path | Scope.Scope>,
) => Effect.scoped(effect).pipe(Effect.provide(NodeServices.layer));

describe("loadFolder", () => {
  it.effect("reads the manifest and hashes the folder", () =>
    run(
      Effect.gen(function* () {
        const folder = yield* makeFolder();
        const loaded = yield* loadFolder({ path: folder });
        expect(loaded.manifest.name).toBe("bach");
        expect(loaded.manifest.server.entry).toBe("dist/server.js");
        expect(loaded.hash).toMatch(/^[0-9a-f]{32}$/);
      }),
    ),
  );

  it.effect("records whatever name the manifest carries, because the host's name wins", () =>
    run(
      Effect.gen(function* () {
        const folder = yield* makeFolder({ name: "notes" });
        const loaded = yield* loadFolder({ path: folder });
        expect(loaded.manifest.name).toBe("notes");
      }),
    ),
  );

  it.effect("refuses a folder whose declared entry is not there", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const folder = yield* makeFolder();
        yield* fs.remove(path.join(folder, "dist/server.js"));
        const error = yield* loadFolder({ path: folder }).pipe(Effect.flip);
        expect(error.reason).toBe("invalid-manifest");
        expect(error.detail).toContain("dist/server.js");
      }),
    ),
  );

  it.effect("reports a missing folder as missing, not as a bad manifest", () =>
    run(
      Effect.gen(function* () {
        const error = yield* loadFolder({ path: "/nonexistent/extension" }).pipe(Effect.flip);
        expect(error.reason).toBe("missing");
      }),
    ),
  );

  it.effect("rejects a manifest the protocol schema does not accept", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const folder = yield* makeFolder();
        yield* fs.writeFileString(
          path.join(folder, "extension.json"),
          JSON.stringify({ ...manifest, server: { entry: "../escape.js" } }),
        );
        const error = yield* loadFolder({ path: folder }).pipe(Effect.flip);
        expect(error.reason).toBe("invalid-manifest");
      }),
    ),
  );
});

describe("hashFolder", () => {
  it.effect("moves when a file's contents change and not when only its mtime does", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const folder = yield* makeFolder();
        const before = yield* hashFolder(folder);
        yield* fs.writeFileString(path.join(folder, "dist/server.js"), "console.log('hi')");
        expect(yield* hashFolder(folder)).toBe(before);
        yield* fs.writeFileString(path.join(folder, "dist/server.js"), "console.log('rebuilt')");
        expect(yield* hashFolder(folder)).not.toBe(before);
      }),
    ),
  );

  it.effect("notices a file that was added or removed", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const folder = yield* makeFolder();
        const before = yield* hashFolder(folder);
        yield* fs.writeFileString(path.join(folder, "dist/extra.js"), "");
        const withExtra = yield* hashFolder(folder);
        expect(withExtra).not.toBe(before);
        yield* fs.remove(path.join(folder, "dist/extra.js"));
        expect(yield* hashFolder(folder)).toBe(before);
      }),
    ),
  );

  it.effect("ignores node_modules, which a self-contained build should not have", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const folder = yield* makeFolder();
        const before = yield* hashFolder(folder);
        yield* fs.makeDirectory(path.join(folder, "node_modules/left-pad"), { recursive: true });
        yield* fs.writeFileString(path.join(folder, "node_modules/left-pad/index.js"), "x");
        expect(yield* hashFolder(folder)).toBe(before);
      }),
    ),
  );
});
