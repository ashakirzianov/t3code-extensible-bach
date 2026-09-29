// @effect-diagnostics nodeBuiltinImport:off - one synchronous `ps` at startup.
import * as NodeChildProcess from "node:child_process";

import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Random from "effect/Random";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import { isProcessAlive, readPersistedServerRuntimeState } from "./serverRuntimeState.ts";

/**
 * One server per state directory.
 *
 * Two servers on the same `state.sqlite` both run — SQLite's WAL lets them —
 * and each projects its own view of a database the other is writing. That is
 * how an app that never fully quit left a server on one port while the next
 * launch started another on the next port, and the client rendered an empty
 * world from the stale side. The lock turns that into a refusal that names the
 * holder.
 *
 * It is a file holding the owner's pid and process start time, not an OS lock
 * (Node has none), so a crash — or the desktop killing a slow server — leaves
 * it behind, and that is routine. A lock is therefore honoured only while its
 * owner is demonstrably the same process that wrote it: not this process's own
 * pid, and a pid that is alive *with the start time the lock recorded*. A pid
 * reused by anything else has a different start time. When the start time
 * cannot be read at all (no `ps`, Windows), the lock fails open. Anything else
 * that goes wrong with it is logged and startup continues without it: the lock
 * guards against a rare accident and must never become one.
 */

export const SERVER_STATE_DIR_LOCK_FILE = "server.lock";

const LockContents = Schema.Struct({
  version: Schema.Literal(1),
  pid: Schema.Int,
  /**
   * The owner's start time as `processStartTime` reads it, compared verbatim.
   * `null` when it could not be read, which no reader can verify.
   */
  processStart: Schema.NullOr(Schema.String),
  startedAt: Schema.String,
});
type LockContents = typeof LockContents.Type;

const decodeLockContents = Schema.decodeUnknownEffect(Schema.fromJsonString(LockContents));
const encodeLockContents = Schema.encodeEffect(Schema.fromJsonString(LockContents));

export class ServerStateDirHeldError extends Schema.TaggedError<ServerStateDirHeldError>()(
  "ServerStateDirHeldError",
  {
    stateDir: Schema.String,
    lockPath: Schema.String,
    pid: Schema.Int,
    port: Schema.optional(Schema.Int),
  },
) {
  override get message(): string {
    const holder =
      this.port === undefined ? `pid ${this.pid}` : `pid ${this.pid}, port ${this.port}`;
    return (
      `Another T3 Code server (${holder}) is already using ${this.stateDir}. ` +
      `Quit it or end process ${this.pid}, then start again. ` +
      `If process ${this.pid} is not a T3 Code server, delete ${this.lockPath}.`
    );
  }
}

/**
 * A process's start time as `ps` prints it — pinned to the C locale and UTC so
 * the writer and a later reader render the same instant identically — or
 * `null` when it cannot be read: no such process, no `ps`, or Windows.
 */
export const processStartTime = (pid: number): string | null => {
  if (process.platform === "win32") return null;
  try {
    const output = NodeChildProcess.execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    }).trim();
    return output === "" ? null : output;
  } catch {
    return null;
  }
};

/** What the lock asks of the machine; replaced in tests. */
export interface ServerStateDirLockProbe {
  readonly pid: number;
  readonly isProcessAlive: (pid: number) => boolean;
  readonly processStartTime: (pid: number) => string | null;
}

const defaultProbe: ServerStateDirLockProbe = {
  pid: process.pid,
  isProcessAlive,
  processStartTime,
};

/** How long a live holder gets to finish exiting, e.g. during an app relaunch. */
const DEFAULT_HOLDER_GRACE = Duration.seconds(5);
const HOLDER_POLL_INTERVAL = Duration.millis(250);

type AttemptResult =
  | { readonly _tag: "Acquired"; readonly contents: string }
  | { readonly _tag: "Held"; readonly holder: LockContents }
  | { readonly _tag: "Stale" };

/** A sibling of the lock no other writer can pick, for staging and takeover. */
const siblingPath = Effect.fn("serverStateDirLock.siblingPath")(function* (
  lockPath: string,
  purpose: "new" | "stale",
) {
  const nonce = yield* Random.nextIntBetween(0, 2 ** 31 - 1);
  return `${lockPath}.${purpose}.${process.pid}.${nonce}`;
});

/**
 * Remove the lock only if it still holds exactly `expected`.
 *
 * Re-reading and then removing would leave a window in which another server
 * replaces a stale lock with its own fresh one and this removes *that*. So the
 * file is first moved aside — an atomic step that takes whatever is there at
 * that instant — and only then checked: the stale lock is deleted, and anything
 * else is linked back into place. Returns whether it removed the lock.
 */
export const removeLockIfUnchanged = Effect.fn("serverStateDirLock.removeLockIfUnchanged")(
  function* (lockPath: string, expected: string) {
    const fs = yield* FileSystem.FileSystem;
    const aside = yield* siblingPath(lockPath, "stale");
    const moved = yield* fs.rename(lockPath, aside).pipe(
      Effect.as(true),
      // Already gone: whoever held it released it, which is what we wanted.
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeed(false),
      ),
    );
    if (!moved) return false;
    const current = yield* fs.readFileString(aside).pipe(Effect.orElseSucceed(() => null));
    if (current !== expected) {
      // Someone else's lock. Put it back unless yet another one has appeared.
      yield* fs.link(aside, lockPath).pipe(Effect.ignore);
    }
    yield* fs.remove(aside, { force: true }).pipe(Effect.ignore);
    return current === expected;
  },
);

/**
 * Take the state directory's lock for the life of the current scope, or fail
 * with `ServerStateDirHeldError` when a live server holds it.
 */
export const acquireServerStateDirLock = Effect.fn("acquireServerStateDirLock")(function* (input: {
  readonly stateDir: string;
  readonly runtimeStatePath: string;
  readonly probe?: ServerStateDirLockProbe;
  readonly holderGrace?: Duration.Duration;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const probe = input.probe ?? defaultProbe;
  const lockPath = path.join(input.stateDir, SERVER_STATE_DIR_LOCK_FILE);

  /** Whether the lock's writer is the process running under its pid now. */
  const isLive = Effect.fn("serverStateDirLock.isLive")(function* (holder: LockContents) {
    if (holder.pid === probe.pid) return false;
    if (!probe.isProcessAlive(holder.pid)) return false;
    const running = probe.processStartTime(holder.pid);
    if (holder.processStart === null || running === null) {
      yield* Effect.logWarning("Cannot verify the server lock's holder; ignoring the lock.", {
        lockPath,
        pid: holder.pid,
      });
      return false;
    }
    return running === holder.processStart;
  });

  const contents = yield* encodeLockContents({
    version: 1,
    pid: probe.pid,
    processStart: probe.processStartTime(probe.pid),
    startedAt: DateTime.formatIso(yield* DateTime.now),
  }).pipe(Effect.orDie);

  // Staged in a sibling and hard-linked into place: the link either creates the
  // lock with its contents already in it or fails because one exists, so no
  // reader ever sees a lock that is empty because its writer is mid-write.
  const create = Effect.gen(function* () {
    const staged = yield* siblingPath(lockPath, "new");
    yield* fs.writeFileString(staged, contents, { flag: "wx" });
    return yield* fs.link(staged, lockPath).pipe(
      Effect.as(true),
      Effect.catchIf(
        (error) => error.reason._tag === "AlreadyExists",
        () => Effect.succeed(false),
      ),
      Effect.ensuring(fs.remove(staged, { force: true }).pipe(Effect.ignore)),
    );
  });

  const attempt = Effect.gen(function* (): Effect.fn.Return<
    AttemptResult,
    PlatformError.PlatformError
  > {
    if (yield* create) return { _tag: "Acquired", contents } as const;

    const existing = yield* fs.readFileString(lockPath).pipe(
      Effect.asSome,
      // Gone between the create and the read: its owner released it.
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeedNone,
      ),
    );
    if (Option.isNone(existing)) return { _tag: "Stale" } as const;
    const holder = yield* decodeLockContents(existing.value).pipe(Effect.option);
    if (Option.isSome(holder) && (yield* isLive(holder.value))) {
      return { _tag: "Held", holder: holder.value } as const;
    }
    // A dead or different process, this one's own pid, or unreadable: nobody
    // is behind it. Remove exactly what was read and let the next attempt
    // create ours.
    yield* Effect.logInfo("Taking over a stale server lock.", { lockPath });
    yield* removeLockIfUnchanged(lockPath, existing.value).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
    );
    return { _tag: "Stale" } as const;
  });

  // A stale lock takes one more attempt; a second stale answer in a row means
  // something keeps writing there, and that is not a live holder either.
  const acquireOnce = attempt.pipe(
    Effect.flatMap((result) => (result._tag === "Stale" ? attempt : Effect.succeed(result))),
    Effect.catch((cause) =>
      Effect.logWarning("Could not take the server lock; starting without it.", {
        lockPath,
        cause,
      }).pipe(Effect.as(null)),
    ),
  );

  const deadline =
    (yield* Clock.currentTimeMillis) + Duration.toMillis(input.holderGrace ?? DEFAULT_HOLDER_GRACE);
  let result = yield* acquireOnce;
  while (result?._tag === "Held" && (yield* Clock.currentTimeMillis) < deadline) {
    yield* Effect.sleep(HOLDER_POLL_INTERVAL);
    result = yield* acquireOnce;
  }

  if (result === null) return;
  if (result._tag === "Held") {
    const holderPid = result.holder.pid;
    const runtimeState = yield* readPersistedServerRuntimeState(input.runtimeStatePath);
    const port = Option.getOrUndefined(
      Option.filter(runtimeState, (state) => state.pid === holderPid),
    )?.port;
    return yield* new ServerStateDirHeldError({
      stateDir: input.stateDir,
      lockPath,
      pid: holderPid,
      ...(port === undefined ? {} : { port }),
    });
  }
  if (result._tag === "Stale") {
    yield* Effect.logWarning("Could not take the server lock; starting without it.", { lockPath });
    return;
  }

  const ours = result.contents;
  // Released only if it is still ours: a lock someone else took over after
  // deciding this process was gone is theirs to remove.
  yield* Effect.addFinalizer(() =>
    removeLockIfUnchanged(lockPath, ours).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.catchCause((cause) =>
        Effect.logWarning("Failed to release the server lock", { cause }),
      ),
    ),
  );
});
