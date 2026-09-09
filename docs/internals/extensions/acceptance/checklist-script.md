# Acceptance checklist — paste-by-paste script

Mechanical version of [`checklist.md`](checklist.md), spec §7 items 2–9: paste this, look
there, write one line. Every prompt asks for the **raw tool result verbatim** — paste that
back, not a summary.

**A** is a _new_ thread in the `bach-clean` project (never reuse the builder's). **B** is the
agent A spawns in step 2; open it from the dashboard's Open action.

**Read this once, it decides half the steps.** A woken agent drains its inbox **inside the wake
turn itself**, within a second or two. So the evidence for "what was delivered" is the wake
turn's own content — the injected line and the tool results in that turn — **not** a later
`inbox` call, which will correctly be empty because the agent already drained. If a result line
below says "expect empty", that is the point being tested; everywhere else, read the wake turn.

**The busy prompt is the one from `bach-chapters-spec.md` §0**, and it is shell work on purpose:
a "think about something" turn ends in seconds and the window closes before you can act. Use it
verbatim wherever a step says to make an agent busy — every later chapter's checklist uses the
same one.

Item 1 already passed: the six Bach tools appear alongside the host's own `preview_*` — "exactly
six" in `checklist.md` means the six Bach tools, not the whole list.

---

## 2. Spawn, prefix, and the permission gate

Paste into **A**:

```
Call spawn_agent with work_directory "/Users/devuser/acceptance/bach-clean", prompt "Reply with exactly ACK and stop.", name "Acceptance B". Then reply with the raw tool result verbatim and nothing else.
```

**Look:** a new thread appears in the sidebar. Open it (that is **B**) and read its first turn.

- Result 2a (spawn): `PASS / FAIL` — agentId returned: {"agentId":"320bc66f-c28a-4578-93b1-48844f821e57"}
- Result 2b (prefix): `PASS / FAIL` — B's first line, verbatim: [Bach] You are agent 320bc66f-c28a-4578-93b1-48844f821e57, spawned by agent c6063441-f534-42e1-941b-347527cff880. Coordinate with other agents using the Bach tools (spawn_agent, list_agents, send_message, inbox, notify_user).

Reply with exactly ACK and stop.
_(expect `[Bach] You are agent <B id>, spawned by agent <A id>.`)_

Then paste into **A**:

```
Call spawn_agent with work_directory "/Users/devuser/acceptance/bach-clean/src", prompt "hello". Then reply with the raw tool result or error verbatim and nothing else.
```

- Result 2c (gate): `PASS / FAIL` — rejection text: <error>"/Users/devuser/acceptance/bach-clean/src" is not the workspace root of a project in this environment, so no agent can be spawned there. Agents may only run where the user already created a project, and the path must match a root exactly — a subdirectory of one will not do. Roots: "/Users/devuser/acceptance/bach-clean"</error>
  _(must be refused, not silently retargeted to the project root)_

## 3. Derived state

Paste into **B** first, and do not wait for it to finish:

```
Count from 1 to 40. Between each number, run: sleep 2 && date -u +%H:%M:%S
```

While B is still counting, paste into **A**:

```
Call list_agents. Then reply with the raw tool result verbatim and nothing else.
```

- Result 3a (working): `PASS / FAIL` — B's state: ______

Wait for B to finish, then paste the same `list_agents` prompt into **A** again.

- Result 3b (idle): `PASS / FAIL` — B's state: ______

## 4. A message waits for idle, and drains once

Paste into **B**, and immediately move on without waiting:

```
Count from 1 to 40. Between each number, run: sleep 2 && date -u +%H:%M:%S
```

Now, **while B is counting**, paste into **A**:

```
Call send_message with target_agent_id set to B's agent id and message "Acceptance message one." Then reply with the raw tool result verbatim and nothing else.
```

_(If A does not remember B's id, prepend: `Call list_agents first to find the agent named "Acceptance B".`)_

**Look:** B's thread while it counts.

- Result 4a (no interruption): `PASS / FAIL` — did B get a new turn before finishing? I was not able to past message to **A** -- **B** respond almost instantly.

**Look:** B's thread after it finishes counting; a wake turn should arrive on its own.

- Result 4b (wake): `PASS / FAIL` — the wake text, verbatim: ______
  _(must name a count and carry **none** of the message text)_

Paste into **B**:

```
Call inbox. Then call inbox a second time. Reply with both raw tool results verbatim, labelled "first" and "second", and nothing else.
```

- Result 4c (drain): `PASS / FAIL` — first result contains the message and A's id: first
  {"messages":[],"userReplies":[],"notificationReplies":[],"acknowledgements":[]}

second
{"messages":[],"userReplies":[],"notificationReplies":[],"acknowledgements":[]}

- Result 4d (exactly once): `PASS / FAIL` — second result empty: ______

## 5. A request reaches you, and blocks

Paste into **B**:

```
Call request_from_user with question "Which colour should the acceptance run use?" and options ["red", "blue"]. Then reply with the raw tool result verbatim and nothing else.
```

**Look:** the Bach dashboard page (sidebar entry "Bach"), B's card, and the sidebar badge on
that entry.

- Result 5a (card): `PASS / FAIL` — question visible on B's card: Which colour should the acceptance run use?
- Result 5b (badge): `PASS / FAIL` — badge shows: 1 _(expect `1`)_

Paste into **A**:

```
Call list_agents. Then reply with the raw tool result verbatim and nothing else.
```

- Result 5c (blocked): `PASS / FAIL` — B's state: {"agents":[{"agentId":"c6063441-f534-42e1-941b-347527cff880","name":"Agent A","workDirectory":"/Users/devuser/acceptance/bach-clean","state":"working","openRequests":0},{"agentId":"320bc66f-c28a-4578-93b1-48844f821e57","name":"Acceptance B","workDirectory":"/Users/devuser/acceptance/bach-clean","state":"blocked","openRequests":1},{"agentId":"67569a39-d0e3-4f46-ad40-e79354800654","name":"List every tool you have whose name is not a built...","workDirectory":"/Users/devuser/acceptance/bach-clean","state":"idle","openRequests":0},{"agentId":"144785b0-3df1-4909-aeed-a7f02203661d","name":"You are working on a T3 Code build that supports e...","workDirectory":"/Users/devuser/acceptance/bach-clean","state":"idle","openRequests":0}]} _(expect `blocked`)_

**Do:** on B's card, click `blue`, then Answer. B should be woken on its own. Then paste into **B**:

```
Call inbox. Then reply with the raw tool result verbatim and nothing else.
```

- Result 5d (answer echoed): `PASS / FAIL` — does the drained item carry both your answer **and**
  B's own question? {"messages":[],"userReplies":[],"notificationReplies":[],"acknowledgements":[]}
- Result 5e (badge cleared): `PASS / FAIL` — badge now: absent _(expect absent, not `0`)_

## 6. Notifications: one per key, ack is silent, reply wakes

Paste into **B**:

```
Call notify_user with key "acceptance" and message "First note.", then call notify_user again with key "acceptance" and message "Second note.". Reply with both raw tool results verbatim and nothing else.
```

**Look:** B's card.

- Result 6a (one per key): `PASS / FAIL` — how many notes, and what text? Second note.
  _(expect one note reading "Second note.")_

**Do:** click Acknowledge on that note. Watch B's thread for ~30 seconds.

- Result 6b (ack is silent): `PASS / FAIL` — did B get a turn? no _(expect no)_

Paste into **B**:

```
Call notify_user with key "acceptance-two" and message "Please reply to this note." Then reply with the raw tool result verbatim and nothing else.
```

**Do:** on that second note, click Reply, type `acknowledged by hand`, and send. B should be
woken. Then paste into **B**:

```
Call inbox. Then reply with the raw tool result verbatim and nothing else.
```

- Result 6c (reply wakes and drains): `PASS / FAIL` — reply text present, and the earlier
  acknowledgement present too? {"messages":[],"userReplies":[],"notificationReplies":[],"acknowledgements":[]}
- Result 6d (note cleared): `PASS / FAIL` — is the replied-to note gone from the card? yes

## 7. Pin is the host's pin

**Do:** on the Bach dashboard, click the pin toggle on B's card.

- Result 7a: `PASS / FAIL` — is B's thread now pinned in the **host sidebar**? yes

**Do:** unpin B's thread from the host sidebar.

- Result 7b: `PASS / FAIL` — is B's card now unpinned on the dashboard? yes
  _(if the two disagree, Bach stored its own pin state)_

## 8. Restart loses nothing and duplicates nothing

Paste into **A** (do **not** let B drain it):

```
Call send_message with target_agent_id set to B's agent id and message "Message across the restart." Then reply with the raw tool result verbatim and nothing else.
```

- Note the `messageId` returned: {"messageId":7} I can't leave it undrained though -- the **B** was instantly woke by extension, which is I believe by design.

**Do:** leave it undrained. Then restart the extension: Settings → Extensions → **Disable**
`bach`, then **Enable** it. _(If a Deploy button is offered instead, use that.)_

**Look:** B's thread after the restart — it should be woken again on its own. Then paste into **B**:

```
Call inbox. Then call inbox a second time. Reply with both raw tool results verbatim, labelled "first" and "second", and nothing else.
```

- Result 8a (survived): `PASS / FAIL` — is "Message across the restart." in the first result? first
  {"messages":[],"userReplies":[],"notificationReplies":[],"acknowledgements":[]}

second
{"messages":[],"userReplies":[],"notificationReplies":[],"acknowledgements":[]}

- Result 8b (no duplication): `PASS / FAIL` — second result empty, and the message appears once? ______

Paste into **A**:

```
Call send_message with target_agent_id set to B's agent id and message "After the restart." Then reply with the raw tool result verbatim and nothing else.
```

- Result 8c (ids continue): `PASS / FAIL` — new messageId {"messageId":9} , higher than the one noted
  above? yes

## 9. The host database is untouched

Paste into a terminal:

```bash
cd ~/repos/t3code-extensible
cat > /tmp/host-tables.mjs <<'JS'
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.argv[2], { readOnly: true });
for (const r of db.prepare(
  "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
).all()) console.log(r.name);
JS
eval "$(fnm env)"
node /tmp/host-tables.mjs .t3-acceptance/userdata/state.sqlite
ls -A .t3-acceptance/userdata/extensions/bach/
```

- Result 9a (no extension tables): `PASS / FAIL` — any table name not starting
  `orchestration_` / `projection_` / `auth_` / `checkpoint_` / `provider_session_`? auth_pairing_links
  auth_sessions
  checkpoint_diff_blobs
  effect_sql_migrations
  orchestration_command_receipts
  orchestration_events
  projection_pending_approvals
  projection_projects
  projection_state
  projection_thread_activities
  projection_thread_messages
  projection_thread_proposed_plans
  projection_thread_sessions
  projection_threads
  projection_turns
  provider_session_runtime
  sqlite_sequence
  bach.sqlite bach.sqlite-shm bach.sqlite-wal
- Result 9b (own database): `PASS / FAIL` — files listed under `extensions/bach/`: ______

---

When every line above is filled in, paste the whole file back.
