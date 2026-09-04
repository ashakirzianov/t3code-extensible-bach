# Extension scaffold

Every file of the reference extension, the worked example that exercises each seam of the
protocol exactly once: a tool, an HTTP route, a web entry, a badge, and its own SQLite
database. Copy it and delete what you do not need.

The reference extension is **standalone on purpose**. It has ordinary dependencies, its own
build, and belongs to no workspace, so everything below works the same in a repository of
your own.

## Starting from it

1. **Copy the folder** and rename it. `package.json` `name`, and the `name` in
   `src/server/manifest.ts`, are yours to change; the manifest name must be lowercase
   kebab-case.
2. **Install** with `pnpm install --ignore-workspace`. The flag matters: without it, pnpm
   walks up to a parent workspace and installs into it instead.
3. **Build** with `pnpm build`. This writes `dist/`, which is what the host runs: the server
   entry and, if you keep the web entry, an ES module the client imports.
4. **Vendor the protocol types.** The reference extension keeps a copy of
   `packages/contracts/generated/extensions/protocol.d.ts` under `protocol/`; it is generated,
   dependency-free, and not reproduced here. Take it from the host repository, or work from
   the JSON Schema if you are not writing TypeScript.
5. **Point the host at it** with a settings entry naming the built folder, `dist/`. The host
   spawns the server entry on its own Node and passes everything it needs — name, token,
   WebSocket URL, data directory — as `T3_EXT_*` environment variables.

Nothing is inferred from the process: resolve your own files from `import.meta.url` rather
than `cwd`, treat the extension folder as read-only, and write only under the data directory
the host gives you.

## What is not here

The lockfile, the tests, the vendored protocol copies, and anything built. The tests are
worth reading in the host repository under `extensions/reference/test/` — they are what keeps
this scaffold honest.
