import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as ExtensionFolderWatcher from "./ExtensionFolderWatcher.ts";

/**
 * The real `fs.watch` path, against a real directory.
 *
 * The supervisor's tests drive a fake watcher, so without this the one piece
 * that actually touches the platform would never run. Real time and real files
 * on purpose: platform behaviour is the thing under test.
 */
describe("the node folder watcher", () => {
  /** Completes on the watcher's first tick for `folder`. */
  const firstTick = (folder: string) =>
    Effect.gen(function* () {
      const watcher = yield* ExtensionFolderWatcher.ExtensionFolderWatcher;
      yield* watcher.changes(folder).pipe(Stream.take(1), Stream.runDrain);
    }).pipe(Effect.scoped, Effect.provide(ExtensionFolderWatcher.layer));

  // `it.live`, not `it.effect`: @effect/vitest installs a TestClock for
  // `it.effect`, under which the real sleeps this test needs never advance.
  it.live(
    "ticks when a file nested below the folder is rewritten",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const folder = yield* fs.makeTempDirectoryScoped({ prefix: "folder-watcher-" });
        // Nested, because a build writes into `dist/` and a non-recursive
        // watch would miss it entirely.
        yield* fs.makeDirectory(path.join(folder, "dist"), { recursive: true });
        yield* fs.writeFileString(path.join(folder, "dist/server.js"), "// build 1");

        // Subscribe first, then write: reporting only changes made after the
        // watcher started is the whole point of it.
        const ticked = yield* Effect.forkChild(firstTick(folder));
        yield* Effect.sleep(Duration.millis(200));
        yield* fs.writeFileString(path.join(folder, "dist/server.js"), "// build 2");

        const result = yield* Fiber.await(ticked).pipe(Effect.timeoutOption(Duration.seconds(10)));
        assert.isTrue(Option.isSome(result), "the watcher never reported the write");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    { timeout: 20_000 },
  );
});
