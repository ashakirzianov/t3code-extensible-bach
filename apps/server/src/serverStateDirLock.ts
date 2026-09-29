import * as NodeOS from "node:os";

import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
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
 * It is a file created exclusively and holding the owner's pid, not an OS lock
 * (Node has none), so a crash leaves it behind. A lock is therefore only
 * honoured while its owner is demonstrably alive: its pid runs, it is not this
 * process's own pid, and it was written during this boot — the last check is
 * what keeps a pid reused after a reboot from bricking startup. Anything else
 * about the lock that goes wrong is logged and startup continues without it:
 * the lock guards against a rare accident and must never become one.
 */

export const SERVER_STATE_DIR_LOCK_FILE = "server.lock";

const LockContents = Schema.Struct({
  version: Schema.Literal(1),
  pid: Schema.Int,
  /** Wall-clock boot time of the machine that wrote it, in epoch millis. */
  bootTime: Schema.Number,
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

/** What the lock asks of the machine; replaced in tests. */
export interface ServerStateDirLockProbe {
  readonly pid: number;
  readonly isProcessAlive: (pid: number) => boolean;
  readonly bootTime: Effect.Effect<number>;
}

const defaultProbe: ServerStateDirLockProbe = {
  pid: process.pid,
  isProcessAlive,
  bootTime: Clock.currentTimeMillis.pipe(Effect.map((now) => now - NodeOS.uptime() * 1000)),
};

/**
 * Boot times are derived from the wall clock, which drifts and gets corrected.
 * Two readings within this of each other are the same boot; the slack only
 * ever makes a lock look *live*, never stale, so it errs toward refusing.
 */
const SAME_BOOT_TOLERANCE_MS = 60_000;

/** How long a live holder gets to finish exiting, e.g. during an app relaunch. */
const DEFAULT_HOLDER_GRACE = Duration.seconds(5);
const HOLDER_POLL_INTERVAL = Duration.millis(250);

type AttemptResult =
  | { readonly _tag: "Acquired"; readonly contents: string }
  | { readonly _tag: "Held"; readonly holder: LockContents }
  | { readonly _tag: "Stale" };

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

  const bootTime = Math.round(yield* probe.bootTime);
  const isLive = (holder: LockContents) =>
    holder.pid !== probe.pid &&
    Math.abs(holder.bootTime - bootTime) <= SAME_BOOT_TOLERANCE_MS &&
    probe.isProcessAlive(holder.pid);

  const attempt = Effect.gen(function* (): Effect.fn.Return<
    AttemptResult,
    PlatformError.PlatformError
  > {
    const contents = yield* encodeLockContents({
      version: 1,
      pid: probe.pid,
      bootTime,
      startedAt: DateTime.formatIso(yield* DateTime.now),
    }).pipe(Effect.orDie);
    const created = yield* fs.writeFileString(lockPath, contents, { flag: "wx" }).pipe(
      Effect.as(true),
      Effect.catchIf(
        (error) => error.reason._tag === "AlreadyExists",
        () => Effect.succeed(false),
      ),
    );
    if (created) return { _tag: "Acquired", contents } as const;

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
    if (Option.isSome(holder) && isLive(holder.value)) {
      return { _tag: "Held", holder: holder.value } as const;
    }
    // Dead owner, an earlier boot, this process's own pid, or unreadable:
    // nobody is behind it. Remove it and let the next attempt create ours.
    yield* Effect.logInfo("Taking over a stale server lock.", { lockPath });
    yield* fs.remove(lockPath, { force: true });
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
    fs.readFileString(lockPath).pipe(
      Effect.flatMap((current) =>
        current === ours ? fs.remove(lockPath, { force: true }) : Effect.void,
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("Failed to release the server lock", { cause }),
      ),
    ),
  );
});
