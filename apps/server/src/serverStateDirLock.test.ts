import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import { persistServerRuntimeState } from "./serverRuntimeState.ts";
import {
  acquireServerStateDirLock,
  SERVER_STATE_DIR_LOCK_FILE,
  ServerStateDirHeldError,
  type ServerStateDirLockProbe,
} from "./serverStateDirLock.ts";

const isHeldError = Schema.is(ServerStateDirHeldError);

const BOOT_TIME = 1_700_000_000_000;
const OTHER_PID = 424_242;

/** A machine where exactly the listed pids are running, booted at `BOOT_TIME`. */
const probe = (pid: number, alive: ReadonlyArray<number>): ServerStateDirLockProbe => ({
  pid,
  isProcessAlive: (candidate) => alive.includes(candidate),
  bootTime: Effect.succeed(BOOT_TIME),
});

const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-state-dir-lock-test-" });
  const lockPath = path.join(stateDir, SERVER_STATE_DIR_LOCK_FILE);
  const runtimeStatePath = path.join(stateDir, "server-runtime.json");
  const writeHolder = (holder: { readonly pid: number; readonly bootTime: number }) =>
    fs.writeFileString(
      lockPath,
      JSON.stringify({ version: 1, ...holder, startedAt: "2026-09-22T00:00:00.000Z" }),
    );
  const acquire = (lockProbe: ServerStateDirLockProbe) =>
    acquireServerStateDirLock({
      stateDir,
      runtimeStatePath,
      probe: lockProbe,
      holderGrace: Duration.zero,
    });
  const readHolderPid = fs
    .readFileString(lockPath)
    .pipe(Effect.map((raw) => (JSON.parse(raw) as { pid: number }).pid));
  return { fs, stateDir, lockPath, runtimeStatePath, writeHolder, acquire, readHolderPid };
});

describe("acquireServerStateDirLock", () => {
  it.effect("takes a free directory and releases it with the scope", () =>
    Effect.gen(function* () {
      const { fs, lockPath, acquire, readHolderPid } = yield* setup;
      const scope = yield* Scope.make();

      yield* acquire(probe(100, [100])).pipe(Scope.provide(scope));
      assert.equal(yield* readHolderPid, 100);

      yield* Scope.close(scope, Exit.void);
      assert.isFalse(yield* fs.exists(lockPath));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses while a live server holds it, naming its pid and port", () =>
    Effect.gen(function* () {
      const { stateDir, runtimeStatePath, writeHolder, acquire, readHolderPid } = yield* setup;
      yield* writeHolder({ pid: OTHER_PID, bootTime: BOOT_TIME });
      yield* persistServerRuntimeState({
        path: runtimeStatePath,
        state: {
          version: 1,
          pid: OTHER_PID,
          port: 3773,
          origin: "http://127.0.0.1:3773",
          startedAt: "2026-09-22T00:00:00.000Z",
        },
      });

      const error = yield* acquire(probe(200, [200, OTHER_PID])).pipe(Effect.scoped, Effect.flip);

      assert.isTrue(isHeldError(error));
      assert.equal(error.pid, OTHER_PID);
      assert.equal(error.port, 3773);
      assert.include(error.message, stateDir);
      assert.include(error.message, `pid ${OTHER_PID}, port 3773`);
      // The holder's lock is left exactly as it was.
      assert.equal(yield* readHolderPid, OTHER_PID);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("takes over a lock whose holder has died", () =>
    Effect.gen(function* () {
      const { writeHolder, acquire, readHolderPid } = yield* setup;
      yield* writeHolder({ pid: OTHER_PID, bootTime: BOOT_TIME });

      yield* acquire(probe(300, [300]));

      assert.equal(yield* readHolderPid, 300);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("takes over a lock from an earlier boot even if its pid is running again", () =>
    Effect.gen(function* () {
      const { writeHolder, acquire, readHolderPid } = yield* setup;
      yield* writeHolder({ pid: OTHER_PID, bootTime: BOOT_TIME - Duration.toMillis("1 day") });

      yield* acquire(probe(400, [400, OTHER_PID]));

      assert.equal(yield* readHolderPid, 400);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("takes over an unreadable lock", () =>
    Effect.gen(function* () {
      const { fs, lockPath, acquire, readHolderPid } = yield* setup;
      yield* fs.writeFileString(lockPath, "");

      yield* acquire(probe(500, [500]));

      assert.equal(yield* readHolderPid, 500);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("does not remove a lock another server took over from it", () =>
    Effect.gen(function* () {
      const { fs, lockPath, writeHolder, acquire, readHolderPid } = yield* setup;
      const scope = yield* Scope.make();
      yield* acquire(probe(600, [600])).pipe(Scope.provide(scope));

      // Some other server decided this one was gone and replaced the lock.
      yield* writeHolder({ pid: OTHER_PID, bootTime: BOOT_TIME });
      yield* Scope.close(scope, Exit.void);

      assert.isTrue(yield* fs.exists(lockPath));
      assert.equal(yield* readHolderPid, OTHER_PID);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("starts without the lock when the directory cannot hold one", () =>
    Effect.gen(function* () {
      const { fs, stateDir, runtimeStatePath } = yield* setup;
      const missing = `${stateDir}/does-not-exist`;

      yield* acquireServerStateDirLock({
        stateDir: missing,
        runtimeStatePath,
        probe: probe(700, [700]),
        holderGrace: Duration.zero,
      });

      assert.isFalse(yield* fs.exists(missing));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
