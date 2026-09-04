# Maintaining the extensible fork

## What this fork is

`t3code-extensible` is a public fork of [T3 Code](https://github.com/pingdotgg/t3code)
maintained by [ashakirzianov](https://github.com/ashakirzianov), not affiliated with T3
Tools. It exists to add one thing upstream does not have: a seam that lets **extensions**
run as separate processes and act as privileged clients of the T3 Code server, contributing
tools, storage, and their own web UI mounted into the host. The work happens in a fork
rather than upstream because the seam is not something upstream has committed to, and
because the tree that hosts the reference extension cannot absorb a change this large.
Upstream's own README invites this ("fork and build the editor that you want"). The design
record lives in the Bach repository as `docs/bach/extensibility-design.md`; this note is the
fork's operational half and does not restate it.

## Branch model

- `main` is `upstream/main` plus the fork's commits. No other long-lived branches.
- Remotes: `origin` → `ashakirzianov/t3code-extensible`, `upstream` → `pingdotgg/t3code`.
- Uptake is a merge, always:

  ```bash
  git fetch upstream
  git merge upstream/main
  ```

- **Never rebase and never force-push `main`.** Fork commits interleave with upstream
  history permanently; rebasing rewrites merge bases and turns the next uptake into a
  conflict storm. Frequent small merges beat rare large ones — design §8 leans on frequent
  uptakes to keep the fork's migration set close to upstream's.
- Fixes that are genuinely upstream's problem (the migration guard) go upstream as small
  standalone PRs, not as fork-only carry.

## Where fork code lives

Host-side additions live in new directories so uptakes conflict as little as possible
(design §12):

- `apps/server/src/extensions/`
- `apps/web/src/extensions/`
- `packages/contracts/src/extensions.ts`

Everything else is a **host-file touch point**: an edit inside a file upstream also edits,
which must be re-reconciled on every uptake. Keep those few, in low-churn files, and absorb
churn on the host side so extensions only ever see the protocol. Fill this table in as the
seam lands — one row per file, so an uptake conflict is a lookup rather than an
investigation.

| Host file                                         | What the fork changes                                                                                                                               | Why it cannot live in `extensions/`                                                                                                           |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/persistence/Migrations.ts`       | Guard in `runMigrations` refusing a database migrated past `latestKnownMigrationId`, plus a `databasePath` option so the refusal can name the home. | The check has to run inside the one function every on-disk open already passes through, before the migrator concludes there is nothing to do. |
| `apps/server/src/persistence/Layers/Sqlite.ts`    | `setup` takes migration options, so `makeSqlitePersistenceLive` can pass the database path down to the guard.                                       | The path is only known where the on-disk layer is built; the in-memory layer has no home to name.                                             |
| `apps/desktop/src/app/DesktopEnvironment.ts`      | `userDataDirName`, `legacyUserDataDirName`, `appUserModelId`, `linuxDesktopEntryName`, `linuxWmClass` read from `@t3tools/shared/forkIdentity`      | The values are inlined ternaries in the environment constructor.                                                                              |
| `apps/desktop/src/app/DesktopEnvironment.test.ts` | Asserts the fork's app id and WM class                                                                                                              | Mirrors the file above.                                                                                                                       |
| `apps/desktop/src/app/DesktopAppIdentity.test.ts` | Legacy-userData assertions use the fork's legacy dir name                                                                                           | Mirrors the value change above.                                                                                                               |
| `scripts/build-desktop-artifact.ts`               | `DESKTOP_APP_ID` = `FORK_APP_ID`; `resolveGitHubPublishConfig` falls back to `FORK_UPDATE_REPOSITORY`                                               | electron-builder config is assembled in this one script.                                                                                      |
| `scripts/build-desktop-artifact.test.ts`          | `appId` assertions use the fork's app id                                                                                                            | Mirrors the file above.                                                                                                                       |
| `apps/server/src/mcp/McpSessionRegistry.ts`       | `DEFAULT_LIVENESS_WINDOW_MS` 24h → 30d, plus the why                                                                                                | One constant inside upstream's registry.                                                                                                      |
| `apps/server/src/mcp/McpSessionRegistry.test.ts`  | Adds a default-window expiry test; `makeRegistry` takes a `null` opt-out                                                                            | Mirrors the file above.                                                                                                                       |
| `apps/server/src/cloud/bootService.ts`            | `BOOT_SERVICE_NAME` and `BOOT_SERVICE_LAUNCHD_LABEL` derived from `forkIdentity`                                                                    | Boot-service naming is two constants inside upstream's installer.                                                                             |
| `apps/server/src/cloud/bootService.test.ts`       | Unit name and launchd label expectations use the fork's values                                                                                      | Mirrors the file above.                                                                                                                       |
| `packages/shared/package.json`                    | Adds the `./forkIdentity` subpath export                                                                                                            | Subpath exports are declared in the package manifest.                                                                                         |

The migration guard is a candidate to send upstream (see the spike note), which
would retire its two rows from this table.

The constants themselves live in `packages/shared/src/forkIdentity.ts`, a fork-owned file, so
each touch point above is an import plus a reference rather than a literal to re-reconcile.
The **tests deliberately hardcode the expected values** rather than importing those
constants: a test that reads the same constant as the code it checks cannot catch a wrong
value, and these are user-visible identity strings where the value is the thing worth pinning.

## Never touch

- `AGENTS.md`, `CONTRIBUTING.md`, `LICENSE` — unchanged from upstream, always.
- `CLAUDE.md` — a symlink to `AGENTS.md`. Leave it as a symlink.
- `README.md` — the single non-affiliation line at the top is the only fork edit. It carries
  no upstream logo or icon today (the header is a plain `# T3 Code`), so nothing had to be
  preserved; when the fork gets its own identity assets, they go here and in the desktop
  build, and this line is where they land.

## Spike findings

Verification notes live in [`extensions/spikes/`](extensions/spikes/). They answer the
"verify in the first build, not assume" items in design §11 with evidence, and record where
a fix belongs without implementing it.

- [Migration guard](extensions/spikes/migration-guard.md) — upstream does **not** guard
  against opening a database migrated past the build's known set. It ignores the unknown
  migrations and runs anyway, with no message at the default log level. The guard belongs in
  `runMigrations` (`apps/server/src/persistence/Migrations.ts:154-163`).
- [Home lock](extensions/spikes/home-lock.md) — there is **no** home lock, and Electron's
  single-instance lock does not substitute for one: it is scoped to Electron's `userData`,
  not the T3 home (and on macOS is never requested). The desktop backend port scan
  (`apps/desktop/src/app/DesktopApp.ts:71-104`) then lets a second app take the next free
  port and open the same home. The note records where a lock would belong
  (`makeSqlitePersistenceLive`, `apps/server/src/persistence/Layers/Sqlite.ts:43-61`); the
  fork is not building one, and relies on the switching guidance below instead.
- [MCP client behaviour](extensions/spikes/mcp-client-behaviour.md) — `tools/list_changed` is
  **undeliverable** (the MCP transport is POST-only) and Claude Code caches tools and resources
  at connect, so a new tool reaches an agent only when its provider process restarts; handler
  behaviour is live. Server `instructions` need a 5-line hunk in the existing `effect` patch,
  now carried in `patches/`.
- [Electron runtime](extensions/spikes/electron-runtime.md) — all three green: a same-origin
  `import()` of a server-served ES module runs under the desktop CSP (`blob:`, `data:`, cross-origin
  and `eval` do not, so auth rides in the URL and bundles must be non-`eval` output); the app's own
  binary with `ELECTRON_RUN_AS_NODE=1` spawns a child with `node:sqlite` (Electron 43.4.1 / Node
  24.18.1, no flag); a folder under `Contents/Resources/extensions/` in a packaged build spawns
  and writes to userdata (`extraResources`; an asar path cannot be `cwd`).

## Fork identity

Four knobs, three of which change (design §8):

- **T3 home: shared** with upstream (`~/.t3`), so switching over does not lose data. Safe
  only as long as the fork adds no migrations to the host database, and only with the
  migration guard above in place. The two-servers-one-home hazard is not fixed — see below.
- **App id: the fork's own**, in the desktop build script and the runtime app-user-model id.
  Drives Launch Services identity, notification attribution, Windows taskbar grouping, the
  Linux desktop entry, and the Electron support-directory name.
- **Updater feed: the fork's own** publish owner/repo. Keeping upstream's feed would make
  the fork check upstream's releases and update itself into upstream.
- **URL scheme: unchanged** (`t3code://`), so OAuth callbacks stay on a scheme Clerk's
  allowlist knows and the server's renderer-origin allowlist needs no edit. The cost is a
  scheme race while both apps are installed — whichever launched last owns it — which loses
  nothing beyond a sign-in that completes in the wrong app.

No home lock exists anywhere — upstream has none, and the fork is not adding one — so the
guidance for anyone switching is standing rather than interim: **uninstall upstream after
moving over.** That removes both the scheme race and the two-servers-one-home hazard.

### Fork identity — as built

All values live in `packages/shared/src/forkIdentity.ts`; nothing else hardcodes them.

| Knob                              | Value                                                                             |
| --------------------------------- | --------------------------------------------------------------------------------- |
| App id (release / dev)            | `com.ashakirzianov.t3code-extensible` / `com.ashakirzianov.t3code-extensible.dev` |
| Electron `userData` dir           | `t3code-extensible` / `t3code-extensible-dev`                                     |
| Legacy `userData` dir (never hit) | `T3 Code Extensible (Alpha)` / `T3 Code Extensible (Dev)`                         |
| Linux desktop entry / WM class    | `t3code-extensible.desktop` / `t3code-extensible`                                 |
| Updater publish repo (default)    | `ashakirzianov/t3code-extensible`                                                 |
| systemd unit / launchd label      | `t3code-extensible.service` / `com.ashakirzianov.t3code-extensible.service`       |
| URL scheme                        | `t3code://` — **unchanged**, shared with upstream                                 |
| T3 home                           | `~/.t3` — **unchanged**, shared with upstream                                     |
| Display / product name            | `T3 Code (Alpha)` — **unchanged** (see below)                                     |

Three notes on why these values and not others:

- **The `userData` directory was the load-bearing one.** It is keyed on a hardcoded name,
  not derived from the app id, so changing the app id alone would have left the fork and
  upstream sharing one directory. Electron scopes the single-instance lock to it and keeps
  Chromium profile state in it, so sharing means the two apps contend for one lock and one
  profile (`DesktopClerk.ts:88-96` takes that lock at bridge creation).
- **The legacy `userData` name had to move too.** `resolveUserDataPath` falls back to the
  product-name-derived path when it exists. Left at upstream's `T3 Code (Alpha)`, a fresh
  fork install on an upstream user's machine would have adopted upstream's profile
  directory — the exact bug the rename was meant to prevent. The fork's values are expected
  never to exist, so the branch never fires; they track the fork's display name so the
  branch stays meaningful if the product name is ever changed to match.
- **The updater feed was already env-driven** (`T3CODE_DESKTOP_UPDATE_REPOSITORY`, then
  `GITHUB_REPOSITORY`), with no upstream repo hardcoded anywhere — in the fork's own CI it
  is already correct. The fork only replaces the "no feed at all" fallback with its own
  repo, so a build made outside CI cannot end up pointing anywhere but the fork.

**Display name left as upstream's `T3 Code (Alpha)`.** It is not a single constant: the
runtime name comes from `APP_BASE_NAME` (`DesktopEnvironment.ts:88`), the packaged name from
`apps/desktop/package.json` `productName`, and the nightly name from a literal in
`resolveDesktopProductName`. Changing it is a separate, three-place edit with its own test
fallout (`apps/web/src/branding.test.ts`, `apps/desktop/scripts/electron-launcher.test.mjs`).

**The boot service was renamed too.** `bootService.ts` registers a systemd user unit and a
launchd label, and upstream's comment ties that label to the desktop bundle id "so launchd
and TCC records never collide" — so the fork must carry that reasoning through rather than
inherit upstream's names and collide with its installed service. Both now derive from
`FORK_BOOT_SERVICE_NAME` and `FORK_APP_ID`. This orphans an already-installed upstream unit,
but only for someone switching over, and the standing guidance above already says to
**uninstall upstream after moving over** — which removes it.

**Known collisions deliberately left alone**, each needing a decision rather than a rename:

- `apps/desktop/scripts/electron-launcher.mjs:19-21` — the dev launcher's macOS bundle id is
  still `com.t3tools.t3code[.dev.<worktree>]`. Dev-only, and already worktree-suffixed, so it
  does not collide in practice. It is a plain `.mjs` script and cannot import the shared
  constants module.
- `apps/mobile/app.config.ts` — mobile bundle ids are app-store identity, out of scope here.

## Running the fork

This checkout is not a git worktree, so the T3 home does **not** default to a local `.t3`.
Always pass it explicitly, and confirm `baseDir` in the `[dev-runner]` line before doing
anything else:

```bash
eval "$(fnm env)"                        # if node is not on PATH
CI=true pnpm install                     # or: vp i
export PATH="$PWD/node_modules/.bin:$PATH"   # dev-runner spawns `vp`; it is not global
node scripts/dev-runner.ts dev --home-dir "$PWD/.t3"
```

Verified on 2026-09-04: this boots the server and web app, runs all 47 migrations into a
fresh `.t3/userdata`, and prints the ports and pairing URL:

```
[dev-runner] mode=dev source=default ports serverPort=13773 webPort=5733 baseDir=.../.t3
INFO: Migrations ran successfully  migrations: [ '1_OrchestrationEvents', ... '47_ProjectionProjectIcon' ]
INFO: Listening on http://127.0.0.1:13773
INFO: Authentication required. Open T3 Code using the pairing URL.  pairingUrl: http://localhost:5733/pair#token=...
```

Read the real ports from that `[dev-runner]` line rather than assuming — they derive from
the checkout path and shift when occupied. Never set `VITE_HTTP_URL` or `VITE_WS_URL`.

Agents spawned by the desktop app inherit `ELECTRON_RUN_AS_NODE=1` into their shell. One
upstream test (`build-desktop-artifact.test.ts`, the cross-architecture Windows probe) asserts
that variable is absent from spawned commands and fails under that inheritance. Run tests
with `env -u ELECTRON_RUN_AS_NODE vp test run …` when your shell has it set.
