# `dev:desktop` runs a stale server — assessment

> Requested by the Lead 2026-07-27 after this cost an hour and made three shipped features read as broken.
>
> **Status: B + B2 built, A rejected. `vite.config.ts` untouched.** The detector lives in `scripts/lib/bach-server-staleness.ts` with its call site in `dev-runner.ts`; the agent-facing build stamp is `apps/server/src/bach/buildStamp.ts`, surfaced on `bach_ping`.
>
> **Note the recursion: both are themselves server/runner changes, so neither exists until the dev runner is restarted.** They cannot help with the restart that installs them — the first restart is still the unaided one.

## The bug, measured

```
apps/server/dist/bin.mjs            mtime 16:53:59   "archive_agent": 0 hits
apps/desktop/dist-electron/main.cjs mtime 17:38:41   "archive_agent": 0 hits
```

16:53:59 is when the dev-runner started. The server bundle has never been rebuilt since; the archive tools landed at ~17:22. The Electron bundle _did_ rebuild and is still stale because it does not contain the server at all — it **spawns** it.

**Cause:** `apps/desktop/vite.config.ts` declares the desktop `dev` task with `dependsOn: ["t3#build"]`. That is a one-shot build, not a watch. `dev:desktop` therefore compiles `apps/server` exactly once, at startup, and never again.

**The symptom is absence.** A server-side change does not fail loudly — the tool simply is not there, the column simply is not returned. Nothing distinguishes "not built" from "not written".

## Why only `dev:desktop` has this problem

| Mode                | How the server runs                                            | Picks up source edits? |
| ------------------- | -------------------------------------------------------------- | ---------------------- |
| `dev`, `dev:server` | `node --watch src/bin.ts` — **from source**                    | **Yes**, immediately   |
| `dev:desktop`       | Electron spawns `apps/server/dist/bin.mjs` — **from a bundle** | **No**                 |

`apps/desktop/src/app/DesktopEnvironment.ts:189` sets `backendEntryPath` to `apps/server/dist/bin.mjs`, and the backend manager spawns it as a child process. So desktop is the only mode that consumes a build artefact, and it is the only mode with no watcher feeding it.

## The reload machinery already exists

`apps/desktop/scripts/dev-electron.mjs` **already watches the server bundle**:

```js
const watchedDirectories = [
  { directory: "dist-electron", files: new Set(["main.cjs", "preload.cjs"]) },
  { directory: "../server/dist", files: new Set(["bin.mjs"]) }, // ← already there
];
```

A change to `bin.mjs` fires `scheduleRestart()` → Electron restarts → it spawns the new bundle. **Upstream clearly anticipated the server bundle changing during desktop dev.** The only missing link is that nothing writes a new `bin.mjs`.

So "can it watch-build?" is not a question of plumbing. The plumbing is complete.

## Option A — watch build of `apps/server`. **Recommend against.**

Mechanically it would work: swap the one-shot dependency for something that runs `vp pack --watch` in `apps/server`, and the existing watcher does the rest.

**The disqualifying objection is self-hosting.** Every save under `apps/server` would rebuild `bin.mjs`, fire the watcher, and restart Electron — which kills **every agent's MCP session in the fleet**. Bach agents edit `apps/server` constantly; that is the whole Bach layer. Today they survive doing so _precisely because nothing rebuilds_. Turning that on converts a once-per-session restart into a fleet-fatal event on every keystroke-save, in the one repo where the developers are the fleet.

That is the self-hosting hazard in its purest form: the fix would destabilise the substrate to shorten a feedback loop.

Three lesser objections, any one of which would want handling anyway:

1. **`clean: true`** on the server pack (`apps/server/vite.config.ts`) wipes `dist/` on each rebuild — including `dist/client`, the web app that `t3#build` copies in. A watch build would delete it on every save.
2. **Rebuild cost.** `vp pack` on `apps/server` bundles a large dependency tree; this is seconds per save, not milliseconds, and `dev-electron`'s 120 ms restart debounce will not absorb it.
3. **Fork surface.** `apps/desktop/vite.config.ts` is an upstream file, changed for a workflow gain rather than a defect in Bach's own layer.

## Option B — a staleness detector. **Recommend, with a correction.**

**The Lead's suggested placement does not work.** A check _at startup_ comparing bundle mtime to source mtime will never fire: `t3#build` runs as part of that same startup, so the bundle is freshly correct at exactly the moment the check would run. The staleness is created later, by an agent editing source against an already-running server.

The detector has to run **while the runner is up**, at the moment the mistake is made:

- Watch `apps/server/src` (and the workspace packages the bundle inlines) from inside `dev-runner.ts`.
- When a source file becomes newer than `dist/bin.mjs`, print once, loudly:
  `[dev-runner] apps/server changed — the RUNNING server is still the bundle built at <time>. Restart the dev runner to load it.`
- Print once per staleness episode, not per file, or it becomes wallpaper.

**Why this beats the rebuild.** It cannot destabilise anything — it only prints. It fires at the moment of the mistake rather than an hour later. And it is honest about the real constraint instead of hiding it: on this stack, a server change genuinely does require a deliberate restart, and the restart should stay deliberate because it takes the fleet with it.

This is Bach-owned: a new module plus one call site in `dev-runner.ts`, alongside the orphan sweep that is already there. No upstream config change.

### Option B2 — let agents self-check, cheaply

The human sees the runner's log; an agent does not. Stamp the server's build time into the bundle and return it from `bach_ping`. Then any agent can answer "is my change actually live?" in one call, instead of inferring it from a missing tool — which is exactly the inference that went wrong today, twice.

Small, additive, entirely within the Bach layer, and it closes the loop for the population that actually hits this.

## Recommendation

**B + B2. Not A.**

The one-line reason: the feedback loop is slow because restarting is expensive, and restarting is expensive because every agent lives inside the thing being restarted. A watch build does not remove that cost — it just triggers it more often, without asking.

If the loop later proves genuinely painful, the targeted fix is not a watch build but **Option C: point the desktop backend at `src/bin.ts` under `node --watch` in dev**, matching what `dev`/`dev:server` already do. That removes the bundle from the dev path entirely rather than rebuilding it constantly. It is a deeper change to upstream desktop config and was not assessed here.
