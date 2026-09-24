# Extension scaffold

Every file of the reference extension, the worked example that exercises each seam of the
protocol exactly once: a tool, a resource, its standing instructions, an HTTP route, a web
entry, a badge, and its own SQLite database. Copy it and delete what you do not need.

The reference extension is **standalone on purpose**. It has ordinary dependencies, its own
build, and belongs to no workspace, so everything below works the same in a repository of
your own.

## Starting from it

1. **Copy the folder** and rename it. `package.json` `name`, and the `name` in
   `src/server/manifest.ts`, are yours to change; the manifest name must be lowercase
   kebab-case.
2. **Install** with `pnpm install`. The `pnpm-workspace.yaml` in the folder is what keeps
   this local — it makes the directory a workspace root, so pnpm installs here rather than
   walking up to a parent workspace. Do not add `--ignore-workspace`: that skips the file,
   including the build allowance it carries, and the install fails.
3. **Build** with `pnpm build`. This writes `dist/`, which is what the host runs: the server
   entry and, if you keep the web entry, an ES module the client imports.
4. **Vendor the protocol types.** The reference extension keeps copies of
   `protocol.d.ts` and `protocol.schema.json` under `protocol/`; they are generated,
   dependency-free, and not reproduced here. Take them from the host repository's
   `packages/contracts/generated/extensions/`, or work from the JSON Schema alone if you are
   not writing TypeScript. Copy them again whenever you move to a newer protocol version —
   they are a snapshot, and nothing warns you when the host has moved on.

   The `sync:protocol` script you will see in `package.json` is how the in-tree reference
   extension does that same copy: it lives inside the host repository, so it can script it
   against a relative path and have a test fail when the copy falls behind. Outside the
   repository there is no such path, so drop the script — the copy is the part that matters,
   not how it is made.

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
