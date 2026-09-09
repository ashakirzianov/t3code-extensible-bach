# Clean-room acceptance run — runbook

The acceptance test for the extension seam (`extensibility-design.md` §14): an agent that has
never heard of Bach is given a spec and asked to build it as an extension on this fork. If it
reaches a working Deploy with no help beyond one click, the extensibility story holds.

**You are the external tool.** The builder agent works alone; you start it, click Deploy once,
and report back. Do not answer its design questions with knowledge it should have found in the
guide — every question you have to answer is a result. Say "I don't know, look it up" and
record that you were asked.

Roles: the **examiner** (an agent in a fork checkout, which prepared this) and the **builder**
(the clean agent). Everything below is yours.

---

## 1. Build the dev fork with a fresh home

```bash
cd ~/repos/t3code-extensible
git checkout main
eval "$(fnm env)"
CI=true pnpm install
export PATH="$PWD/node_modules/.bin:$PATH"
node scripts/dev-runner.ts dev --home-dir "$PWD/.t3-acceptance"
```

The fork's `main` is **local** — nothing is pushed and nothing is pulled, so there is no
`git pull` here. Taking upstream's changes is a deliberate, separate uptake (see the fork
note's uptake log); doing it mid-run would change what is being tested.

A **separate home** (`.t3-acceptance`, not `.t3`) so the run starts with no projects, no
threads, and no extensions, and so a previous run cannot contaminate this one. If the folder
already exists from an earlier attempt, delete it first — the run is only valid from empty.

Confirm in the `[dev-runner]` line before doing anything else:

```
[dev-runner] mode=dev source=default ports serverPort=<p> webPort=<w> baseDir=.../.t3-acceptance
```

If `baseDir` is anything else, stop. Then open the `pairingUrl:` line's full URL (token
included) in a browser. Leave this server running for the whole run.

## 2. Pre-flight isolation checks

All four must pass. Paste the results back with your report.

```bash
# 1. No global agent instruction mentions Bach. Prints a number; 0 is what you want.
grep -ci bach ~/.claude/CLAUDE.md 2>/dev/null || echo 0

# 2. The fresh home has no extensions installed and no Bach anywhere.
ls ~/repos/t3code-extensible/.t3-acceptance/userdata/extensions 2>/dev/null || echo "none"

# 3. The builder's working folder is outside ~/repos and empty.
mkdir -p ~/acceptance/bach-clean && ls -A ~/acceptance/bach-clean

# 4. Nothing named bach is reachable from it.
ls -A ~/acceptance
```

Check 1 must print `0` (`grep -c` exits non-zero when it finds nothing, hence the `|| echo 0`). Checks 2–4 must show nothing Bach-related. `~/acceptance/...` is
deliberately outside `~/repos` so the builder cannot wander into the real Bach or this fork.

**Not yet enforced, and it matters:** the 2026-09-09 run showed the builder reading this
checkout directly — 45% of its tool calls — because nothing stopped it. The working folder and
the home are isolated; _read access to `~/repos/t3code-extensible` is not_. Until that is
closed, the host-source count in the diagnostic measures convenience as much as it measures the
guide. Deny it before the next run.

## 3. Give the builder a project

In the dev build's UI, add a project rooted at `~/acceptance/bach-clean`. The builder needs a
project it can spawn threads in, and §3.1 of the spec makes the project root the permission
gate — without one, half the checklist is untestable.

## 4. Start the builder

Assemble the prompt mechanically rather than retyping it — the spec must arrive **verbatim**:

```bash
{ cat <<'PREAMBLE'
You are working on a T3 Code build that supports extensions. Its MCP resources describe how:
read them for the protocol, the manifest, the host web API, and a complete reference
extension you can copy. Build the following as an extension for this host, in the working
folder you have been given. When it builds, the host will offer to deploy it.

PREAMBLE
cat ~/repos/bach/docs/bach/bach-core-spec.md
} | pbcopy
```

Start a **new thread** in the `bach-clean` project, on **Claude**, and paste. That paragraph is
the only thing the builder is told beyond the spec — no hints about the guide's location, the
folder layout, or the protocol. If you find yourself wanting to add a sentence, don't: write it
down as a guide gap instead.

Then leave it alone. Note the wall-clock start time.

## 5. During the run

Your only job is to watch and record. In a notes file, timestamp each of:

- **every question the builder asks you** — verbatim, and what you answered;
- **anything you had to do for it** other than the single Deploy click;
- the moment the **Deploy affordance appears** (a changed marker on the extension in
  Settings → Extensions, and on its sidebar entry once it has one).

When Deploy appears: **click it once.** That is the whole human contribution the test allows.
If the builder asks you to click it again after a rebuild, that is fine and expected — note how
many times.

## 6. After Deploy — the fresh-agent check

The catalogue an agent sees is frozen when its provider process starts, so this only means
anything in a thread created _after_ the Deploy.

1. Start a **new thread** in any project.
2. Paste exactly: `List every tool you have whose name is not a built-in file or shell tool. Just the names.`
3. Copy its answer verbatim.

Expect the six tools of the spec's §3. Fewer, more, or differently named is a result, not a
failure to fix on the spot.

## 7. Then run the checklist

Work through [`checklist.md`](checklist.md) in order, in the dev build, recording the exact
observation for each item. Items 1–9 are the spec's own acceptance list.

## 8. Report back

Paste to the examiner:

- the four pre-flight results from §2;
- your notes file from §5 (questions, interventions, Deploy timing and count);
- the verbatim fresh-agent answer from §6;
- the checklist results from §7;
- the wall-clock start and end, and roughly how many turns the builder took.

**Leave the dev server and the `.t3-acceptance` home in place** until the examiner says it is
done — the transcript is read out of that database
([`read-transcript.md`](read-transcript.md)), and deleting it destroys the most valuable half
of the result.
