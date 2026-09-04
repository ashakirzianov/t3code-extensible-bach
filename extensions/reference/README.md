# Reference extension

The worked example of a T3 Code extension. It exercises every seam in the
protocol exactly once — a tool, an HTTP route, a web entry, a badge, and its own
SQLite database — so that each one has a real implementation to point at.

It is **standalone on purpose**. It has its own `package.json` with ordinary
dependencies, its own build, and a vendored copy of the protocol types in
`protocol/`. It is not a member of the repo's pnpm workspace (whose globs are
`apps/*`, `infra/*`, `packages/*`, `scripts` — none match `extensions/*`), and it
imports nothing from it. Anything it can do, an extension in a repository of its
own can do.

## Build and test

```bash
pnpm install                      # installs here: pnpm-workspace.yaml makes this a root
pnpm build                        # emits dist/
pnpm test                         # builds, then runs the checks below
```

`pnpm build` emits the built folder the host runs (design §6.1):

| Path                  | What it is                                                            |
| --------------------- | --------------------------------------------------------------------- |
| `dist/extension.json` | The manifest, generated from `src/server/manifest.ts`                 |
| `dist/server.mjs`     | One self-contained entry; every dependency bundled, no `node_modules` |
| `dist/web/entry.js`   | An ES module exporting `mount` / `unmount`, with its own React        |
| `dist/web/entry.css`  | Styles, every selector scoped to `.t3ref-`                            |

## Where to look

Read in this order; the comments carry the reasoning.

| File                  | The seam it shows                                                 |
| --------------------- | ----------------------------------------------------------------- |
| `src/server/env.ts`   | The spawn contract: the four variables the host passes            |
| `src/server/rpc.ts`   | The wire protocol — the whole of it, in ~200 lines with no Effect |
| `src/server/main.ts`  | The lifecycle: hello, register, then `connect` last               |
| `src/server/tools.ts` | A tool, and why `invocation.caller` cannot be forged              |
| `src/server/http.ts`  | A route served under the host's origin and auth                   |
| `src/server/store.ts` | `node:sqlite` in the host-assigned data directory                 |
| `src/web/entry.tsx`   | `mount` / `unmount`, and the CSP rules the bundle must satisfy    |
| `src/web/styles.css`  | Scoping, because this CSS lands in the host's document            |

## Three constraints worth knowing before you copy this

- **No `eval`, anywhere in the web bundle.** The desktop renderer's
  `script-src` carries no `'unsafe-eval'`, so a bundler mode that emits `eval()`
  produces a bundle that cannot run at all. `build.mjs` fails the build on it.
- **Do not depend on `cwd`.** A bundled extension can ship inside the packaged
  app's `app.asar`, and a path inside an asar cannot be a process `cwd`. Resolve
  from `import.meta.url`.
- **Write only to the data directory.** The extension folder is read-only when
  it ships inside an app bundle, and `cwd` — though it is the extension folder
  today — cannot be one inside an `app.asar`.
- **Introduce yourself as `T3_EXT_NAME`, not as the manifest's name.** The token's
  subject is `extension:<name>`, and the host checks that `hello` and
  `extensions.connect` agree.

Both of the first two, and the `node:sqlite` availability the store relies on,
are measured in
[`docs/internals/extensions/spikes/electron-runtime.md`](../../docs/internals/extensions/spikes/electron-runtime.md).

## Upgrading the protocol

`protocol/protocol.d.ts` and `protocol/protocol.schema.json` are **copies** of
the host's generated contract, not links to it. To move to a newer protocol
version: re-copy both from
`packages/contracts/generated/extensions/`, bump `protocolVersion` in
`src/server/manifest.ts`, and run `pnpm test`. The manifest test fails if the
declared version and the vendored schema disagree, which is the drift this
layout is meant to make loud.
