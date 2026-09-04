# Spike: is there a home lock?

**Answer: no home lock exists, and the Electron single-instance lock does not substitute
for one.** Nothing anywhere is keyed on the T3 home, so two servers can open one home
concurrently and neither notices. One correction to design §8 below: the single-instance
lock _is_ requested on Windows and Linux, just not by `apps/desktop/src` and not scoped to
the home. Verified on 2026-09-04 against `main` at `d7cf8aaa8`.

## No home lock

The persistence open path is `makeSqlitePersistenceLive`
(`apps/server/src/persistence/Layers/Sqlite.ts:43-61`) feeding the `setup` layer
(`:33-41`). `setup` runs four statements and nothing else: `busy_timeout`, `foreign_keys`,
`journal_mode = WAL`, then `runMigrations()`. No lock file, no advisory lock, no pid file,
no liveness probe.

The comment on `busy_timeout` (`Sqlite.ts:36`) is the clearest statement of current intent:

> CLI and server write from separate processes; wait rather than fail with SQLITE_BUSY.

Multi-process access to one home is not an accident upstream tolerates — it is a designed
behaviour, and it is exactly what makes a second _server_ invisible. WAL plus a 5 s busy
timeout absorbs the contention, so the collision shows up as corrupted orchestration state
rather than an error at the door.

Greps for the usual mechanisms across `apps/`, `packages/`, and `scripts/` turn up nothing:
no `proper-lockfile`, no `flock`, no `.lock` under a T3 home, no pid file. (`process.pid`
appears in `serverRuntimeState.ts:56` and `terminal/Manager.ts` — reported as telemetry and
used to track spawned children, never to arbitrate ownership. `codexResetCredit.ts:75` is an
in-process Effect semaphore.)

## The Electron single-instance lock, precisely

`requestSingleInstanceLock` appears nowhere in `apps/desktop/src` — only the
`second-instance` listener (`apps/desktop/src/app/DesktopClerk.ts:138`) and the
`bridge.isPrimaryInstance` bailout (`:133`). The lock is taken indirectly, inside
`createClerkBridge` from `@clerk/electron` 0.0.37
(`node_modules/.../@clerk/electron/dist/esm/index.js:258-268`):

```js
let ownsSingleInstanceLock = false;
if (options.renderer) {
  assertValidRendererOriginConfig(options.renderer);
  if (process.platform !== "darwin" && !app.hasSingleInstanceLock()) ...
  else if (!app.requestSingleInstanceLock()) { app.quit(); return { cleanup(){}, isPrimaryInstance: false }; }
  else ownsSingleInstanceLock = true;
}
```

Two facts follow:

1. **On macOS the lock is never requested at all.** The `process.platform !== "darwin"`
   guard skips it (Clerk only needs it to forward OAuth deep links on Windows/Linux), and
   the bridge still returns `isPrimaryInstance: true` (`:307`). On the developer's platform
   there is no single-instance lock in play whatsoever.
2. **Where it is taken, it is scoped to Electron's `userData`, not the T3 home.** The
   upstream comment at `DesktopClerk.ts:90-95` says so outright — "Electron scopes the
   single-instance lock to the userData directory and creates that directory when the lock
   is acquired" — which is why `setPath("userData", ...)` (`:96`) must run before
   `createDesktopClerkBridge` (`:101`).

`userData` resolves to `<appDataDirectory>/t3code` (`DesktopAppIdentity.ts:47-67`,
`DesktopEnvironment.ts:181`), e.g. `~/Library/Application Support/t3code`. The T3 home is a
different tree entirely: `<baseDir>/userdata` → `~/.t3/userdata`
(`DesktopStatePaths.ts:23-32`, mirrored server-side by `deriveServerPaths` in
`apps/server/src/config.ts:104-114`). The lock and the resource it would need to protect
have no relationship.

So the lock does not cover either case the fork cares about. **Fork vs upstream:** design §8
gives the fork its own app id, hence its own `userData`, hence its own lock — both desktop
apps run, both open `~/.t3/userdata`. **Desktop vs CLI:** `npx t3` is not Electron and never
touches the lock, so a desktop app and a stray CLI server already share a home today.
Sharing the app id would not fix this either; nothing is keyed on identity.

## How the port scan completes the hazard

`resolveDesktopBackendPort` (`apps/desktop/src/app/DesktopApp.ts:71-104`, design §15's
anchor) is the step that turns "a second app started" into "a second server is running":

```ts
for (let port = DEFAULT_DESKTOP_BACKEND_PORT; port <= MAX_TCP_PORT; port += 1) {
  let availableOnEveryHost = true;
  for (const host of DESKTOP_BACKEND_PORT_PROBE_HOSTS) {
    if (!(yield * net.canListenOnHost(port, host))) {
      availableOnEveryHost = false;
      break;
    }
  }
  if (availableOnEveryHost) return { port, selectedByScan: true };
}
```

It starts at 3773 (`:34`) and walks upward until a port is free on all of `127.0.0.1`,
`0.0.0.0`, `::` (`:36`). The only question asked is "is this port free?". It never asks
"is a T3 server already serving this home?" — so an occupied 3773 reads as _someone else is
using that port_, not as _another T3 Code owns your data_, and the second app cheerfully
takes 3774 and opens the same SQLite file. The scan is a fallback that only runs when no
port is configured (`:78-81`), which is precisely the packaged-app default.

Only the exhaustion case is an error (`DesktopBackendPortUnavailableError`, `:100-104`),
and that requires all 62,000 ports to be busy.

## Where a home lock belongs

**Process:** the server, not the desktop shell. Putting it in Electron would miss `npx t3`,
the WSL backend, and the cloud service launcher — all of which open a home.

**Startup step:** `makeSqlitePersistenceLive`
(`apps/server/src/persistence/Layers/Sqlite.ts:43-61`), between the `fs.makeDirectory` call
that creates the state directory (`:48`) and the layer that opens the client (`:52-59`).
Acquire before the SQLite client exists, release on scope close. Deliberately _not_ in
`setup` (`:33-41`): `setup` is shared with `SqlitePersistenceMemory` (`:63-66`), and an
in-memory database has no home to lock.

Pair it with the migration guard (see [migration-guard.md](migration-guard.md)) — same
startup path, same class of "another T3 Code has been here" failure, one error surface.

**Mechanism:** a `server.lock` file next to `state.sqlite` in the state directory, created
with `O_EXCL` (`wx`) so creation is the acquisition, containing JSON: pid, process start
time, app identity/version, and the ISO timestamp. Release deletes it. `Effect.acquireRelease`
gives the release-on-shutdown path for free, matching how the Clerk bridge is already scoped
(`DesktopClerk.ts:99-119`).

**Stale lock after a crash:** creation fails with `EEXIST` → read the file → decide by
liveness, never by timeout. `process.kill(pid, 0)` on the _recorded_ pid, and compare the
recorded process start time against the live process's, so a recycled pid cannot masquerade
as the old holder. Dead holder, or live pid whose start time does not match: log that a
stale lock is being reclaimed, overwrite, continue — a crash must never require the user to
delete a file by hand. Live holder with a matching start time: refuse.

This is also where AGENTS' "killing by pattern" rule applies to the _implementation_: match
on the recorded pid and start time, never on a process name or a path substring in argv.

**The error the user should see:**

```
Another T3 Code server is already using this data directory.

  /Users/x/.t3/userdata is held by T3 Code 1.4.2 (process 41207, started 14:02).

Quit that app, or start this one with --home-dir pointing at a different directory.
```

Name the directory, the holder, and the way out. The desktop shell should surface this as a
dialog rather than a silent backend failure, since the packaged app has no console.

## Implication for the design

Design §8's conclusion stands and its remedy is unchanged: **the fork adds a home lock**,
and it is worth offering upstream as a small PR because it protects upstream's own users
from a desktop app and a stray `npx t3` sharing a home. Two corrections to the wording:

- "the `second-instance` listener exists but the lock is never requested" is right on macOS
  and wrong on Windows/Linux, where `@clerk/electron` requests it. The claim to carry
  forward is the stronger and platform-independent one: **the lock is scoped to Electron's
  `userData`, so it is not keyed on the T3 home and cannot separate two apps that share
  one.**
- §15's anchor "no `requestSingleInstanceLock` anywhere in `apps/desktop/src`" is literally
  accurate; the call lives in the `@clerk/electron` dependency. Worth stating that way so a
  future reader does not conclude the lock is absent everywhere.

The interim guidance for friends switching over — uninstall upstream after moving — remains
the only real protection until the lock lands.
