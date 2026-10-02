# Maintaining the Bach fork

> **Superseded 2026-09-11 — kept as history.** The vendored fork this doc
> maintained was stripped from the repo once the live install migrated onto the
> `t3code-extensible` desktop build; Bach is an extension now, and upstream
> uptakes happen in `~/repos/t3code-extensible` under that repo's own
> conventions (`docs/internals/extensible-fork.md` there). The self-hosting
> hazard below is retired: the running app picks up new Bach bytes only through
> a human Deploy click. The uptake lessons remain true and moved with the fork.

Bach is a **private mirror fork** of T3 Code (`pingdotgg/t3code`, MIT). Upstream is fast-moving (pre-1.0), so we take frequent uptakes. This doc keeps that mechanical.

## ⚠️ The self-hosting hazard (read before merging)

**Bach is the substrate the agents run on, and agents do their work inside the Bach repo.** A merge therefore edits the running system from inside itself. This is not a theoretical risk — it bit us during the 2026-07-26 uptake.

The mechanism: Anton runs the desktop app via `bun run dev:desktop`, which is a **dev build with hot reload**. A merge rewrites hundreds of files over several seconds, so hot reload observes a _half-changed tree_ and reloads into it. The app can land in an un-runnable state well before the merge is finished.

The blast radius is larger than "the app restarts":

- The agent performing the merge is killed **mid-merge** — potentially with a conflicted, half-resolved working tree.
- **Every other live agent dies too**, not just the one merging.
- **Messages already _delivered_ can be lost** — though _not_ because the log is in-memory.

### Not every merge is the same risk (2026-07-26)

The danger is **duration and breadth of the half-changed window**, not "a merge happened". Two merges the same day, opposite outcomes:

| Merge                                    | Shape                                            | Outcome                                                              |
| ---------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------- |
| Upstream uptake (231 commits)            | hundreds of files rewritten over several seconds | **Killed the app and every live agent.** Watcher saw a partial tree. |
| Messaging protocol Phase 1 (`bcd42af05`) | 7 files, one `git merge`, no dependency change   | **Fleet survived.** No agent lost, app stayed up.                    |

What made the second safe, and what to reproduce:

- **Few files, applied by git in one operation** — the watcher never observes a partially-written tree.
- **No `package.json` / lockfile change**, so no `pnpm install`. This matters independently: reinstalling swaps `node_modules` underneath a running app (see Post-merge verification below). Check with `git diff --name-only <base>..<branch> | grep -E 'package.json|lock'` before landing.
- **Everything committed on both sides first**, so a mid-merge kill would have been survivable rather than leaving a conflicted tree.
- **Built in a worktree** (below), so only the final merge touched the watched tree.

So: treat a large uptake as fleet-fatal and schedule it. A small, additive, dependency-free merge is a different risk class and can land in a normal window — but confirm the shape rather than assuming it.

### What survives a restart, precisely (test-backed)

> **Rewritten 2026-07-27.** This section previously said delivered messages die with the recipient's conversation. **That is no longer true**, and the change is an improvement rather than a caveat — see below. Both cases are covered by tests in `bach/BachPersistence.test.ts`.

Since pointer-only delivery landed, **message content never travels in an injected turn**: the turn is a notification, and content is drained through `inbox` as a tool result. `delivered_at` therefore means **read**, not dispatched.

| Message state                       | Survives a restart?                                                                                                                                                                              | What to do                                            |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| **Unread** (`delivered_at IS NULL`) | **Yes**, whether or not the recipient was already notified. The queues rebuild from SQLite and the boot re-notifies — correct, since the agent may have died before acting on the first pointer. | **Do not re-send** — you will manufacture duplicates. |
| **Read** (drained via `inbox`)      | Not redelivered, by design. The recipient has it.                                                                                                                                                | Nothing to do.                                        |

**The hazard this section used to document is gone.** Content can no longer be lost to a conversation dying mid-flight, because content is never in flight — an unread message simply stays queued and is pointed at again. The old failure (a dispatched turn dying before the agent processed it, taking its content with it) is no longer reachable.

So the pre-restart instruction is simply: **commit your work.** The earlier advice about durably recording anything told-but-not-yet-acted-on covered content that lived only inside a delivered turn; that category no longer exists.

**Mitigations to consider — open options, not decided policy:**

- **Work in a git worktree** so the running app's tree is never touched. **Trialled successfully 2026-07-26** — the messaging-protocol Phase 1 build ran entirely in `/Users/ashakirzianov/repos/bach-wt-messaging` (its own branch, its own `node_modules` via `CI=true pnpm install`): edit, typecheck, lint and test all completed while the fleet kept running, and the watched tree was never written to. Two caveats worth knowing: a worktree needs its own dependency install (worktrees do not share `node_modules`), and it only defers the hazard — **landing** the branch into the watched tree is still a hot-reload event that has to be scheduled. This is the mitigation the open self-hosting decision (`bach/self-hosting-hazard` in the tracker) lists; the trial is evidence for closing it.
- Run the desktop app from a **production build** rather than `dev:desktop` while any agent is working in the `bach` tree, so hot reload is out of the picture. (Caveat before adopting this: `running.md` notes a Bach prod build shares `~/.t3/userdata` and app identity with an installed upstream T3 Code.)
- Or keep the dev build but **disable hot reload** for the duration.

Anton has not chosen among these yet. Until he does, assume an uptake will take the app and the agents down with it, and sequence the work so that is survivable: treat "a merge is about to land in `bach`" as worth announcing to live agents, **commit before anything that could kill you**, record durably anything you have been told but not yet acted on, and re-verify state after any unexplained restart.

### The orphaned-supervisor trap (2026-07-27) — and the diagnostic that finds it

Anton lost a morning to `dev:desktop` "running circles without ever starting". The cause was two hours old and looked nothing like the symptom.

**The diagnostic, first, because it is the part worth remembering:**

```
ps -eo pid,ppid,etime,command | grep dev-electron
```

**Any row with PPID 1 is an orphan.** The `etime` column dates it, and that date is usually the real start of the problem.

**Why it compounds.** `dev-electron.mjs` is the desktop supervisor. Orphaned, it keeps its `fs.watch` handles on `dist-electron/`, so it is not idle — on the next run's first rebuild its watcher fires, and its restart path runs `pkill -f --t3code-dev-root=<repo>`, which kills the **new** run's Electron too. Two supervisors watching one directory take turns killing each other's app.

**So retrying makes it worse.** Each Ctrl+C-and-retry left another orphan; three had accumulated by the time anyone looked. The natural response to a failing start actively deepened the failure, which is what made this cost hours rather than minutes.

**Fixed 2026-07-27** in `scripts/lib/bach-dev-orphans.ts` — a startup sweep (self-healing regardless of how the previous run died, including SIGKILL and reboots) plus a shutdown sweep of our own process group. The diagnostic above stays useful anyway, because it is how you confirm the sweep did its job.

**The generalisable lesson:** the symptom was a start that hung _now_; the cause was a process from two hours ago. When a dev tool misbehaves, `ps` for stragglers **before** retrying — and note that on this stack a retry is not free.

## Layout principle: upstream at root + additive Bach layer

- **T3 Code sources live at the repo root, unchanged.** We did _not_ relocate them into a subfolder — that would break the monorepo tooling and force a git subtree-merge strategy on every uptake.
- **Bach is additive.** New code in `apps/server/src/bach/` and `apps/server/src/mcp/toolkits/bach/`; new docs in `docs/bach/`.
- We edit upstream files only where unavoidable — a small, documented set (below).

## Remotes

- `origin` → `github.com/ashakirzianov/bach` (private)
- `upstream` → `github.com/pingdotgg/t3code`

(GitHub forks of a public repo are public, so Bach is a private _mirror_, not a GitHub fork. `LICENSE` and upstream copyright are kept intact, as MIT requires.)

## Working in this repo: the things that cost an hour to learn

> Written 2026-07-27 as a handoff. Every item below was paid for once already.

### Know whether your code is even running

**The web app hot-reloads; the server does not.** Under `dev:desktop` the server is built **once** at dev-runner start and Electron spawns the bundle, so a `apps/server` edit is invisible until the runner is restarted — and invisible as an **absence**: the tool isn't there, the field isn't returned. That is indistinguishable from code you never wrote, and it burned an hour and made three landed features read as broken.

The full assessment, with the rejected watch-build and the detector that once lived in the vendored tree, is `dev-server-staleness.md` — history now: Bach's extension deploys from its own `dist` and never runs through `dev:desktop` (`bach/stale-dev-server`, canceled 2026-09-30).

**Before concluding a server change is broken, call `bach_ping`.** It returns `serverBuiltAt`. If that predates your edit, the server simply hasn't got your code and nothing is wrong with it. This exists precisely because two agents got that inference wrong within ten minutes. Full analysis: `dev-server-staleness.md`.

**New MCP tools reach a live agent only after a server restart** (`messaging-protocol-design.md` §6.1) — `tools/list_changed` reaches zero recipients here. So changing the tool surface costs a fleet-disrupting restart; batch tool changes rather than trickling them.

#### ⚠️ But `packages/contracts` is a different file entirely — saving it KILLS THE FLEET (2026-07-31)

The rule above is about `apps/server/src`, and it is correct: nothing rebuilds
it under `dev:desktop`, which is why the fleet survives server edits. **It does
not extend to `packages/contracts`, and reading it as "server-side edits are
safe" cost a fleet-wide restart.** Every in-flight agent turn died mid-work.

**The chain:**

1. `apps/desktop`'s dev task is `vp pack --watch`, defined in `run.tasks` in
   **`apps/desktop/vite.config.ts`**. ⚠️ _Not_ in `package.json` — `vp run`
   resolves tasks from the vite config, and `apps/desktop/package.json` has no
   `dev` script at all. Looking there and finding nothing is not evidence
   against this step; it is looking in the wrong file.
2. 37 files under `apps/desktop/src` import `@t3tools/contracts` — including
   `preload.ts` and `electron/*`, i.e. the **main process**. So contracts is in
   the packed bundle's module graph and a save there triggers a rebuild.
3. `dev-electron.mjs` watches `dist-electron/main.cjs`, `preload.cjs` **and
   `../server/dist/bin.mjs`**, and **restarts Electron** when any of them
   changes.
4. Electron spawns `apps/server/dist/bin.mjs` as a **child**. The server is the
   MCP substrate, so it dies with its parent and takes every live agent turn
   with it.

**Step 2 is confirmed by observation, not only by reading imports:**

```
grep -c BachDiagnostic apps/desktop/dist-electron/main.cjs   # → 4
```

`BachDiagnostic` is a symbol that did not exist anywhere in this repo before it
was written into `packages/contracts/src/environmentHttp.ts` on 2026-07-31. Its
presence in the packed Electron **main process** bundle is direct evidence that
a contracts save lands there. Re-run that grep with any symbol you have just
added to contracts if you want to re-confirm the chain in one command.

#### The finding that outlives the chain: this config lies to a single read

**Three different mechanisms were asserted confidently for this one restart in a
single evening, and at most one was right.** The doc said the server is built
once (true, and irrelevant to contracts). An agent said the server runs under
`node --watch` (true of the `dev` / `dev:server` scripts, false for
`dev:desktop`). A third read `package.json`, found no `dev` script, and
concluded the `vp pack --watch` step was unverified (right file missing, wrong
conclusion).

**The cause is structural: the dev topology is spread across `dev-runner.ts`,
`vp` task definitions inside `vite.config.ts`, per-app `package.json` scripts,
and `dev-electron.mjs` — and each of those files, read alone, yields a confident
and wrong answer.** So the standing rule is: **do not explain a restart from one
file.** Either trace all four, or do what the grep above does — observe the
artefact instead of reasoning about the pipeline that produced it.

**The distinction that matters, and the one that was got wrong:**

| You save                | Rebuilt? | Effect                                             |
| ----------------------- | -------- | -------------------------------------------------- |
| `apps/server/src/**`    | No       | Stale server; your change is dark until a restart. |
| `packages/contracts/**` | **Yes**  | **Electron restarts. Every agent turn dies.**      |
| `apps/web/src/**`       | Yes      | Hot reload into Anton's live screen.               |

**Do NOT record this as "the server runs under `node --watch`".** That was the
first explanation offered for the restart and it is wrong here: `node --watch
src/bin.ts` is the `dev` / `dev:server` script, not `dev:desktop`, and
`bach_ping` reports `serverFromBundle: true` under the desktop runner. The
distinction is load-bearing rather than pedantic — `dev-runner.ts` carries an
explicit **⚠️ DO NOT "FIX" THIS BY WATCH-BUILDING `apps/server`**, on the
grounds that the fleet survives server edits _precisely because_ nothing
rebuilds. Someone acting on the wrong mechanism would go looking for a watch
that is not there, and might add one.

#### ⚠️ AN ELECTRON RESTART IS NOT A SERVER DEPLOY — you get the outage without it

**The half that was missing from the section above, and it inverts the practical
advice.** "The merge is the restart" is only half right, and acting on the other
half wasted a fleet-killing restart on 2026-07-31.

A `packages/contracts` save restarts **Electron**. Electron then re-spawns
**the same `apps/server/dist/bin.mjs` it spawned before** — because under
`dev:desktop` the server bundle is built ONCE by the dev-runner's one-shot
`t3#build` and _nothing rebuilds it_, which is the rule the section above already
states for `apps/server` edits. It applies just as much to a restart triggered by
contracts.

**So the merge costs you every live agent turn and deploys no server code at
all.** The web half hot-reloads; the server half does not move.

**To actually deploy server code you must restart the DEV RUNNER**, not Electron
— and that is Anton's trigger, never yours.

**How to tell which you got, in one call:** `bach_ping` returns `serverBuiltAt`.
Compare it against the commit you are looking for. Measured on the night this was
learned:

| moment                               | `serverBuiltAt` | contained the new endpoints?        |
| ------------------------------------ | --------------- | ----------------------------------- |
| after the merge restarted Electron   | `21:05:32Z`     | **no** — merges landed 22:39/22:40Z |
| after Anton restarted the dev runner | `22:46:18Z`     | **yes**                             |

**Proof by symbol beats inference here**, and it is one grep: pick a string that
exists only in the change you are chasing and look for it in the running bundle.

```
grep -c "api/bach/traffic" apps/server/dist/bin.mjs
```

Zero means the running process does not have your code, whatever restarted.
Always pair it with a symbol that DID predate the build as a positive control —
otherwise a broken grep and a stale bundle look identical.

**So: touching `packages/contracts` needs a worktree, or Anton's consent.** It
is not in the same safety class as `apps/server`, and no amount of care with the
edit changes that — the restart is triggered by the save, not by the content.

_Boundary: the restart and its timing were observed. The chain above was traced
by reading `vite.config.ts`, `dev-electron.mjs` and the desktop imports — it is
verified wiring, not a watched rebuild._

### A shell-script-only commit is silently reverted by the pre-commit hook (2026-08-02)

**Symptom:** `git commit` fails with `vp fmt: Expected at least one target file.
All matched files may have been excluded by ignore rules.` and the staged-files
runner **reverts the commit**. The files stay staged, so it looks like nothing
happened rather than like a failure.

**Cause:** `vite.config.ts` has `staged: { "*": "vp fmt" }`, so every staged file
is handed to `vp fmt` — but `vp fmt` has **no formatter for `.sh`** and treats a
staged set it cannot format as an error rather than a no-op.

**Why nobody hit it before:** every other tracked `.sh` in this repo is under
`.repos/` (vendored, never committed from here). `scripts/install-prod.sh` is
effectively the first first-party shell script.

**Two workarounds, both verified:**

- Stage any formattable file alongside it — `vp fmt` then finds a target and
  passes. (Checked: `.sh` + `.md` together → "1 files", exit 0.)
- Or `git commit --no-verify`, and say so in the commit trailer.

**Do NOT "fix" it by editing `vite.config.ts`.** That file is upstream — its last
change is an upstream PR — and editing it buys a permanent merge conflict on a
high-churn file to save one flag. If it is worth fixing, it is worth fixing
upstream.

⚠️ **The related trap is not the hook's fault and is worth more than the hook.**
A failing `git commit` returns non-zero, but if the next command is on its own
line rather than after `&&`, the push still runs and prints success — for the
PREVIOUS commit. That is how a reverted commit reads as "pushed". **Chain
commit-and-push with `&&`, and verify the object on the remote** (`git cat-file
-e origin/<ref>:<path>`) rather than trusting a push's exit code.

### The worktree needs its own `vp`

Building in a git worktree keeps the running app's tree untouched, but **`vp` off `PATH` resolves to the MAIN tree's binary**, which silently loads a second copy of vitest and fails with `Cannot read properties of undefined (reading 'config')`. Use the absolute path:

```
<worktree>/node_modules/.bin/vp test run <files>
```

This looked like a broken dependency install for a while. It isn't.

### Never edit code containing `${}` or backticks with `sed` (2026-08-01)

A shell `sed` silently wrote a **NUL byte into a React key**: `${...}` inside a
double-quoted shell string got mangled by the shell before `sed` ever saw it.
**Typecheck passed, tests passed, and the corruption was invisible in every
diff.** It was caught only by printing `repr()` of the line.

Use Python with an exact anchor for any line holding `${}` or backticks, and
**verify by `repr()`, not by eye** — this is a defect class that survives every
check that reads the file as text.

### Node 24 runs the repo's TypeScript directly

`node --experimental-strip-types script.mjs`, importing a `.ts` module, works
without a build step. This is how the traffic stats were cross-checked against
the live DB — a stronger verification than the test harness and cheaper than
standing one up. Reach for it when you want to interrogate real data through the
repo's own types.

### Agent shells inherit Bach's dev env — the FALSE RED, and why documenting it did not work (2026-07-29)

**A build that is red only for agents.** `booqs-lead` lost a session to
"red build blocking deploys" that Anton could never reproduce, because every
agent Bash shell inherits the environment of the Bach dev server that spawned
it. Verified in this agent's own shell, not relayed:

```
NODE_ENV=development
VITE_DEV_SERVER_URL=http://127.0.0.1:5734
VITE_HTTP_URL=http://127.0.0.1:13774
VITE_WS_URL=ws://127.0.0.1:13774
```

`NODE_ENV=development` breaks `next build` — development React resolved against
production chunks, null hook dispatcher, every client page fails to prerender.
The `VITE_*` three are the wider hazard, because they name **Bach's own ports**,
so an agent running a Vite build in **any** repo silently picks up this app's.

**Name the class: this is a FALSE RED, the inverse of the false-green family
catalogued throughout this file.** A false green is a check that passes without
proving anything. A false red is a failure **only agents can reproduce** — so it
gets escalated, investigated as real, and the investigation happens in the one
environment that manufactures it. It is more expensive than a false green,
because a false green is merely not-evidence while a false red actively spends
someone's day.

**The part that should change what we do: this was ALREADY DOCUMENTED, and the
documentation did not work.** "Post-merge verification" item 2 below has
recorded the same root cause since 2026-07-26 — the same three `VITE_*` vars,
producing seven phantom `apps/web` test failures that "look exactly like merge
damage and are not". Three days later the same cause cost a different track a
session under a different symptom.

**Why the note failed is the transferable bit: it is filed where the CAUSE
lives, not where the SYMPTOM appears.** Someone debugging a Next build in
`booqs` has no reason to open Bach's fork-maintenance doc. A note about
contamination has to live in the contaminated repos, or it only reaches people
who already suspect the answer.

**Assessment (asked for by the Lead; nothing built, spawn behaviour untouched).**

- **A narrow denylist is right; an allowlist is not.** The vars worth stripping
  all describe **how Anton launched Bach**, not anything an agent's work needs:
  `NODE_ENV`, the three `VITE_*`, and the `npm_*` lifecycle set. An allowlist
  would have to enumerate `PATH`, `HOME`, fnm shims, credentials and the SSH
  agent, and would break in ways nobody could predict — in the substrate the
  whole fleet runs inside.
- **The seam is `mergeProviderInstanceEnvironment`** (`ProviderInstanceEnvironment.ts`),
  which builds the child env as `process.env` plus per-instance overrides. That
  file is **upstream**, so a fix there grows the fork's conflict surface. The
  shape to copy is the orphan sweep: logic in a Bach-owned file, call site only
  in the upstream one.
- **The existing override mechanism cannot do it.** `ProviderInstanceEnvironment`
  only ever SETS `name = value`; it has no unset. And pinning
  `NODE_ENV=production` for agents would be wrong in the other direction — it
  would break every dev server an agent legitimately runs.
- **Upstream already treats ambient env as hostile one layer up.**
  `dev-runner.ts` deliberately ignores an ambient `VITE_DEV_SERVER_URL` "so a
  parent dev app cannot redirect the child runner". Same hazard, same instinct —
  which is both a precedent for the fix and evidence upstream would take it.
- **It is an upstream bug, not a Bach bug**, on the same reasoning this file
  already applies to the orphan sweep: nothing Bach adds causes it; Bach only
  feels it harder, because Bach is where agents live. **Upstream-contribution
  candidate rather than permanent fork divergence.**
- **It cannot be verified without a fleet-killing restart.** `apps/server` is
  built once at dev-runner start, so the change is dark until a restart, and a
  restart is Anton's trigger. That alone rules out landing it opportunistically.

**One var checked and DEPRECATED as a concern, recorded so nobody re-raises it.**
`npm_config_local_prefix=/Users/ashakirzianov/repos/bach` looks alarming, and
`npm config get local-prefix` run from `/tmp` does echo the Bach path. But
`npm prefix` and `npm run` both resolve from the working directory — `npm run`
in `/tmp` reads `/private/tmp/package.json` and fails, rather than running
Bach's scripts. **The config read echoes the variable; it does not describe
behaviour.** Checked by effect before escalating it, which is the only reason it
is not in the denylist above as a phantom.

### A fixture env dies with the agent that launched it (2026-07-28)

A `test-t3-app` environment started with a backgrounded `vp run dev --home-dir …`
is a child of **that agent's shell**. When that shell's process goes, the dev
server goes with it, and whoever reads the handoff inherits a port that answers
nothing.

**It is not only handoffs.** Observed twice the same day: once when `acefe6e7`
handed over, and once when the successor's own Claude Code process cycled
between turns — same agent, same session, env gone anyway. So "my env, started
by me, and I never left" is not a reason to trust that it is still up. **Check
the port, do not assume the process.**

**The symptom points nowhere near the cause.** A handoff naming "web port 5737"
reads as a live env; `curl` succeeds while the old session is still winding down
and fails minutes later; the controlled browser then reports
`chrome-error://chromewebdata`, which looks like a routing or auth problem rather
than an absent process. `lsof -nP -iTCP -sTCP:LISTEN | grep node` settles it in
one line: if the port is not listed, nothing is wrong with the app.

**Recovery is cheap, so long as the handoff recorded the base dir.** State lives
in `<base-dir>/userdata/state.sqlite` and survives; only the process dies.
Relaunch against the **same `--home-dir`** and every fixture comes back. Pairing
must be redone, because the browser context is new and the old token is spent.

So: **hand off the base directory, not just the port.** The port is reassigned on
the next run (the dev runner offsets it); the base dir is the only durable
handle, and without it the fixtures are effectively lost even though the file is
still on disk.

### The collaborative browser is ANTON'S, and at night it is not there (2026-07-29)

`preview_open` / `preview_status` both time out after 15s when there is no live
preview panel in his running app — which is the normal state while he is asleep.
The error is a bare `PreviewAutomationTimeoutError` with a stack through
`McpServer.tools/call`, so it reads like a broken tool rather than like "nobody
is home". **Do not retry it more than once.**

**The fallback works and needs no install.** `playwright-core` is already a
dependency (`node_modules/.pnpm/playwright-core@…`), and while the
`ms-playwright` browser cache is EMPTY — so `chromium.launch()` with no options
fails — it will happily drive the system Chrome:

```js
import { chromium } from ".../playwright-core/index.mjs";
const browser = await chromium.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
```

That is how tool surface v2's 3d was verified: pairing, `/bach`, expanding a
notification, clicking Acknowledge, and reading the SQLite stamp afterwards.
Attach `pageerror` and `console` listeners — "zero page errors" is most of what
this exercise buys you over an HTTP check.

**THE PAIRING TOKEN IS SINGLE-USE, AND THIS IS WHERE IT BITES.** A first script
that pairs and a second that pairs again gets an UNAUTHENTICATED page, and the
symptom is not an auth error — it is `locator.click: Timeout` on an element that
would obviously be there, and a preceding count of `0` where you expected 1. It
looks exactly like a rendering bug in the thing you are testing. Either do the
whole interaction in ONE browser session, or mint a fresh token per run:

```bash
T3CODE_PORT=<server-port> node apps/server/src/bin.ts auth pairing create \
  --base-dir <base-dir> --dev-url <web-url> --base-url <web-url> --ttl 15m --label agent-x
```

### Verification discipline (the norm that made today work)

- **Say what you proved and what you only reasoned about.** "Everything up to `process.kill` is proven against reality; `process.kill` itself is proven against a fake" is worth more than a green tick. State the boundary explicitly.
- **A green adjacent signal is not the signal.** A `401` from an endpoint proves the _route_ exists and says nothing about whether the app renders. A clean `ps` after someone else's restart says nothing about whether your sweep works. Ask what the observation actually rules out.
- **Sabotage-check anything load-bearing.** Break the guard on purpose and confirm a test goes red. Several tests written today were correct and still could not catch the bug they were meant to (see `replyTargets.ts` — the guard was right, the _model_ was wrong); only breaking things on purpose finds that.
- **Verify by effect, not by return value.** 36 successful returns from a bulk operation is a bare exit-0; re-reading the list and counting is the proof.
- **Re-fetch before acting on a list.** Agent status rots — four instances in one day. A sweep list has a shelf life measured in minutes.

### Touching `BachMessenger` — three properties that are easy to break

Learned building scheduled messages (item 9); each was a real defect or a near miss.

**1. The in-memory queue IS the visibility boundary.** A message is readable by `inbox` exactly when it is in `state`'s queue for that target — not when it is in SQLite. So anything that must be invisible has to stay **out of the queue**, not be filtered out on read. Scheduled messages are durable immediately and queued only at release; filtering on read instead would have leaked them to any drain.

**2. Anything that must be true before the first call must run INLINE in `make`, not forked.** The scheduled-release sweep was forked at boot and left a window where an overdue message was durable but not yet readable — a caller in that window got an empty inbox for mail that existed. `Layer.effect` returns as soon as `make` returns, so a forked fiber races the first request. This is the same shape as the push/read handoff bug earlier the same day: **two correct halves, broken seam.** A happy-path suite sees neither; a restart test saw this one.

**3. Insert-and-enqueue is one uninterruptible critical section**, held under the `SynchronizedRef` semaphore. Splitting them lets an MCP cancellation land between the durable write and the in-memory append, orphaning a row until the next restart. If you add a write path, route it through `enqueue` rather than reproducing the pattern.

**And the general one worth stealing:** prefer encoding a requirement in the **representation** over enforcing it with a check. `deliver_at IS NULL` means "live now", so releasing a scheduled message just clears the column and it becomes an ordinary pending one. "Deliver late rather than drop" then needs no rule — a row whose time passed during downtime is simply due on the next sweep. A check can be deleted by someone who doesn't know why it's there; a representation can't.

### A multi-step refactor of a hot-reloading file has NO atomicity (2026-07-27)

**Anton's dashboard went blank mid-iteration, and the cause was the shape of the edit rather than any single wrong line.**

Removing the board card's truncation feature took two edits: first delete the `EntryDetails` component, then replace the `<EntryDetails …>` that used it. Between those two saves the file on disk referenced a component that no longer existed. `apps/web` **hot-reloads into the running app**, so that intermediate state was not a private working step — it was shipped to Anton's screen the instant the first edit hit disk. A ReferenceError during render takes the whole route, not the one card, which is why "the dashboard is not available" rather than "the card looks wrong".

Typecheck after the second edit was clean, and proved nothing about the window: **a gate that runs after the fact cannot protect a state that has already been served.**

The rule, which costs nothing to follow:

- **On a hot-reloading surface, order edits so every intermediate save is valid — remove the _use_ before the _definition_,** never the reverse. Adding works in the opposite order: definition first, use second (which is why adding the feature caused no outage and removing it did).
- Better still, do the swap in **one** edit when the pieces are adjacent.
- This is the ordinary refactor habit of "leave the tree building at every step", but here the consequence is not a broken local build: it is the user's primary surface going down live.

Note the asymmetry with the server: `apps/server` is built once at startup, so a half-finished server edit is invisible to the running app (see "Know whether your code is even running"). **`apps/web` is the opposite — every save is a deploy.** The two halves of this repo demand different editing discipline, and it is the web half that can take Anton's screen down.

### Sabotage the guard you are most sure of (2026-07-27)

The scheduled-user-turn work shipped two sabotage checks. The first behaved as expected — collapse the release branch, three tests go red. **The second is the one worth recording, because it passed.**

Removing `delivered_at` from the release stamp left **all 26 tests green**. The code was wrong anyway: it produced a row with `deliver_at IS NULL AND delivered_at IS NULL`, which is exactly what the boot rebuild selects as ordinary queued mail, so an already-delivered user turn would be re-queued and delivered as a `[Bach]` pointer **on the next restart**.

Three things generalise:

- **The failure was one restart away from its cause.** Nothing at the time of the bug is observable; the damage appears on a later boot, where nobody would connect it back. Tests are the only place that gap can be closed, so the tests have to be aimed at the _later_ state, not the immediate one.
- **A full green suite is evidence about the tests, not only about the code.** Seven tests written the same hour, all passing, none able to see this. That is the `replyTargets.ts` lesson again — the guard was right, the model was wrong.
- **A sabotage that passes is a finding, not a formality.** It is the only cheap way to learn what your tests are blind to. Budget for the possibility that the answer is "nothing catches this" and write the missing test then.

Related, same day: a `perl -pi -e` sabotage silently failed to substitute, and the suite stayed green. **That green proved nothing** and must not be counted as a passed check — always confirm the sabotage actually landed (re-grep the file) before trusting the run.

### An error path is a feature, and it can fail by saying nothing (2026-07-28)

The request hub's server side was right: answering a request whose asker no
longer exists returned a clean `404` with `reason: "thread_not_found"`. The
composer's catch then did the ordinary thing —

```ts
setError(cause instanceof Error ? cause.message : String(cause));
```

— and for that error shape `cause.message` is the **empty string**. So the page
rendered an error paragraph containing no text. Click Send: the request stays
put, the composer stays open, nothing appears. **Worse than a crash, because
nothing looks wrong.**

Three things generalise:

- **The diagnostic tell was `""` rather than `null`.** `document.querySelector(".text-destructive")?.textContent` returned an empty
  string, which means the element **existed** — i.e. `setError` had run and the
  render was fine. Every hypothesis before that had been "the handler never
  fired", and each one predicted a _missing_ element. When a value is falsy,
  check **which** falsy it is; empty-vs-absent pointed straight at the bug.
- **The bug was pre-existing; the new feature only made it ordinary.** Every
  catch on the page had this shape, so a board reply failing this way was
  equally silent. What changed is the odds: an agent that asks a question and is
  then archived is routine, where the board path needed a rarer coincidence.
  **A latent silent failure becomes a real one the moment a feature makes its
  trigger common** — so when adding a path that reuses existing error handling,
  the question is not "is this handling correct?" but "how often will it now
  run?"
- **`String(cause)` is not a message.** For a tagged error it is often the bare
  class name (`EnvironmentResourceNotFoundError`) — jargon that leads and adds
  nothing. Give an expected failure its own sentence, and keep a generic
  fallback for the rest so no catch can render nothing.

And the reason it was caught at all: the failure is invisible to typecheck,
lint, and every unit test, because all of them assert on values rather than on
what a person sees. **It took clicking the button.**

### "Unreachable" is a claim, and the first real run tests it

Also 2026-07-27: the scheduled-message create endpoint used `Effect.orDie` on an unknown target, with a comment explaining that the picker made the case hard to produce. **The first end-to-end attempt produced it**, as an opaque `StatusCode error (500)`. A board entry can name an agent that has since been archived or deleted, which is ordinary rather than exotic.

The rule: when you catch yourself writing "this cannot happen" next to an `orDie`, that comment is a prediction. Either model the case properly or run the path that would falsify it — do not ship the prediction as if it were a fact.

### Never edited by an agent

Nothing kills Bach processes. Both the Lead and every Bach agent run **inside** Bach, so killing the wrong PID means dying mid-operation with no way to verify or recover. Process cleanup goes in the tooling (`bach-dev-orphans.ts`), to run at startup — or it goes to Anton's hand with an exact procedure.

## Files Bach edits (the conflict surface)

Everything else merges cleanly; expect conflicts only here:

| File                                                                                                                                                                                                                                                                                                                                     | Bach's change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Conflict risk                                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `CLAUDE.md`                                                                                                                                                                                                                                                                                                                              | Replaced the upstream `CLAUDE.md → AGENTS.md` symlink with a real file that imports `@AGENTS.md` and adds Bach/axis context. **Upstream itself replaced the symlink with a real file containing `@AGENTS.md` before the 2026-08-31 uptake**, so this is now a two-real-files conflict rather than a symlink one — keep ours wholesale; it already imports `@AGENTS.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | occasional (conflicts on any upstream edit; was ~never while it was a symlink)                                  |
| `apps/server/src/mcp/McpHttpServer.ts`                                                                                                                                                                                                                                                                                                   | Register `BachToolkitRegistrationLive` + provide the Bach persistence stack (`bach/BachPersistence.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | occasional                                                                                                      |
| `apps/server/src/mcp/McpSessionRegistry.ts`                                                                                                                                                                                                                                                                                              | One-constant crank of `DEFAULT_LIVENESS_WINDOW_MS` (24 h → 30 d) for Bach's long-lived, idle-by-design agents. Upstream's `pruneDead` runs before `touch` can refresh, so a credential idle past the window dies before the wake-up turn saves it. (Was a two-constant idle/max-lifetime crank until the 2026-08-10 uptake replaced that model; sprint #3, `sprint3-token-lifecycle-design.md`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | rare (one isolated literal; re-apply if upstream retunes it)                                                    |
| `apps/server/src/server.test.ts`                                                                                                                                                                                                                                                                                                         | One appended provide in the test harness's `appLayer` pipe: `SqlitePersistenceMemory` (the Bach stores add a `SqlClient` requirement to `makeRoutesLayer`; sprint #2)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | occasional (file churns upstream — re-apply the one provide)                                                    |
| `packages/contracts/src/environmentHttp.ts`                                                                                                                                                                                                                                                                                              | Bach `HttpApi` group (`/api/bach/*` — notifications, requests, scheduled, agent cards; the board's two endpoints were removed in tool surface v2 Phase 3d). Required rather than chosen: `EnvironmentAuthenticatedAuth` is an `HttpApiMiddleware.Service` and only attaches to `HttpApi` groups, so the alternative is re-implementing authentication for one endpoint.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | occasional (schema-only)                                                                                        |
| `apps/server/src/server.ts`                                                                                                                                                                                                                                                                                                              | Compose `bachHttpApiLayer` into `makeRoutesLayer` (one import + one provide)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | **first Bach edit**; high churn, but 4 lines — re-apply                                                         |
| `apps/web/src/components/Sidebar.tsx`                                                                                                                                                                                                                                                                                                    | Render `<BachNavItems />` above the project filter row (import + 2 lines). Upstream made sidebar v2 the default and deleted `SidebarV2.tsx` in the 2026-08-10 uptake, so the fork is back to editing one sidebar — the nav entry matters because the app is Electron with no URL bar, so it is the only way to reach the dashboard.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | high churn — but only 3 lines to re-apply                                                                       |
| `apps/web/src/routeTree.gen.ts`                                                                                                                                                                                                                                                                                                          | **Generated**, and committed upstream. Bach's dashboard route (`routes/bach.tsx`) regenerates it, so it conflicts on any upstream merge that touches routes. **Regenerate it; never hand-merge it** — the failure mode is someone carefully resolving a generated file by hand.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | on route-touching merges                                                                                        |
| `scripts/dev-runner.ts`                                                                                                                                                                                                                                                                                                                  | Two calls into `scripts/lib/bach-dev-orphans.ts` (a new Bach-owned file): a startup sweep for `dev:desktop`, and an `Effect.ensuring` on the child wait. **14 lines**, deliberately — all logic lives in the new file so the upstream file carries call sites only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | occasional (14 lines, two hunks)                                                                                |
| `apps/desktop/src/preview/Manager.ts` (+ its test)                                                                                                                                                                                                                                                                                       | One rendering hold around `withControlSession` (one import, one `Effect.suspend` wrapper), so an automation action keeps its guest producing frames while the app window is occluded. All logic lives in the Bach-owned `preview/RenderingHold.ts`; the upstream file carries the call site only. `Manager.test.ts` gains `setBackgroundThrottling: vi.fn()` on its WebContents doubles (the real API always has it) plus one seam test. **Upstream bug, not a Bach one** — same reasoning as the orphan sweep, so an upstream-contribution candidate rather than permanent divergence.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | occasional (one call site; re-apply the wrapper)                                                                |
| `.node-version`                                                                                                                                                                                                                                                                                                                          | New file (`24`) for fnm                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | none (no upstream version file)                                                                                 |
| `packages/ssh/src/tunnel.ts` (+ its test)                                                                                                                                                                                                                                                                                                | `REMOTE_LAUNCH_SCRIPT` is **attach-only** (2026-08-10, branch `fix/remote-attach-only`): it attaches to the server registered in `server-runtime.json` or fails with "launch the app", and never spawns. Upstream's spawn-a-background-server fallback is keychain-blind on macOS (no Aqua session, so no Claude auth / Xcode signing / screencapture) and self-registers, so every later connect sticks to it. Deliberately NOT an upstream candidate: upstream wants headless spawn; our setup always has the desktop app as the server. On conflict: keep our attach-only script wholesale, and review upstream's launch-script changes for anything orthogonal worth taking (node resolution, readiness probing). Done once already: the 2026-08-31 uptake took upstream's `REMOTE_LAUNCH_TIMEOUT_MS` (it added a `timeoutMs` to the launch SSH command, which is orthogonal to the script's spawn-vs-attach behaviour) while dropping the rest. **The dangling-reference trap:** upstream's TypeScript around the script auto-merges cleanly while the script hunk conflicts, so taking ours wholesale can leave a reference to a constant that only existed on upstream's side. Grep the resolved file for the symbols named in the discarded hunk. `tunnelLaunchScript.test.ts` (Bach-owned, new file) runs the real script against a throwaway `$HOME`. | occasional (script region only; rest of file pristine)                                                          |
| `--inert` (`config.ts`, `cli/config.ts`, `provider/Layers/ProviderInstanceRegistryHydration.ts`, `provider/Layers/ProviderService.ts`, `server.ts`, `serverRuntimeStartup.ts`, `provider/ModelManifest.ts`, `usage/UsageLimitSources.ts`, `telemetry/AnalyticsService.ts`; new `process/inertSpawner.ts`, `terminal/InertPtyAdapter.ts`) | Bach's snapshot instance (`bach/host-inert-flag`): a server on a copy of live state that acts on nothing. Hydration gets no drivers, a spawner gate lets only `process.execPath` through (provided twice in `makeServerLayer`, above and below `HttpServerLive`, which re-exports an ungated spawner), terminals refuse, the cloud link is parked, startup skips reactors/reconciles/auto-pull, and the manifest, usage hubs and telemetry stay off. **On conflict, keep every guard**: a dropped one is a copy of the live fleet running real sessions in real repos. `ProviderRegistry.test.ts` "inert" and `process/inertSpawner.test.ts` fail if the two choke points go.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | small: a few lines per file; `serverRuntimeStartup.ts` wraps the reactor/reconcile/auto-pull phases in one `if` |

As of sprint #3 the edited core files are `McpHttpServer.ts`, the two cranked constants in `McpSessionRegistry.ts` (sprint #3), plus the one test-harness provide in `server.test.ts`. Everything else Bach adds is new files (`apps/server/src/bach/**`, `apps/server/src/mcp/toolkits/bach/**`). The capability gate was intentionally _not_ touched (see `v0-design.md` §12), so `McpInvocationContext.ts` stays pristine and `McpSessionRegistry.ts` carries only the two-line timeout crank (no logic change). Bach also owns its SQLite DDL (`bach/BachSchema.ts`, `CREATE … IF NOT EXISTS` at boot) instead of registering upstream migrations — `persistence/Migrations.ts` is a hard-coded array that would conflict on every merge (see `sprint2-sqlite-persist-stores-design.md` §4).

**Never edited** (keep pristine for clean merges): `AGENTS.md`, `README.md`, `CONTRIBUTING.md`, `LICENSE`, `.github/`.

**`scripts/dev-runner.ts` is the first edit to an upstream file that is not a Bach hook, and it is worth being explicit about why.** The orphan bug is an **upstream** bug — nothing Bach adds causes it; Bach only feels it harder, because Bach is the substrate every agent runs on and a dev server that will not start takes the fleet with it. That makes it an **upstream-contribution candidate** rather than a permanent fork divergence: if it goes upstream, this row leaves the table entirely. Until then the shape of the edit is chosen to be cheap to re-apply — all logic in the new Bach-owned file, call sites only in the upstream one.

### The cherry-pick double-apply trap

**A conflict-free merge is not the same as a correct merge.** If a Bach commit is a _verbatim cherry-pick_ of an upstream commit, then when that upstream commit later arrives through `git merge`, git can raise **no conflict at all** and still corrupt the result — both sides added the same text, and if the two insertions land at **different file offsets** (because surrounding upstream code moved in the meantime), auto-merge keeps both and silently produces **a duplicate**. An identical insertion at identical context does dedupe cleanly; it's the offset drift that makes this bite, which is precisely what a long-running fork accumulates.

This is exactly what happened on 2026-07-26: `e1152df5e` had cherry-picked upstream's `claude-opus-5` model entry, landing it at line 89 of `apps/server/src/provider/Layers/ClaudeProvider.ts`, while upstream's own copy sat at line 92. Different offsets, so the merge kept both and produced **two** `claude-opus-5` entries in `BUILT_IN_MODELS`. Nothing flagged it — no conflict marker, and `vp check`/typecheck both pass happily on a duplicated array entry. It was caught only by an explicit duplicate scan.

So post-merge verification must include a **duplicate scan of the touched declarations**, not merely a conflict-marker scan:

```bash
# for any file a Bach commit cherry-picked into, count the declarations it added
grep -c 'slug: "claude-opus-5"' apps/server/src/provider/Layers/ClaudeProvider.ts   # expect 1, not 2
```

When the fork's version of a cherry-picked file should be identical to upstream's, the cleanest resolution is to take upstream's file wholesale (`git checkout upstream/main -- <file>`) rather than hand-editing the duplicate away.

### Prefer merging upstream over cherry-picking

**Anton's explicit guidance: default to taking the upstream merge; do not cherry-pick upstream commits to get a feature early.**

The double-apply trap above exists _because_ of a cherry-pick. Pulling one commit forward buys a few days of early access and costs a silent-duplicate risk plus a manual resolution at the next uptake — a bad trade in a fork that takes frequent uptakes anyway.

Reserve cherry-picks for genuinely urgent unblocks. If you do cherry-pick:

- Keep the hunks **upstream-verbatim** (this is what kept the 2026-07-26 resolution tractable), and
- **Record it** — note the file in the commit message and here, so the next uptake knows to duplicate-scan it.

## Repo gotchas (Effect v4 / this codebase)

- `Context.Service` keys must be deterministic `t3/<path>` (lint-enforced — `effect(deterministicKeys)`).
- Effect **v4** surface: `Effect.catchCause` (not `catchAllCause`), `Layer.effect` (not `Layer.scoped` — its build runs in the layer scope, so `Effect.forkScoped` works under it).
- Gate before done (`AGENTS.md`): `bun run vp run --filter ./apps/server typecheck`, `vp lint`, `vp fmt`.

## Uptake routine

```bash
git -C . fetch upstream
git -C . merge upstream/main        # main is Bach's line
# resolve conflicts only in the small set above, then:
#   - re-apply Bach's one-line registrations if clobbered
#   - run the upstream check suite (see AGENTS.md: `vp check`, `vp run typecheck`)
#   - then work through "Post-merge verification" below — a clean merge is not a correct merge
```

Merge as a **merge commit** (no rebase): the fork's history is shared and must not be rewritten. And prefer this merge to cherry-picking upstream commits early — see "Prefer merging upstream over cherry-picking" above.

If a conflict appears outside the table above, it means Bach grew a new edit to an upstream file — add it to the table (and reconsider whether it can be made additive instead).

## Post-merge verification

Beyond the standard check suite, three things bite specifically on uptakes. All three were hit on 2026-07-26.

**1. Reinstall dependencies — the merge moves the lockfile.**

A large uptake almost always changes `pnpm-lock.yaml`, so the installed `node_modules` no longer matches the tree. Typecheck and tests will fail in confusing ways until you reinstall:

```bash
pnpm install
# If pnpm decides a full purge of node_modules is needed (store/lockfile mismatch), it
# prompts — which fails in an agent shell with no TTY. Re-run as: CI=true pnpm install
```

Note the ordering hazard against the self-hosting section above: reinstalling changes `node_modules` **underneath a running desktop app**, so after a merge the running app is on a pre-merge build with post-merge dependencies on disk. It needs a deliberate restart.

**2. Unset dev-server env vars before believing an `apps/web` test failure.**

An agent shell spawned from the running Bach dev server **inherits `VITE_HTTP_URL`, `VITE_WS_URL`, and `VITE_DEV_SERVER_URL`** (set by `scripts/dev-runner.ts`). Those leak into the `apps/web` env-bootstrap tests and fail **7 tests** across `src/environments/primary/bootstrap.test.ts`, `src/environments/primary/httpLayer.test.ts`, and `src/authBootstrap.test.ts`. The failures look exactly like merge damage and are not — unset the three and the same 28 tests pass:

```bash
cd apps/web && env -u VITE_HTTP_URL -u VITE_WS_URL -u VITE_DEV_SERVER_URL \
  pnpm exec vp test run \
  src/environments/primary/bootstrap.test.ts \
  src/environments/primary/httpLayer.test.ts \
  src/authBootstrap.test.ts     # 28/28 pass
```

Before blaming the merge for any failure, check whether the package even carries fork changes — `git diff upstream/main -- apps/web` was empty on 2026-07-26, which settled it. A package byte-identical to upstream cannot have been broken by the merge.

(Relatedly: an `exit code 137` from a test task is an OOM/resource kill under parallel load, not a test failure. Re-run that package alone before investigating.)

**3. Duplicate-scan any file a Bach commit cherry-picked into** — see the double-apply trap above.

Then confirm the fork surface itself still works. Typecheck and unit tests cover the Bach layer, but the **MCP tools can only be exercised against a restarted server** — so a merge that greens the suite has still not proven `spawn_agent`/`send_message`/`list_agents` work. Verify those after the restart, not before.

**4. Tool visibility proves _registration_, not _migration_.**

Any change that ships both a tool surface and a schema change needs **both** verified, because the surface is loud and the schema is silent. A new tool appearing — or even executing — proves the toolkit registered. It says nothing about whether a guarded `ALTER` ran against the real database. That failure is invisible on the day and bites later, on the first request that touches the new column, long after anyone would connect it to the deploy.

Both were nearly conflated on the 2026-07-26 Phase 1 landing. Verify against the live DB, not the test fixture:

```bash
sqlite3 -readonly ~/.t3/dev/state.sqlite \
  "SELECT name FROM pragma_table_info('bach_messages') WHERE name='interrupt_at';
   SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_bach%';
   SELECT key, value FROM bach_settings;"
```

The same query doubles as **proof of behaviour-neutrality** when a change ships behind a runtime flag: reading `protocol_mode | legacy` out of the live database turns "this deploy changed nothing" from a claim in a commit message into a row anyone can check.

**5. Assert the handoff, not the halves.**

When a feature splits into two steps that hand off to each other, testing each step in isolation can leave the seam untested while every test passes. On 2026-07-27 the Phase 2 messaging flip shipped with two green tests — "a push sends a pointer, not the content" and "read_messages returns queued messages" — both true, while the handoff between them was broken: the push consumed the message, so the pointer referred to something `read_messages` could no longer return. Deadline-carrying messages silently lost their content, and the defect ate a defect report before being caught in production.

The missing test names the seam directly: _push a deadline message, then require `read_messages` to return **that** message._ Same family as item 4 — two signals that look like one green.

And when you write a regression test, **confirm it fails against the broken code before trusting it.** Revert the fix, watch the test go red, restore. A regression test that has never failed proves nothing about what it protects.

Two related habits worth keeping, both of which made that landing verifiable:

- **Capture a pre-restart baseline.** Confirm the new tool is _absent_ before the restart. Without it, finding the tool afterwards proves nothing — it might have been there all along.
- **Assert the positive signal.** "The merge was clean" and "the schema loaded" are inferences. Calling the tool and getting a result is an observation.

**7. For a change the user experiences through the app, the APP is what must be observed.**

A green endpoint is necessary and nowhere near sufficient. On 2026-07-27 a `401` from `/api/bach/board` was relayed as proof that "the server hot-reloaded, no restart needed" — true of the _server_, and silent on whether the Electron shell survived, whether the renderer picked up the new bundle, or whether the dev runner was in a crash-restart loop. Anton uses the app; the server answering says nothing about what he sees.

Same family as items 4 and 5: a signal that is real, adjacent to the question, and mistaken for an answer to it. Verify at the layer the user actually touches.

**6. A flag named for a _mode_ will eventually force an all-or-nothing choice on things that were never coupled.**

`protocol_mode` (`legacy` | `pull`) bundled two orthogonal properties: quiet-by-default, and pointer-form delivery. Nothing connected them — the flag invented the connection. When quiet-by-default was rejected, pointer-form was deleted as collateral, and the combination actually wanted (always-interrupt **plus** pointer-only) was never on the table, because no name existed for it.

**The mode flag made two orthogonal choices look like one, and its name described a bundle rather than either property.** That is the smell: a flag named for a _mode_ rather than for a _property_. Two independent booleans would have made the missing combination obvious; one enum made it unrepresentable.

The cost is not the flag itself — it is that rejecting a bundle takes good ideas down with it, and nobody notices, because the bundle had a name and therefore felt like one thing.

## Attribution

Bach is a fork of [T3 Code](https://github.com/pingdotgg/t3code) (MIT). Upstream `LICENSE` and copyright are retained.
