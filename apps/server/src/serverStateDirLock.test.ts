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
  processStartTime,
  removeLockIfUnchanged,
  SERVER_STATE_DIR_LOCK_FILE,
  ServerStateDirHeldError,
  type ServerStateDirLockProbe,
} from "./serverStateDirLock.ts";

const isHeldError = Schema.is(ServerStateDirHeldError);

const OTHER_PID = 424_242;
const HOLDER_START = "Tue Sep 22 10:00:00 2026";

/**
 * A machine running exactly the pids in `running`, each with the start time
 * given there. `alive` can be swapped for a function to make a process exit.
 */
const probe = (
  pid: number,
  running: Readonly<Record<number, string | null>>,
  alive: (candidate: number) => boolean = (candidate) => candidate in running,
): ServerStateDirLockProbe => ({
  pid,
  isProcessAlive: alive,
  processStartTime: (candidate) => running[candidate] ?? null,
});

const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-state-dir-lock-test-" });
  const lockPath = path.join(stateDir, SERVER_STATE_DIR_LOCK_FILE);
  const runtimeStatePath = path.join(stateDir, "server-runtime.json");
  const writeHolder = (holder: { readonly pid: number; readonly processStart: string | null }) =>
    fs.writeFileString(
      lockPath,
      JSON.stringify({ version: 1, ...holder, startedAt: "2026-09-22T00:00:00.000Z" }),
    );
  const acquire = (lockProbe: ServerStateDirLockProbe, holderGrace = Duration.zero) =>
    acquireServerStateDirLock({ stateDir, runtimeStatePath, probe: lockProbe, holderGrace });
  const readHolderPid = fs
    .readFileString(lockPath)
    .pipe(Effect.map((raw) => (JSON.parse(raw) as { pid: number }).pid));
  return { fs, stateDir, lockPath, runtimeStatePath, writeHolder, acquire, readHolderPid };
});

describe("acquireServerStateDirLock", () => {
  it.effect("takes a free directory, leaves no staging file, and releases with the scope", () =>
    Effect.gen(function* () {
      const { fs, stateDir, lockPath, acquire, readHolderPid } = yield* setup;
      const scope = yield* Scope.make();

      yield* acquire(probe(100, { 100: "start-100" })).pipe(Scope.provide(scope));
      assert.equal(yield* readHolderPid, 100);
      assert.deepEqual(yield* fs.readDirectory(stateDir), [SERVER_STATE_DIR_LOCK_FILE]);

      yield* Scope.close(scope, Exit.void);
      assert.isFalse(yield* fs.exists(lockPath));
      assert.deepEqual(yield* fs.readDirectory(stateDir), []);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses while the process that wrote it runs, naming its pid and port", () =>
    Effect.gen(function* () {
      const { stateDir, runtimeStatePath, writeHolder, acquire, readHolderPid } = yield* setup;
      yield* writeHolder({ pid: OTHER_PID, processStart: HOLDER_START });
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

      const error = yield* acquire(
        probe(200, { 200: "start-200", [OTHER_PID]: HOLDER_START }),
      ).pipe(Effect.scoped, Effect.flip);

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
      yield* writeHolder({ pid: OTHER_PID, processStart: HOLDER_START });

      yield* acquire(probe(300, { 300: "start-300" }));

      assert.equal(yield* readHolderPid, 300);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("takes over a lock whose pid now belongs to a different process", () =>
    Effect.gen(function* () {
      const { writeHolder, acquire, readHolderPid } = yield* setup;
      yield* writeHolder({ pid: OTHER_PID, processStart: HOLDER_START });

      // The pid runs, but it was started after the lock was written.
      yield* acquire(probe(400, { 400: "start-400", [OTHER_PID]: "Wed Sep 23 09:00:00 2026" }));

      assert.equal(yield* readHolderPid, 400);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("fails open when the holder's start time cannot be read", () =>
    Effect.gen(function* () {
      const { writeHolder, acquire, readHolderPid } = yield* setup;
      yield* writeHolder({ pid: OTHER_PID, processStart: HOLDER_START });

      yield* acquire(probe(410, { 410: "start-410", [OTHER_PID]: null }));

      assert.equal(yield* readHolderPid, 410);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("fails open on a lock that recorded no start time", () =>
    Effect.gen(function* () {
      const { writeHolder, acquire, readHolderPid } = yield* setup;
      yield* writeHolder({ pid: OTHER_PID, processStart: null });

      yield* acquire(probe(420, { 420: "start-420", [OTHER_PID]: HOLDER_START }));

      assert.equal(yield* readHolderPid, 420);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("takes over a lock carrying its own pid", () =>
    Effect.gen(function* () {
      const { writeHolder, acquire, readHolderPid } = yield* setup;
      // Left by an earlier process that had this pid; this process is alive
      // and its start time even matches, but it cannot be its own rival.
      yield* writeHolder({ pid: 430, processStart: "start-430" });

      yield* acquire(probe(430, { 430: "start-430" }));

      assert.equal(yield* readHolderPid, 430);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("takes over an unreadable lock", () =>
    Effect.gen(function* () {
      const { fs, lockPath, acquire, readHolderPid } = yield* setup;
      yield* fs.writeFileString(lockPath, "");

      yield* acquire(probe(500, { 500: "start-500" }));

      assert.equal(yield* readHolderPid, 500);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("acquires once the holder exits during the grace period", () =>
    Effect.gen(function* () {
      const { writeHolder, acquire, readHolderPid } = yield* setup;
      yield* writeHolder({ pid: OTHER_PID, processStart: HOLDER_START });
      // Alive for the first check, gone by the next poll.
      let checks = 0;
      const alive = (candidate: number) =>
        candidate === 600 || (candidate === OTHER_PID && (checks += 1) === 1);

      yield* acquire(
        probe(600, { 600: "start-600", [OTHER_PID]: HOLDER_START }, alive),
        Duration.seconds(5),
      );

      assert.equal(yield* readHolderPid, 600);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("does not remove a lock another server took over from it", () =>
    Effect.gen(function* () {
      const { fs, lockPath, writeHolder, acquire, readHolderPid } = yield* setup;
      const scope = yield* Scope.make();
      yield* acquire(probe(700, { 700: "start-700" })).pipe(Scope.provide(scope));

      // Some other server decided this one was gone and replaced the lock.
      yield* writeHolder({ pid: OTHER_PID, processStart: HOLDER_START });
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
        probe: probe(800, { 800: "start-800" }),
        holderGrace: Duration.zero,
      });

      assert.isFalse(yield* fs.exists(missing));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("removeLockIfUnchanged", () => {
  it.effect("removes the lock it read and leaves one that has since been replaced", () =>
    Effect.gen(function* () {
      const { fs, stateDir, lockPath } = yield* setup;
      yield* fs.writeFileString(lockPath, "stale");
      assert.isTrue(yield* removeLockIfUnchanged(lockPath, "stale"));
      assert.isFalse(yield* fs.exists(lockPath));

      // Read as stale, but a fresh lock landed before the removal.
      yield* fs.writeFileString(lockPath, "fresh");
      assert.isFalse(yield* removeLockIfUnchanged(lockPath, "stale"));
      assert.equal(yield* fs.readFileString(lockPath), "fresh");
      assert.deepEqual(yield* fs.readDirectory(stateDir), [SERVER_STATE_DIR_LOCK_FILE]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("processStartTime", () => {
  // Where `ps` exists at all; elsewhere every read is `null` and the lock fails open.
  it.skipIf(processStartTime(process.pid) === null)(
    "reads this process's start time the same way twice, and nothing for a dead pid",
    () => {
      const first = processStartTime(process.pid);
      assert.isNotNull(first);
      assert.equal(processStartTime(process.pid), first);
      assert.isNull(processStartTime(2 ** 22 + 12_345));
    },
  );
});
