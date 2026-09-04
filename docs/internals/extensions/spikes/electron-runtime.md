# Spike: extensions on the Electron runtime

Verification spike for design §11 ("verify in the first build, not assume"). Three
questions, answered empirically against this repo at `d7cf8aaa8` on macOS 15
(darwin 25.5.0, arm64). Throwaway harnesses live in the `spike/electron-runtime`
worktree under `.spike/`, `apps/desktop/.spike-q2/`, `apps/desktop/.spike-q3/`
and `apps/web/public/spike-ext/`; nothing here is committed.

Environment for every run below: Electron **43.4.1**, Node **24.18.1**,
Chromium **150.0.7871.224**, darwin arm64.

---

## 1. Web bundle under Electron CSP

**Answer: dynamic `import()` of a same-origin URL served by the server works today
with no host change. `blob:`, `data:`, cross-origin `http(s):`, and `eval` are all
blocked. Serve the bundle at a same-origin path and `import()` it.**

### The CSP that actually applies

The desktop renderer does not load the web app over http. It loads
`t3code://app/` (prod) or `t3code-dev://app/` (dev) — `DesktopWindow.ts:337`
calls `getDesktopUrl`, and `DesktopApp.ts:184` registers a protocol handler that
proxies that origin to the backend (dev: the Vite dev server). Every proxied
response gets a CSP header stamped on it by
`apps/desktop/src/electron/ElectronProtocol.ts:99-107`, built by
`makeDesktopContentSecurityPolicy` (`ElectronProtocol.ts:67-97`).

**Dev and prod run the same code path**, so a dev desktop build is a faithful
test: the only difference is the scheme name and whether a Clerk origin is
appended to `script-src`.

There is no other CSP in play. `apps/web/index.html` has no `<meta>` CSP, and the
server never puts a CSP on the SPA shell — the policies in `apps/server/src/http.ts`
(`:105`, `:120`, `:126`, `:130`) apply only to agent-output previews, SVGs and
downloads. Verified: `curl -D-` against the running dev web server and the T3
server both return the app shell with no `content-security-policy` header.

Read back live from the renderer (`fetch(location.href).headers.get('content-security-policy')`):

```
default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://challenges.cloudflare.com;
connect-src 'self' http: https: ws: wss:; img-src 'self' t3code-dev: blob: data: http: https:;
media-src 'self' t3code-dev: blob: http: https:; style-src 'self' 'unsafe-inline';
font-src 'self' t3code-dev: data:; worker-src 'self' blob:;
frame-src 'self' https://challenges.cloudflare.com; form-action 'self'
```

Document origin: `t3code-dev://app`, `isSecureContext=true` (the scheme is
registered `standard: true, secure: true` at `ElectronProtocol.ts:112-135`).

### What executes, measured

Driven over CDP against the live dev desktop renderer
(`T3CODE_DESKTOP_REMOTE_DEBUGGING_PORT=9333`, target `t3code-dev://app/`), with a
stand-in extension bundle served from `apps/web/public/spike-ext/bundle.js`:

| Strategy                                                               | Result                                                                                                                 |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `import('/spike-ext/bundle.js')` — same-origin absolute path           | **OK** — `exports=default,manifest,mount,unmount`, `mount()` returned `{"mounted":true,"subPath":"/a","mountCount":1}` |
| Nested `import('./chunk.js')` from inside that module (code splitting) | **OK** — `nested-chunk-loaded`                                                                                         |
| `import('/spike-ext/bundle.js?token=sig.abc123')` — query-string token | **OK** — `exports=default,manifest,mount,unmount`                                                                      |
| `<script type="module" src="/spike-ext/bundle.js">` element injection  | **OK** — loaded                                                                                                        |
| `import(blobUrl)` from fetched text                                    | **BLOCKED**                                                                                                            |
| `import('data:text/javascript,…')`                                     | **BLOCKED**                                                                                                            |
| `import('http://127.0.0.1:5859/spike-ext/bundle.js')` — cross-origin   | **BLOCKED**                                                                                                            |
| `eval` / `new Function` from page context                              | **BLOCKED**                                                                                                            |
| `new Worker(blobUrl)`                                                  | **OK** — `worker-src 'self' blob:` allows it                                                                           |

The three blocked import forms each produced an explicit violation, e.g.:

```
Loading the script 'blob:t3code-dev://app/6dbcd05f-…' violates the following
Content Security Policy directive: "script-src 'self' 'unsafe-inline'
'wasm-unsafe-eval' https://challenges.cloudflare.com". Note that
'script-src-elem' was not explicitly set, so 'script-src' is used as a
fallback. The action has been blocked.
```

and `eval` from page context:

```
EvalError: Evaluating a string as JavaScript violates the following Content
Security Policy directive because 'unsafe-eval' is not an allowed source of
script: script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' …
```

> **Measurement caveat worth repeating.** `eval`/`new Function` evaluated
> _directly_ through `Runtime.evaluate` reported `OK 42` — DevTools evaluation
> bypasses the eval check. The table above reports the result from genuine page
> context (the probe functions live in a module loaded by same-origin `import()`),
> which is the honest answer. Any future CSP probing here must run from page
> context, not from the console.

### Implication for the seam

- **Recommended loader: `import()` of a same-origin path served by the T3 server.**
  No change to `makeDesktopContentSecurityPolicy` is required. This is the only
  strategy that needs zero host CSP change.
- **Auth must live in the URL, not a header.** `import()` cannot set an
  `Authorization` header. The repo already has exactly the right precedent:
  `apps/server/src/assets/AssetAccess.ts:545-547` mints
  `/api/assets/<base64payload>.<hmac>/<filename>` — an HMAC-signed claims blob as
  a path segment, 1h TTL (`ASSET_TOKEN_TTL_MS`). An extension bundle route should
  copy that shape. Query-string tokens also import fine (verified) if a path
  segment is awkward.
- **The bundle must be statically analysable ES module output — no `eval`.**
  `'unsafe-eval'` is absent, so bundler modes that emit `eval()` (webpack
  `devtool: 'eval-source-map'` / `eval-cheap-*`, dev-mode HMR wrappers) will not
  run under the desktop. The scaffold must pin a production, non-`eval` output
  mode. Nested/code-split dynamic imports are fine, so chunked builds are fine.
- **Multi-environment is the one real constraint.** `connect-src` allows
  `http:`/`https:`, so the renderer can _fetch_ a bundle from a remote
  environment, but `script-src 'self'` means it cannot _execute_ it from that
  origin, and the fetch-then-`blob:` escape hatch is blocked too. The desktop
  protocol handler proxies `t3code://app/*` to a single `targetOrigin`
  (`ElectronProtocol.ts:143-186`). Two ways out:
  1. **Proxy the bundle through the local backend** so every extension bundle is
     same-origin regardless of which environment owns it. Keeps the CSP as tight
     as it is now. Recommended.
  2. **Add `blob:` to `script-src`** — a one-token change to
     `ElectronProtocol.ts:71-77` that enables fetch-from-anywhere-then-import.
     Cheaper, but it means any script-injection bug in the host becomes arbitrary
     code execution. Not recommended.
- **The browser surface is unconstrained.** No CSP is applied to the app shell by
  the server, so web (`app.t3.codes` and `npx t3`) will run any of these
  strategies. Design to the desktop's constraint and web follows for free.

---

## 2. Spawning a child on the app's Node with `node:sqlite`

**Answer: works, unflagged. `spawn(process.execPath, [entry], { env: { …, ELECTRON_RUN_AS_NODE: "1" } })`
gives a plain Node 24.18.1 child with `node:sqlite` available. No flag, no extra
env. The one hard requirement is that `ELECTRON_RUN_AS_NODE` is _set_ for the
child — and, separately, _stripped_ when you do not want it.**

### The precedent already in the repo

`apps/desktop/src/backend/DesktopBackendConfiguration.ts:503-512` is exactly the
shape the extension seam needs — it is how the desktop spawns the T3 server today:

```ts
executablePath: process.execPath,
args: [environment.backendEntryPath, "--bootstrap-fd", "3"],
cwd: environment.backendCwd,
env: { ...backendChildEnvPatch(), ELECTRON_RUN_AS_NODE: "1" },
extendEnv: true,
```

Incidental confirmation from this very spike: the agent process writing this doc
was itself running with `ELECTRON_RUN_AS_NODE=1` and
`__CFBundleIdentifier=com.t3tools.t3code` inherited from the live desktop app —
i.e. the server, and everything it spawns, already runs on Electron's Node in
production.

### Measured

Harness `apps/desktop/.spike-q2/` (an Electron main process spawning
`child.mjs`, which does `import "node:sqlite"`, opens a database under the app's
T3 home, writes a row and reads it back).

| Case                                                                 | Result                                                                                                                                                                                  |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A.** `ELECTRON_RUN_AS_NODE=1` (repo precedent)                     | **exit 0.** `versionsNode=24.18.1`, `versionsElectron=43.4.1`, `execArgv=[]`, `hasDatabaseSync=true`, `requireResolveWorks=true`, `roundTrip="written-from-electron-node"`, `stderr=""` |
| **B.** no `ELECTRON_RUN_AS_NODE`                                     | Script _ran_ (`node:sqlite` worked) but the process **never exited** — it stayed alive as a GUI Electron app. Killed at 8s.                                                             |
| **C.** `ELECTRON_RUN_AS_NODE=1` + `--experimental-sqlite`            | **exit 0.** Identical; `execArgv=["--experimental-sqlite"]`. Flag accepted and unnecessary.                                                                                             |
| **D.** minimal env (`PATH` + `HOME` only) + `ELECTRON_RUN_AS_NODE=1` | **exit 0.** Identical round trip.                                                                                                                                                       |

The database was written to
`<worktree>/.t3/userdata/extensions/spike/extension.sqlite` and read back from a
**separate** process (the host's own Node 24.19.0):

```
read back from host node: [{"id":1,"note":"written-from-electron-node"}]
```

`stderr` was empty in every passing case — `node:sqlite` emits no
`ExperimentalWarning` on this runtime.

### Implication for the seam

- **Exact incantation** (matching `DesktopBackendConfiguration.ts`):
  ```ts
  spawn(process.execPath, [manifest.entry], {
    cwd: extensionFolder, // a real directory — see Q3
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      T3_EXT_DATA_DIR: dataDir,
      T3_EXT_TOKEN: token,
      T3_EXT_PROTOCOL: "1",
    },
    stdio: ["ignore", "pipe", "pipe"], // host captures logs (design §5.4)
  });
  ```
- **No flag for `node:sqlite`,** and no `NODE_OPTIONS` needed. Both
  `import "node:sqlite"` and `require("node:sqlite")` resolve.
- **`ELECTRON_RUN_AS_NODE` must be set explicitly, not inherited.** Case B is the
  failure mode: omit it and you get a GUI Electron process that never exits and
  leaks a dock icon. Conversely the repo strips it in three places precisely
  because it leaks _into_ children —
  `apps/desktop/scripts/dev-electron.mjs:54`, `start-electron.mjs:13`, and
  `apps/server/src/terminal/Manager.ts:86` (`TERMINAL_ENV_BLOCKLIST`). The
  extension seam should set it deliberately, and any _user-facing_ subprocess an
  extension spawns must strip it again.
- **Nothing native to ship**, confirming design §5.4: the extension gets the
  same `node:sqlite` the server's own `NodeSqliteClient.ts` uses.
- **Not verified:** Windows and Linux packaged runtimes. The mechanism is
  identical (Windows already runs its server from `server.asar` through the same
  `ELECTRON_RUN_AS_NODE` path, `build-desktop-artifact.ts:995`), but it was not
  exercised here.

---

## 3. Running from the read-only app bundle

**Answer: both shapes work. A folder shipped as `extraResources` (real files) and
a folder inside `app.asar` can each be spawned from and read from. The only hard
asar restriction is that a path inside the archive cannot be a `cwd`. Ship
bundled extensions as `extraResources`; that is the shape with no caveats.**

A packaged build **was feasible** on this machine, unsigned:
`node scripts/build-desktop-artifact.ts --platform mac --target dir --arch arm64 --skip-build --keep-stage`
completed (`skipped macOS application code signing … CSC_IDENTITY_AUTO_DISCOVERY=false`).
Signing defaults to off (`build-desktop-artifact.ts:1566`, `:3761`). All the
results below are from that real `.app`.

### How the desktop is packaged

- **`app.asar` is fully packed on all platforms** — `build-desktop-artifact.ts:2596-2599`.
  Measured: `Contents/Resources/app.asar` is 201,835,171 bytes and contains the
  whole repo tree, including `apps/server/dist/bin.mjs` (8,616,917 bytes).
- **electron-builder's smart-unpack** pulls native code out to
  `Contents/Resources/app.asar.unpacked/` — measured: `node-pty`,
  `@napi-rs/keyring`, `@clerk/electron-passkeys`, `@ff-labs/fff-bin-*`,
  `msgpackr-extract`, `@yuuang/ffi-rs-*`, each logged `not packed into asar
archive … reason=contains executable code`.
- **`extraResources` is the escape hatch for real files** — `DESKTOP_EXTRA_RESOURCES`
  (`build-desktop-artifact.ts:1089-1094`) ships `resource-monitor`; Linux adds
  `browser-secret`; Windows adds the hand-packed `server.asar` sidecar. Measured:
  `Contents/Resources/resource-monitor/t3-resource-monitor` (545,776 bytes, mode 755).
- **The shipped app already spawns from inside `app.asar`.**
  `DesktopEnvironment.ts:212` sets `backendEntryPath = <appPath>/apps/server/dist/bin.mjs`,
  and when packaged `appPath` _is_ `app.asar`. Note `:213`:
  `backendCwd: input.isPackaged ? homeDirectory : appRoot` — the cwd is
  deliberately moved out of the archive. That line is the existing, in-production
  acknowledgement of the constraint measured below.

### Measured — spawning from the bundle

Harness `apps/desktop/.spike-q3/` packs a fixture extension folder
(`manifest.json`, `server.mjs`, `web/bundle.js`) into an asar and spawns it three ways:

| Case                                                                                 | Result                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A.** entry inside `app.asar`, `cwd` = userdata dir                                 | **exit 0.** Read its own `manifest.json` from inside the archive; recursive `readdirSync` + content hash of the whole folder succeeded; write into the bundle blocked (`ENOTDIR`); `node:sqlite` round trip into userdata OK |
| **B.** entry inside `app.asar`, `cwd` = inside the archive                           | **`Error: spawn ENOTDIR`** — a path inside an asar cannot be a `cwd`                                                                                                                                                         |
| **C.** entry in a read-only real directory (`chmod 555`, the `extraResources` shape) | **exit 0.** Same checks pass; write into the folder blocked (`EACCES`)                                                                                                                                                       |

**The folder content hash was byte-identical across all three shapes**
(`04e01552bda890be`), so a hash-gated deploy (design §6.3) behaves the same
whether the folder ships inside the archive, as loose resources, or on disk.

### Measured — the real packaged `.app`

The fixture was copied to `Contents/Resources/extensions/spike-bundled-ext/`,
made read-only, and spawned using the packaged app's **own** binary
(`Contents/MacOS/T3 Code (Alpha)`, i.e. what `process.execPath` would be) with
`ELECTRON_RUN_AS_NODE=1`:

```json
{
  "here": "/…/T3 Code (Alpha).app/Contents/Resources/extensions/spike-bundled-ext",
  "node": "24.18.1",
  "checks": {
    "readManifest": "spike-bundled-ext",
    "folderHash": "04e01552bda890be",
    "folderEntries": ["manifest.json", "server.mjs", "web/bundle.js"],
    "writeIntoBundle": "blocked: EACCES",
    "sqliteRoundTrip": "bundled-ext-wrote-here",
    "dataDir": "/…/.t3/userdata/extensions/spike-bundled-ext"
  }
}
```

That is the question as asked: **a script placed in resources runs on the app's
own Node and writes to the userdata directory.**

Asar path resolution in the packaged runtime, same binary:

```
readdir inside app.asar: [ 'BunPtyAdapter-B9JDpcEx.mjs', 'BunPtyAdapter-B9JDpcEx.mjs.map', 'Config-DgvH66dl.mjs' ]
statSync bin.mjs size: 8616917
read first line of bin.mjs: #!/usr/bin/env node
write into app.asar blocked: ENOTDIR
```

### The bundle is sealed

- **`ElectronAsarIntegrity` is set in `Info.plist`** with a SHA256 of
  `Resources/app.asar` (`3927e1febcf8c6514778674d77c5449a95df813fc0242dadd9265bd4ea81adcf`),
  and `@electron/asar`'s header carries per-file block hashes. **`app.asar`
  cannot be modified after the build.** A bundled extension living inside it must
  be added at build time.
- This local build is `Signature=adhoc, linker-signed`, `Sealed Resources=none`,
  so adding files to `Contents/Resources/` did not break it _here_. A properly
  signed and notarized release **does** seal `Resources`, so the same edit would
  break the signature on a shipped build. Either way, the app bundle is read-only
  at runtime — measured `EACCES` / `ENOTDIR` on every write attempt.
- **Not verified:** whether the `EnableEmbeddedAsarIntegrityValidation` fuse is
  actually flipped on (the `Info.plist` entry is present, which is the evidence I
  have). `@electron/fuses` is not installed in this repo and I did not add it.

### Implication for the seam

- **Ship bundled extensions as `extraResources` at `Contents/Resources/extensions/<name>/`**
  (Windows: `resources\extensions\<name>\`; Linux AppImage: `resources/extensions/<name>/`).
  Add one entry to `DESKTOP_EXTRA_RESOURCES` (`build-desktop-artifact.ts:1089`),
  alongside `resource-monitor`. Reasons: the folder can be its own `cwd`, ordinary
  file paths and `file:` URLs behave normally, and nothing about the extension's
  own tooling has to be asar-aware. Inside `app.asar` also works (case A) and is a
  legitimate fallback if installer file count matters — but it costs the `cwd` and
  makes every path caveat the extension author's problem.
- **Resolve the path from `process.resourcesPath`**, and follow the existing
  fallback-candidate pattern in `DesktopEnvironment.ts:268-271`
  (`resolveResourcePathCandidates`) so dev and packaged both resolve.
- **The folder is read-only. All extension writes go to the per-environment data
  directory** under userdata (design §5.4) — proven end to end above.
- **Hashing the folder works from inside the bundle** with plain
  `readdirSync` + `readFileSync`, in every shape, with identical results. The
  hash-gated deploy needs no special casing for bundled extensions.
- **A bundled extension can only be updated by an app update**, since the bundle
  is read-only and (on signed builds) sealed. That is exactly the behaviour
  design §6.3 already specifies — "an app update carrying a newer shipped
  version" is one of the three cases the single hash rule covers.

---

## Not verified

- Windows and Linux packaged runtimes (Q2 and Q3 mechanisms are shared, but only
  macOS arm64 was exercised).
- The `EnableEmbeddedAsarIntegrityValidation` fuse state (see Q3).
- Behaviour under a _signed and notarized_ macOS build — this build is ad-hoc
  signed with `Sealed Resources=none`.
- Serving a bundle from a genuinely remote/relay environment. The CSP conclusion
  for that case (Q1) is derived from the measured cross-origin block plus the
  single-`targetOrigin` proxy in `ElectronProtocol.ts:143-186`, not from a live
  two-environment run.
