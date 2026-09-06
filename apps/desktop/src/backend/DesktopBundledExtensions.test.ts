// @effect-diagnostics preferSchemaOverJson:off - fixtures write manifests as raw JSON.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";

import { bundledExtensionArgs, readBundledExtensions } from "./DesktopBundledExtensions.ts";

const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>) =>
  Effect.scoped(effect).pipe(Effect.provide(NodeServices.layer));

/** A resources directory with one folder per named extension. */
const makeResourcesDir = Effect.fn("test.makeResourcesDir")(function* (
  folders: ReadonlyArray<{ readonly name: string; readonly manifest?: boolean }>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "bundled-extensions-" });
  for (const folder of folders) {
    const dir = path.join(root, folder.name);
    yield* fs.makeDirectory(dir, { recursive: true });
    if (folder.manifest !== false) {
      yield* fs.writeFileString(
        path.join(dir, "extension.json"),
        JSON.stringify({
          name: folder.name,
          version: "1.0.0",
          protocolVersion: 1,
          server: { entry: "dist/server.js" },
        }),
      );
    }
  }
  return { root, join: path.join };
});

describe("readBundledExtensions", () => {
  it.effect("finds every folder that carries a manifest", () =>
    run(
      Effect.gen(function* () {
        const dir = yield* makeResourcesDir([{ name: "bach" }, { name: "notes" }]);
        expect(yield* readBundledExtensions(dir)).toStrictEqual([
          { name: "bach", path: dir.join(dir.root, "bach") },
          { name: "notes", path: dir.join(dir.root, "notes") },
        ]);
      }),
    ),
  );

  it.effect("returns them sorted, so start order does not depend on readdir", () =>
    run(
      Effect.gen(function* () {
        const dir = yield* makeResourcesDir([
          { name: "zeta" },
          { name: "alpha" },
          { name: "middle" },
        ]);
        expect((yield* readBundledExtensions(dir)).map((entry) => entry.name)).toStrictEqual([
          "alpha",
          "middle",
          "zeta",
        ]);
      }),
    ),
  );

  it.effect("skips a folder with no manifest rather than shipping it as an extension", () =>
    run(
      Effect.gen(function* () {
        const dir = yield* makeResourcesDir([
          { name: "bach" },
          { name: "leftovers", manifest: false },
        ]);
        expect((yield* readBundledExtensions(dir)).map((entry) => entry.name)).toStrictEqual([
          "bach",
        ]);
      }),
    ),
  );

  it.effect("skips a folder whose name is not an extension identifier", () =>
    run(
      Effect.gen(function* () {
        const dir = yield* makeResourcesDir([{ name: "Bach" }, { name: "bach_1" }]);
        expect(yield* readBundledExtensions(dir)).toStrictEqual([]);
      }),
    ),
  );

  it.effect("treats a missing resources directory as nothing bundled", () =>
    run(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        expect(
          yield* readBundledExtensions({ root: "/nonexistent/extensions", join: path.join }),
        ).toStrictEqual([]);
      }),
    ),
  );
});

describe("bundledExtensionArgs", () => {
  it("emits one --extension flag per folder, in order", () => {
    expect(
      bundledExtensionArgs([
        { name: "bach", path: "/Applications/T3.app/Contents/Resources/extensions/bach" },
        { name: "notes", path: "/Applications/T3.app/Contents/Resources/extensions/notes" },
      ]),
    ).toStrictEqual([
      "--extension",
      "bach=/Applications/T3.app/Contents/Resources/extensions/bach",
      "--extension",
      "notes=/Applications/T3.app/Contents/Resources/extensions/notes",
    ]);
  });

  it("emits nothing when a build ships no extensions", () => {
    expect(bundledExtensionArgs([])).toStrictEqual([]);
  });
});
