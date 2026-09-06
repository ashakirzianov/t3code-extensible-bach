# Clean-room acceptance run — behavioural checklist

The nine items are the spec's own acceptance list (`bach-core-spec.md` §7). Run them in order
in the dev build after Deploy. Each row says exactly what you do and exactly what you should
see; record what you actually saw, verbatim, even when it matches.

A failed item is a result, not a blocker — carry on to the next one. Only stop if the
extension is not running at all.

---

## 1. A fresh agent sees the tools

**Do:** the §6 check from the runbook — new thread after Deploy, ask it to list its
non-built-in tools.

**See:** exactly six — `spawn_agent`, `list_agents`, `send_message`, `inbox`,
`request_from_user`, `notify_user`. Record the list verbatim, including any extras.

## 2. Spawning, and the permission gate

**Do:** in that thread (call it **A**), ask it to spawn an agent **B** in
`~/acceptance/bach-clean` with a prompt of your choosing. Then ask it to spawn one in
`~/acceptance/bach-clean/src` (or any path that is not a project root).

**See:** the first succeeds and a new thread appears. Open B: its first turn begins with a
line naming A, of the shape `[Bach] You are agent <B's id>, spawned by agent <A's id>.` The
second is **rejected** — not silently retargeted to the parent project.

## 3. Derived state

**Do:** while B is mid-turn, ask A to `list_agents`. Ask again once B has gone idle.

**See:** B appears both times, with a state that changed — `working` while it ran, `idle`
after. Record both values. B never reports its own state; A reads it.

## 4. A message does not interrupt

**Do:** while B is **working**, ask A to send B a message. Watch B.

**See:** four things, all of which matter —

1. B gets **no new turn** while it is working;
2. when B goes idle it gets **one** turn, saying something is waiting and naming a count, and
   **carrying none of the message text**;
3. B's `inbox()` returns the message with A's id on it;
4. a second `inbox()` in that same turn returns **empty**.

## 5. A request reaches the user and blocks

**Do:** ask B to ask you a question with `request_from_user`. Look at the dashboard.

**See:** B's card shows the question; the sidebar badge shows **1**. `list_agents` from A shows
B as `blocked`. Answer from the card. B is woken, and its drain carries your answer **with its
own question alongside it**. The badge disappears — absent, not `0`.

## 6. Notifications, acknowledge and reply

**Do:** ask B to `notify_user` with key `k` and some text, then again with key `k` and
different text. Acknowledge the note. Later, ask B to write another and **reply** to it.

**See:** after the second write there is **one** note on B's card, showing the second text.
Acknowledging does **not** wake B, but the acknowledgement appears in B's next drain. Replying
**does** wake B, its drain carries the reply, and the note leaves the card.

## 7. Pin is the host's pin

**Do:** pin B's card from the dashboard. Look at the host sidebar. Unpin from the sidebar. Look
at the card.

**See:** pinning the card pins the thread in the sidebar and floats the card; unpinning in the
sidebar unpins the card. One pin, not two — if they disagree, the extension stored its own.

## 8. Restart without loss or duplication

**Do:** send an idle agent a message and let it sit **undrained**. Note the last message id you
can see. Trigger a rebuild so the Deploy marker appears again, and click Deploy.

**See:** after the restart the agent is woken **again** and drains the message **once**. Nothing
is delivered twice, nothing vanishes, and new message ids continue upward from the noted one
rather than restarting.

## 9. The host database is untouched

**Do:**

```bash
cd ~/repos/t3code-extensible
cat > /tmp/host-tables.mjs <<'JS'
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.argv[2], { readOnly: true });
for (const r of db.prepare(
  "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
).all()) console.log(r.name);
JS
node /tmp/host-tables.mjs .t3-acceptance/userdata/state.sqlite
```

**See:** only the host's own tables — `orchestration_*`, `projection_*`, `auth_*`,
`checkpoint_*`, `provider_session_runtime`. **Nothing** named for the extension. Its own
database should be a separate file under
`.t3-acceptance/userdata/extensions/<name>/`; confirm that file exists.
