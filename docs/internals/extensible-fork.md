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

## Uptake log

What each merge actually cost, so the next one can be estimated rather than guessed at.

### 2026-09-28 — `upstream/main` at `d15210cd3d` (115 commits)

**Five conflicts, all both-sides-added-adjacent-code, none of them the effect patch.**
`DesktopBackendConfiguration.ts`: upstream inserted a packaged-build `--require
compileCachePath` prefix in the same `args` array the fork appends
`bundledExtensionArgs` to; kept both, upstream's prefix first. `Sqlite.ts`: upstream
added `WAL_SIZE_LIMIT_BYTES` and a `PRAGMA journal_size_limit` line inside the same
`setup` the fork had turned into a function taking `migrationOptions`; folded upstream's
PRAGMA into the fork's parameterised version. `server.ts`: upstream added
`untracedRequestsLayer` last in the same `Layer.mergeAll` the fork's MCP-gate and
`ExtensionsRuntime.startLayer` sit in; kept the fork's two layers where they were and
upstream's last, matching its own "last, so no route layer can replace the server's one
TracerDisabledWhen" comment. `entities.ts`: upstream added `readThread` right after
`readThreadShell`, the same spot the fork's `waitForThreadShell` occupies; both kept,
independent functions. `SidebarChrome.tsx` was the one with a real design decision:
upstream refactored the fork's inline per-route regex (which also matched `/ext/...`)
into a shared `isSidebarUtilityPage()` boolean helper in a new file,
`mainAppLocation.ts`, also used by `MainAppLocationTracker`. Taking upstream's side
outright would have silently dropped the extension page from the utility-row/Back-button
treatment, so the `/ext/...` case moved into the shared helper instead of staying in
`SidebarChrome.tsx` — a new row in the seam table, and the existing `SidebarChrome.tsx`
row narrowed to just the entries render.

**The effect patch didn't move.** Still `rc.115`, same as the 2026-09-24 uptake;
`pnpm install` applied it unchanged.

**The generated-artifact question from last time has an answer: effect's JSON Schema
emission has settled.** `packages/contracts/generated/extensions/protocol.schema.json`
and `protocol.d.ts` came out byte-identical after `pnpm run generate:extensions`, and
`scripts/vendoredProtocol.test.ts` passed without re-vendoring anything into the
reference extension. Two uptakes in a row moved that artifact before this one; watch
whether it stays quiet before assuming it's fixed for good.

**One artifact did drift, a different one: the extension guide.** Upstream's own commits
in this range added a `ServerSettings` field and an `orchestration.dispatchCommand`
variant, which shifted the generated field/variant counts
(`server.getSettings`/`updateSettings` `+39` → `+40`, `orchestration.dispatchCommand`
`+25` → `+26`). `scripts/extensionGuide.test.ts` caught the stale committed copy;
`pnpm generate:extension-guide` regenerated `docs/internals/extensions/reference.md`
and `apps/server/src/extensions/guideResources.generated.ts`. Unlike the protocol
artifact, this one does not need effect to hold still — any upstream schema change under
`extensions/`'s reach will move it, so expect this most uptakes.

**The hand checks found almost nothing.** `ElectronProtocol.ts` gained one upstream line
(`codeCache: true` on the custom scheme's privileges, a Chromium code-cache opt-in with a
comment about dev staying off) and nothing else; both the `/__ext-remote/…` and
`/ext-assets/…` bridges still dispatch ahead of the serving-mode branch, unchanged.
`DesktopApp.ts` took no upstream edits at all — third uptake running with the same
answer to "can a page-relative path still reach the local backend, and by what route."

**What the next uptake should check:** whether the extension guide's generated counts
keep drifting (expected, not a bug, but worth a glance at _what_ moved); whether the
protocol schema stays byte-identical a second time running; and the two desktop seam
files, as always. Still open from 2026-09-09: the Linux screen-capture identity
literals.

### 2026-09-24 — `upstream/main` at `f3cb2a1fe` (255 commits)

**Five conflicts, and none of them was the expensive part.** Three were import
blocks where both sides had added a line (`apps/server/src/config.ts`,
`apps/server/src/cli/config.ts`, `packages/contracts/src/settings.ts`), resolved by
keeping both; the fourth was `pnpm-lock.yaml`, every hunk an effect version bump, so
upstream's side won in all 44 and `pnpm install` regenerated the patch hash. The fifth
was the effect patch, renamed `rc.112` → `rc.115` with its context moved — **the recipe
in the 2026-09-09 entry worked unchanged** and is now twice-proven: `npm pack`, unpack as
`pristine` and `edited`, `git apply` upstream's patch to `edited`, re-make the fork's
hunks, `git diff` the two. The fork's five `instructions` hunks went back on in about ten
minutes.

**The cost was in the silent breaks again, and this time there were three kinds.**
Effect rc.115 capitalised its constructor names — `Flag.string`, `Flag.keyValuePair`,
`Config.string` are now `Flag.String`, `Flag.KeyValuePair`, `Config.String` — and
replaced `HttpServer.address`'s `TcpAddress { hostname }` with `NetAddress` variants
carrying an `Ipv4Address`/`Ipv6Address` value. Upstream migrated its own copy of the
wildcard-bind helper in `McpSessionRegistry.ts`; the fork's identical copy in
`ExtensionsRuntime.ts` was left behind and now calls upstream's `NetAddress.isUnspecified`
and `formatUrlHostString` rather than re-deriving them. `nodeSqliteClient.layerMemory`
was deleted as obsolete, so the migration-guard test opens `:memory:` through `layer`.
**None of this conflicted; only the typecheck caught it.**

**Two generated-artifact surprises, both effect's JSON Schema emission.** Every struct
now emits `additionalProperties: true` where it emitted `false`, which silently loosens
the published extension protocol schema; and `Schema.Struct({})` encodes as
`{"not":{"type":"null"}}` rather than an object/array union, a node the protocol
generator threw on before any typecheck ran. The generator now reads it as TypeScript's
`{}`. `extensions/reference/protocol/` had to be re-vendored after
(`scripts/vendoredProtocol.test.ts` is what says so).

**Upstream added `@shadcn/lint`, and its component-ownership rules had never seen the
fork's extension UI.** Twelve errors across three fork-only files: colour and shape
classes on `SidebarInset` and `ScrollArea`, arbitrary text sizes that belong on the
`text-2xs`/`text-3xs` scale, and spacing overrides on `SidebarMenuButton` and
`AutocompleteItem`. All fixed in the fork's own files rather than by adding fork entries
to the allowlist in `vite.config.ts`, which would have been a new host-file touch point.
The one judgement call: `SidebarMenuButton`'s `ps-2` was dropped rather than carried as a
new size variant — upstream now drives the row inset from
`--sidebar-row-content-inset`, so the fork's rows line up with every other sidebar row
without the override.

**The hand checks found nothing.** `ElectronProtocol.ts` changed only cosmetically
(`Mime` moved to `effect/unstable/http` and returns an `Option`; `blob:` joined the CSP
connect sources for a 3D viewer), and both the `/__ext-remote/…` and `/ext-assets/…`
bridges still dispatch ahead of the serving-mode branch. `DesktopApp.ts` did not change
at all, so the answer to "can a page-relative path still reach the local backend, and by
what route" is the same as last uptake: only through those two bridged prefixes. The
`vite:preloadError` listener and the cooldown floor are untouched. Slice F survived
whole: `McpHttpServer.ts`, `ExtensionMcp.ts`, `ExtensionRegistry.ts` and
`packages/contracts/src/extensions.ts` took no upstream edits.

**What the next uptake should check:** whether effect has settled its JSON Schema
emission, because two uptakes in a row have moved the published protocol artifact
without anyone asking; whether upstream's `@shadcn/lint` rule set grows again, since it
reaches every fork-owned file under `apps/web/src/` and no fork file has ever been
written against it; and the two desktop seam files, as before. Still open from
2026-09-09, and still not decided: the Linux screen-capture identity literals.

### 2026-09-17 — `upstream/main` at `3fd5d6439`

**The expensive part conflicted with nothing and only showed up in a packaged build.**
Upstream's `cba7dd7781` ("allow disabling the local environment") changed how the packaged
desktop serves its renderer: `DesktopApp.ts` now registers `t3code://app` with an
`assetDirectory` (static files on disk) rather than `targetOrigin: backendConfig.httpBaseUrl`,
and the protocol handler no longer takes a `backendOrigin` at all. Nothing in the fork's
tree mentioned either, so the merge was clean.

But the extension seam rested on the old shape: a page-relative `/ext-assets/…` import
reached the local backend because the protocol handler proxied _every_ path there, and
`apps/web/src/extensions/bundleOrigin.ts` said so in as many words. A directory of static
files has no `/ext-assets`, so on the first packaged build after the merge the bundle import
404'd — and because Vite's preload wrapper turns that into `vite:preloadError`, and
upstream's chunk-reload guard is cleared by every successful boot, the whole renderer
reloaded about five times a second on `/ext/$environmentId/$name`. Fixed by bridging that one
route explicitly in `ElectronProtocol.ts` (both serving modes) and by teaching the
`vite:preloadError` listener that an extension's bundle is not a host chunk.

**So the next uptake checks `apps/desktop/src/electron/ElectronProtocol.ts` and
`apps/desktop/src/app/DesktopApp.ts` by hand,** merge conflict or not. The question to ask is
"can a page-relative path still reach the local backend, and by what route" — the answer has
changed once without a single conflicting line, and the fork's only remaining dependency on
it is now named and tested rather than assumed. `/api/assets/…` (the `faviconUrl` in
`extensions.projectIcons`) has the same premise and is _not_ bridged; it is documented as
"resolve it against the environment's HTTP base" instead.

### 2026-09-09 — `upstream/main` at `6c583620f` (183 commits)

**Ten conflicts, all in table files** — `McpHttpServer.ts`, `Migrations.ts`,
`DesktopEnvironment.ts` + its test, `cli/config.ts`, `contracts/package.json`,
`contracts/settings.ts`, `build-desktop-artifact.ts` + its test, and the effect patch. Most
were both-sides-added-a-line and resolved by keeping both. Two were upstream un-exporting
something the fork had exported (`makeMigrationLoader`, `tailscaleServePortFlag`); nothing
outside their files imports either, so upstream's `const` won.

**The expensive one: effect beta.103 → rc.112 renamed the patch file and moved the code the
fork patches.** The merged patch kept the fork's `instructions` hunks but their context was
stale, and `pnpm install` failed with `ERR_PNPM_PATCH_FAILED`. Rebuilding it is a fixed
recipe worth writing down: `npm pack effect@<version>`, unpack twice as `pristine` and
`edited`, `git apply` upstream's patch to `edited`, re-make the fork's edit there, then
`git diff` the two into the patch file. Hand-merging the `index` blob-hash lines does not
work — the hunks themselves have to be regenerated.

**Two silent breaks, neither of which conflicted:**

- `Schema.TaggedErrorClass` is now `Schema.TaggedError`. Upstream migrated its own files;
  the fork's `extensions.ts` (9 uses), `Migrations.ts` and `build-desktop-artifact.ts` were
  left behind, and the _generators_ failed before any typecheck ran. **This is the same
  lesson as last time in a new costume**: a fork-only file that consumes an upstream API
  breaks without ever conflicting.
- Upstream introduced `resolveLinuxDesktopEntryName` and now calls it from **two** places,
  one of which the fork had never patched. Keeping only the fork's old call-site override
  would have made the fork write _upstream's_ launcher entry — precisely the collision the
  identity knob exists to prevent. The fork now patches the helper instead of the call site,
  which is one touch point instead of two, and four upstream assertions moved to the fork's
  names.

**Open, and deliberately not decided here:** upstream's new Linux screen-capture feature
hardcodes `com.t3tools.T3Code` in several files (`KdeSnapShot.ts`'s desktop file, Hyprland
bind strings, portal identity). Those are fork-identity surface the fork note does not yet
cover. They do not break anything today because their tests pass their own literals, but a
fork build will register upstream's capture identity. Decide before shipping Linux builds.

### 2026-09-06 — `upstream/main` at `223ff4490` (306 commits)

**Two textual conflicts, both predicted by the table.** `packages/contracts/src/settings.ts`
(both sides appended a field to `ServerSettings`; kept both) and
`apps/server/src/cloud/bootService.test.ts` (upstream rewrote a path assertion to use
`path.join`; re-applied the fork's app id in upstream's new shape). Everything else in the
25 files both sides had touched auto-merged.

**The one thing the table did not predict** was a _silent_ break: nothing conflicted in
`packages/client-runtime/src/extensions/http.ts`, but upstream made
`buildEnvironmentAuthHeaders` private behind a new
`executeAuthenticatedEnvironmentHttpRequest`, and the fork's extension `fetch` imported it.
Only the typecheck caught it. The fork now maps the credential to headers in its own file
rather than re-exporting a private helper: the extension host API hands out a browser
`fetch` returning a real `Response`, which upstream's Effect-client entry point cannot
produce, so consuming it was never going to work. **Lesson: a clean merge proves nothing —
run every package's typecheck, not just the tests, and treat a fork file importing an
upstream helper as a touch point even though it never conflicts.**

**Also worth knowing:** a fresh worktree needs Electron's binary before the desktop tests can
even load (`node apps/desktop/node_modules/electron/install.js`); `CI=true pnpm install`
skips it, and the failure reads like a broken install rather than a missing download.

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

| Host file                                                                                                                                | What the fork changes                                                                                                                                 | Why it cannot live in `extensions/`                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/persistence/Migrations.ts`                                                                                              | Guard in `runMigrations` refusing a database migrated past `latestKnownMigrationId`, plus a `databasePath` option so the refusal can name the home.   | The check has to run inside the one function every on-disk open already passes through, before the migrator concludes there is nothing to do.                                                                              |
| `apps/server/src/persistence/Layers/Sqlite.ts`                                                                                           | `setup` takes migration options, so `makeSqlitePersistenceLive` can pass the database path down to the guard.                                         | The path is only known where the on-disk layer is built; the in-memory layer has no home to name.                                                                                                                          |
| `apps/server/src/server.ts`                                                                                                              | `runServer` taps `DatabaseMigratedAheadError` and writes the fatal-startup marker line to stderr.                                                     | The refusal has to be announced where the server layer is launched; nothing downstream of it runs.                                                                                                                         |
| `apps/desktop/src/app/DesktopApp.ts`                                                                                                     | `bootstrap` forks a watcher on `pool.primaryFatalStartup` that calls the existing local `handleFatalStartupError`.                                    | Purely additive: the failure arrives after `bootstrap` returns, so it cannot fail that Effect. Moving the handler out instead would turn every upstream edit to it into a conflict against a file that no longer holds it. |
| `apps/desktop/src/backend/DesktopBackendManager.ts`                                                                                      | `onFatalStartup` on the instance spec; output scanned for the marker; a marked exit ends the instance instead of scheduling a restart.                | The restart loop is what hides a permanent failure, and it lives here.                                                                                                                                                     |
| `apps/desktop/src/backend/DesktopBackendPool.ts`                                                                                         | Adds `primaryFatalStartup` to the service; the primary's `onFatalStartup` only completes it.                                                          | Instance specs are built here. The pool reports rather than handles, so its layer requirements are unchanged.                                                                                                              |
| `apps/desktop/src/backend/DesktopBackendManager.test.ts`, `DesktopBackendPool.test.ts`, `apps/desktop/src/wsl/DesktopWslBackend.test.ts` | Fatal-startup routing tests; the pool harness takes optional overrides so one test can drive a real run; pool stubs gain `primaryFatalStartup`.       | Mirror the files above.                                                                                                                                                                                                    |
| `apps/server/src/http.ts`                                                                                                                | Exports `authenticateRawRouteWithScope` so the extension routes authenticate exactly as `/api` does                                                   | The helper is defined there; duplicating it would let the two drift.                                                                                                                                                       |
| `apps/server/src/server.ts`                                                                                                              | Registers `extensionApiRouteLayer` and `extensionAssetRouteLayer`                                                                                     | The router layer list is assembled in one place.                                                                                                                                                                           |
| `apps/server/src/ws.ts`                                                                                                                  | Handler for `extensions.admin.assetUrls`                                                                                                              | Handlers are one object literal keyed by method.                                                                                                                                                                           |
| `apps/server/src/auth/RpcAuthorization.ts`                                                                                               | Scope for `extensions.admin.assetUrls`                                                                                                                | Every RPC must declare a scope or the server throws at startup.                                                                                                                                                            |
| `packages/contracts/src/extensions.ts`                                                                                                   | `assetUrls` method name, its input/result, and the asset TTL                                                                                          | The extension contract lives in this one file.                                                                                                                                                                             |
| `packages/contracts/src/rpc.ts`                                                                                                          | `WsExtensionsAdminAssetUrlsRpc`, added to `WsRpcGroup`                                                                                                | The RPC group is a single declaration.                                                                                                                                                                                     |
| `packages/shared/package.json`                                                                                                           | `./fatalStartup` subpath export.                                                                                                                      | Upstream owns the export map.                                                                                                                                                                                              |
| `.gitignore` (one line)                                                                                                                  | Ignores `.t3-*` — the scratch and acceptance-run homes the fork's runbooks create beside `.t3`.                                                       | Upstream ignores only the exact name `.t3`.                                                                                                                                                                                |
| `apps/desktop/src/app/DesktopEnvironment.ts`                                                                                             | `userDataDirName`, `legacyUserDataDirName`, `appUserModelId`, `linuxDesktopEntryName`, `linuxWmClass` read from `@t3tools/shared/forkIdentity`        | The values are inlined ternaries in the environment constructor.                                                                                                                                                           |
| `apps/desktop/src/app/DesktopEnvironment.test.ts`                                                                                        | Asserts the fork's app id and WM class                                                                                                                | Mirrors the file above.                                                                                                                                                                                                    |
| `apps/desktop/src/app/DesktopAppIdentity.test.ts`                                                                                        | Legacy-userData assertions use the fork's legacy dir name                                                                                             | Mirrors the value change above.                                                                                                                                                                                            |
| `scripts/build-desktop-artifact.ts`                                                                                                      | `DESKTOP_APP_ID` = `FORK_APP_ID`; `resolveGitHubPublishConfig` falls back to `FORK_UPDATE_REPOSITORY`                                                 | electron-builder config is assembled in this one script.                                                                                                                                                                   |
| `scripts/build-desktop-artifact.test.ts`                                                                                                 | `appId` assertions use the fork's app id                                                                                                              | Mirrors the file above.                                                                                                                                                                                                    |
| `package.json`                                                                                                                           | Adds the `generate:extension-guide` script.                                                                                                           | Upstream owns the root script list.                                                                                                                                                                                        |
| `apps/server/src/mcp/McpSessionRegistry.ts`                                                                                              | `DEFAULT_LIVENESS_WINDOW_MS` 24h → 30d, plus the why                                                                                                  | One constant inside upstream's registry.                                                                                                                                                                                   |
| `apps/server/src/mcp/McpSessionRegistry.test.ts`                                                                                         | Adds a default-window expiry test; `makeRegistry` takes a `null` opt-out                                                                              | Mirrors the file above.                                                                                                                                                                                                    |
| `apps/server/src/cloud/bootService.ts`                                                                                                   | `BOOT_SERVICE_NAME` and `BOOT_SERVICE_LAUNCHD_LABEL` derived from `forkIdentity`                                                                      | Boot-service naming is two constants inside upstream's installer.                                                                                                                                                          |
| `apps/server/src/cloud/bootService.test.ts`                                                                                              | Unit name and launchd label expectations use the fork's values                                                                                        | Mirrors the file above.                                                                                                                                                                                                    |
| `apps/desktop/src/snapShot/KdeSnapShot.ts`                                                                                               | Helper desktop-entry filename, its marker, and the install directory from `forkIdentity`                                                              | Both apps write into the same `~/.local/share/applications`.                                                                                                                                                               |
| `apps/desktop/src/snapShot/HyprlandSnapShot.ts`                                                                                          | Helper install directory from `forkIdentity`                                                                                                          | Same shared XDG data home.                                                                                                                                                                                                 |
| `apps/desktop/src/snapShot/GnomeCaptureSetup.ts`                                                                                         | Extension-backup directory from `forkIdentity`                                                                                                        | Same shared XDG data home.                                                                                                                                                                                                 |
| `apps/desktop/src/snapShot/GnomeCaptureSetup.test.ts`                                                                                    | Backup path expectation uses the fork's directory                                                                                                     | Mirrors the file above.                                                                                                                                                                                                    |
| `apps/desktop/src/app/DesktopEarlyElectronStartup.ts`                                                                                    | `linuxWmClass` from `forkIdentity`                                                                                                                    | Upstream sets the class before `DesktopEnvironment` exists.                                                                                                                                                                |
| `apps/desktop/src/app/DesktopEarlyElectronStartup.test.ts`                                                                               | WM class expectation uses the fork's value                                                                                                            | Mirrors the file above.                                                                                                                                                                                                    |
| `packages/shared/package.json`                                                                                                           | Adds the `./forkIdentity` subpath export                                                                                                              | Subpath exports are declared in the package manifest.                                                                                                                                                                      |
| `packages/contracts/src/auth.ts`                                                                                                         | One scope constant, `AuthExtensionScope`, plus its entry in the `AuthEnvironmentScope` union                                                          | The union is the closed set of scopes; a scope outside it cannot be minted or checked                                                                                                                                      |
| `packages/contracts/src/index.ts`                                                                                                        | One `export * from "./extensions.ts"` line                                                                                                            | The barrel is the package's only entry point                                                                                                                                                                               |
| `packages/contracts/package.json`                                                                                                        | One `generate:extensions` script                                                                                                                      | Scripts live in the package manifest                                                                                                                                                                                       |
| `packages/contracts/tsconfig.json`                                                                                                       | Adds `scripts` and `generated` to `include`, and `types: ["node"]`                                                                                    | The generator and the artifact it emits have to be typechecked with the package                                                                                                                                            |
| `.prettierignore` (new file at root)                                                                                                     | Excludes `packages/contracts/generated/`                                                                                                              | The generated artifacts are byte-compared by a test, so the formatter must not rewrite them                                                                                                                                |
| `apps/desktop/src/backend/DesktopBackendConfiguration.ts`                                                                                | Resolves the bundled extensions directory and appends `--extension name=path` to the primary backend args                                             | The backend argv is assembled in one place; a shipped extension is only a launch flag                                                                                                                                      |
| `scripts/build-desktop-artifact.ts`                                                                                                      | Stages `extensions/` from `T3CODE_BUNDLED_EXTENSIONS`, one `extraResources` entry, and keeps the staging dir out of `app.asar`                        | electron-builder config and staging both live in this one script                                                                                                                                                           |
| `scripts/build-desktop-artifact.test.ts`                                                                                                 | The extraResources and asar-exclusion expectations grew a row; adds the staging tests                                                                 | Mirrors the file above                                                                                                                                                                                                     |
| `scripts/package.json`, `pnpm-lock.yaml`                                                                                                 | The build script depends on `@t3tools/contracts` for the manifest filename and the extension-name rule                                                | Staging must agree with the folder contract rather than re-spelling it                                                                                                                                                     |
| `apps/server/src/mcp/McpHttpServer.ts`                                                                                                   | Registers the extension resources and the tool sync; passes `instructions` to `layerHttp`                                                             | The MCP server is one per process and is built here; `instructions` is a transport option                                                                                                                                  |
| `apps/server/src/mcp/McpSessionRegistry.ts`                                                                                              | A `beforeIssue` option, run before a credential is minted, and a layer that supplies it                                                               | Issuing a credential is the last moment anything can reach the provider process about to connect                                                                                                                           |
| `scripts/extensionGuide.ts`, `generate-extension-guide.ts`, `extensionGuide.test.ts`                                                     | Artifacts carry a repo-relative `directory`, so the guide is also emitted as a compiled-in server module                                              | The generator and its drift test are one pipeline; a second one would drift from the first                                                                                                                                 |
| `packages/contracts/src/rpc.ts`                                                                                                          | The `Rpc.make` definitions for `extensions.*` and their entries in `WsRpcGroup`                                                                       | The group is the wire; a method outside it does not exist                                                                                                                                                                  |
| `packages/contracts/src/settings.ts`                                                                                                     | One `extensions` field on `ServerSettings`                                                                                                            | Settings is one schema, and this is where an environment's extension list lives                                                                                                                                            |
| `apps/server/src/auth/RpcAuthorization.ts`                                                                                               | The required scope for each `extensions.*` method                                                                                                     | The map is typed to demand a scope for every RPC in the group                                                                                                                                                              |
| `apps/server/src/ws.ts`                                                                                                                  | Imports the two extension services, one per-connection ref for the socket's identity, and the `extensions.*` handlers                                 | Handlers are one object literal keyed by method; there is no slot to register into                                                                                                                                         |
| `apps/server/src/server.ts`                                                                                                              | Provides `ExtensionsRuntime.layer` and `startLayer` to the routes layer                                                                               | Layer composition is one expression                                                                                                                                                                                        |
| `apps/server/src/config.ts`                                                                                                              | One optional `extensionLaunchFlags` field on `ServerConfig`                                                                                           | `ServerConfig` is the process-wide config record                                                                                                                                                                           |
| `apps/server/src/cli/config.ts`                                                                                                          | The `--extension name=path` flag and its resolution into that field                                                                                   | Flags are one object literal, resolution one function                                                                                                                                                                      |
| `apps/server/src/cli/config.test.ts`                                                                                                     | `extensionLaunchFlags: []` in the resolved-config expectations                                                                                        | The test compares the whole record                                                                                                                                                                                         |
| `packages/client-runtime/src/rpc/client.ts`                                                                                              | One entry in the hand-maintained `EnvironmentSubscriptionRpcTag` union, for `extensions.admin.subscribe`                                              | The union is what makes a method usable as a subscription atom; a tag outside it is not a stream to the client                                                                                                             |
| `packages/client-runtime/package.json`                                                                                                   | One `./extensions` subpath export                                                                                                                     | Upstream owns the export map                                                                                                                                                                                               |
| `apps/web/src/components/sidebar/SidebarChrome.tsx`                                                                                      | Renders `<ExtensionSidebarEntries />` in the utility menu                                                                                             | The utility menu is one JSX fragment shared by both sidebars and Settings; there is no slot to register into                                                                                                               |
| `apps/web/src/components/sidebar/mainAppLocation.ts`                                                                                     | `isSidebarUtilityPage` also matches `/ext/...`, so an extension's own page swaps the utility row for Back and is never remembered as the main app URL | Upstream (2026-09-28) pulled the per-route check out of `SidebarChrome.tsx` into this shared helper, used by both the utility menu and `MainAppLocationTracker`; the fork's `/ext/...` case moved with it                  |
| `apps/web/src/components/settings/settingsSearch.ts`                                                                                     | One entry in the `SettingsPath` union and `SETTINGS_SECTION_LABELS`, plus three search items for the Extensions screen                                | The union is the closed set of settings pages, and the label record is what the nav and the command palette both render from                                                                                               |
| `apps/web/src/components/settings/SettingsSidebarNav.tsx`                                                                                | One icon in `SETTINGS_SECTION_ICONS`                                                                                                                  | The record is typed to demand an icon for every settings page                                                                                                                                                              |
| `apps/web/src/routeTree.gen.ts`                                                                                                          | The generated entries for `/ext/$environmentId/$name/$` and `/settings/extensions`                                                                    | Generated from the routes directory; regenerate rather than edit (`@tanstack/router-generator`, or any `vite dev`/`build` of the web app)                                                                                  |
| `packages/shared/src/devProxy.ts`                                                                                                        | Adds `/ext-api` and `/ext-assets` to `DEV_PROXIED_PATH_PREFIXES`                                                                                      | The list is the one place the Vite proxy map and the server's dev catch-all both read; a seam route missing from it is answered by Vite in dev and the extension cannot mount                                              |
| `packages/contracts/src/settings.ts`                                                                                                     | One `extensions` field on `ServerSettingsPatch`, so the supervisor can write the list through the settings service                                    | The patch schema is the only way to write settings, and the change it emits is what makes install and remove take effect without a restart                                                                                 |
| `packages/shared/src/serverSettings.ts`                                                                                                  | `applyServerSettingsPatch` replaces `extensions` wholesale instead of deep-merging it                                                                 | `deepMerge` walks arrays index by index, so a patch that drops the last entry would leave it in place and uninstall would silently do nothing                                                                              |
| `apps/server/src/server.test.ts`                                                                                                         | `subscribeChanges` on the mocked settings service, matching its existing `streamChanges: Stream.empty`                                                | `Layer.mock` throws for anything unlisted, and the supervisor acquires the subscription while the routes layer is built                                                                                                    |
| `apps/web/src/projectIdentity.ts`                                                                                                        | Re-exports `deriveProjectIdentity` from `@t3tools/shared/projectIcon` instead of computing it here                                                    | The server resolves the same automatic icon for `extensions.projectIcons`; one copy is what stops the two drifting, and `packages/shared/src/projectIcon.ts` is that copy                                                  |
| `packages/shared/package.json`                                                                                                           | The `./projectIcon` subpath export                                                                                                                    | Subpath exports are declared in the package manifest                                                                                                                                                                       |
| `apps/server/src/cli/pair.ts`                                                                                                            | A `--extension <name>` branch minting an extension credential instead of a browser pairing link                                                       | `t3 pair` is where a human already goes for a credential                                                                                                                                                                   |
| `apps/desktop/src/electron/ElectronProtocol.ts`                                                                                          | The handler answers `/__ext-remote/…` and `/ext-assets/…` from the backends that own them, before the serving-mode dispatch                           | The renderer's origin is registered in one place, and a bundle can only execute from that origin. See the 2026-09-17 uptake note before resolving a conflict here                                                          |
| `apps/desktop/src/electron/ElectronProtocol.test.ts`                                                                                     | Packaged-mode and development-mode tests for both bridges, and the refusals                                                                           | Mirrors the file above                                                                                                                                                                                                     |
| `apps/desktop/src/backend/DesktopBackendPool.ts`                                                                                         | The primary instance's `onReady` / `onShutdown` also remember and forget the extension asset bridge's destination                                     | The bridge's destination has to expire with the backend, and these callbacks are the only party that knows when it comes and goes                                                                                          |
| `apps/desktop/src/backend/DesktopBackendPool.test.ts`                                                                                    | A `window` override on the harness, and a real-run test that the bridge follows readiness and shutdown                                                | Mirrors the file above                                                                                                                                                                                                     |
| `apps/web/src/main.tsx`                                                                                                                  | The `vite:preloadError` listener ignores an extension bundle's failure, and a fork-owned cooldown puts a floor under the reload guard                 | The listener is registered once at startup; there is no slot to register another into                                                                                                                                      |

The migration guard, and the fatal-startup marker that surfaces it in the desktop app, are
candidates to send upstream (see the spike note), which would retire six of these rows from
this table.

Fork-owned new files carry no uptake risk and are not listed here:
`packages/shared/src/fatalStartup.ts` (the fatal-startup marker's format, shared by both
sides of the process boundary), `scripts/extensionGuide.ts` and
`scripts/generate-extension-guide.ts` (the guide generator),
`scripts/extension-guide/scaffold-preamble.md` (the one hand-written fragment of the
scaffold), `scripts/extensionGuide.test.ts` and `scripts/vendoredProtocol.test.ts` (the drift tests), the two generated guides under
`docs/internals/extensions/`, `.prettierignore` (which keeps the formatter off them),
`.github/workflows/extension-seam.yml`, `packages/shared/src/extensionRemoteAssets.ts` (the
one definition of the asset paths, shared by the renderer that builds them and the handler
that answers them), and `apps/web/src/lib/chunkReloadCooldown.ts` with its test — that last
pair sits in an upstream directory but is a new file, deliberately, so upstream can rewrite
`chunkReloadGuard.ts` without an uptake having to reconcile the fork's floor under it.

That floor narrows upstream's recovery path by a known amount, and the next uptake should
decide again rather than inherit it: **two genuine stale-deploy chunk failures inside the
same minute now get one reload between them**, and the second lands on the route's error
boundary until the minute is up. Accepted because the failure it replaces — a renderer
reloading five times a second, unreadable and unclosable — is worse than a delayed recovery.
If upstream ever gives its own guard a floor, drop this one.

The workflow sits beside upstream's `ci.yml` rather than inside it, so an uptake never has to
reconcile fork jobs with upstream's. Its runner, Node, and install lines are copied from
`ci.yml` on purpose: if upstream changes how it sets up, change this file to match.

The constants themselves live in `packages/shared/src/forkIdentity.ts`, a fork-owned file, so
each touch point above is an import plus a reference rather than a literal to re-reconcile.
The **tests deliberately hardcode the expected values** rather than importing those
constants: a test that reads the same constant as the code it checks cannot catch a wrong
value, and these are user-visible identity strings where the value is the thing worth pinning.

`rpc.ts` and `RpcAuthorization.ts` follow the `orchestration.ts` split: the schemas and
method names live in the fork's own `extensions.ts`, and only the registration lives in the
host's files.

Still to come, and expected to add rows: the desktop launch flag for a shipped extension.

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

## Bundling an extension in the desktop build

The desktop ships extensions as ordinary launch flags, not as a concept the server knows
about. Set `T3CODE_BUNDLED_EXTENSIONS` when building the desktop artifact, naming one or more
**built** folders as `name=path` (comma or whitespace separated; paths relative to the
repository root or absolute):

```bash
T3CODE_BUNDLED_EXTENSIONS=bach=../bach/dist node scripts/build-desktop-artifact.ts --platform mac
```

Each folder is copied to `Contents/Resources/extensions/<name>/`, and at launch the desktop
passes `--extension <name>=<that path>` for every subfolder there that has an
`extension.json`. The default is none, so an ordinary build ships nothing.

The build fails if a named folder is missing or has no manifest — a build that silently
shipped nothing would be discovered by a user, not by CI. The folder is deliberately **not**
inside `app.asar`: the server spawns each extension with its folder as the working directory,
and a path inside an asar cannot be a `cwd`
([spike](extensions/spikes/electron-runtime.md) §3). It also means a bundled extension can
only be replaced by an app update — which is exactly what the settings-entry override is for.

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

## Fork identity — as built

All values live in `packages/shared/src/forkIdentity.ts`; nothing else hardcodes them.

| Knob                                 | Value                                                                             |
| ------------------------------------ | --------------------------------------------------------------------------------- |
| App id (release / dev)               | `com.ashakirzianov.t3code-extensible` / `com.ashakirzianov.t3code-extensible.dev` |
| Electron `userData` dir              | `t3code-extensible` / `t3code-extensible-dev`                                     |
| Legacy `userData` dir (never hit)    | `T3 Code Extensible (Alpha)` / `T3 Code Extensible (Dev)`                         |
| Linux desktop entry / WM class       | `t3code-extensible.desktop` / `t3code-extensible`                                 |
| Linux capture helper dir / KDE entry | `t3code-extensible` / `com.ashakirzianov.t3code-extensible.KdeCapture.desktop`    |
| Updater publish repo (default)       | `ashakirzianov/t3code-extensible`                                                 |
| systemd unit / launchd label         | `t3code-extensible.service` / `com.ashakirzianov.t3code-extensible.service`       |
| URL scheme                           | `t3code://` — **unchanged**, shared with upstream                                 |
| T3 home                              | `~/.t3` — **unchanged**, shared with upstream                                     |
| Display / product name               | `T3 Code (Alpha)` — **unchanged** (see below)                                     |

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

**The Linux capture identity follows the desktop entry, not the bundle id.** Upstream's
screen-capture feature derives its runtime app id from the Linux desktop entry name
(`DesktopSnapShot.ts` strips the `.desktop` suffix), which is the WM-class family — so
the portal identity, the Hyprland and niri bind strings, and the D-Bus bus name
(`<appId>.SnapShot`) were already the fork's the moment the desktop entry was renamed.
The literals that did have to move are the ones upstream spells out: the shared XDG
directory the KDE, Hyprland, and GNOME helpers install into, and the KDE helper's own
`NoDisplay` desktop entry, which both apps would otherwise write to the same filename
in `~/.local/share/applications`.

Left alone on purpose: `NIRI_CAPTURE_PATH` and `NIRI_CAPTURE_INTERFACE`
(`linuxCaptureSession.ts`) still read `com.t3tools`. A D-Bus object path and interface
name are scoped to the connection that exports them, and the _bus name_ around them is
already forked, so two installs do not collide. Renaming them would be churn in a file
every uptake touches.

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

**Never use `git stash` here.** The stash stack is shared by every worktree of this repository, and several builders work in worktrees at once; a mistimed `stash pop` takes someone else's work. Compare with `git diff` or a scratch branch instead.

Agents spawned by the desktop app inherit `ELECTRON_RUN_AS_NODE=1` into their shell. One
upstream test (`build-desktop-artifact.test.ts`, the cross-architecture Windows probe) asserts
that variable is absent from spawned commands and fails under that inheritance. Run tests
with `env -u ELECTRON_RUN_AS_NODE vp test run …` when your shell has it set.
