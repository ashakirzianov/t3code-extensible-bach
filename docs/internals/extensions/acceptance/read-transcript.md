# Clean-room acceptance run — reading the builder's transcript

For the examiner, after the run. Everything the builder did is in the dev home's database;
this is how to get at it without touching the live one.

Every query below is written to a file first rather than passed with `node -e`. SQL string
literals have to be single-quoted — SQLite reads `"tool.completed"` as a _column name_ and
fails — and single quotes cannot survive inside a single-quoted shell argument. All of these
are run and verified against a real database.

## 1. Take a snapshot, never open the original

`VACUUM INTO` is safe while a server has the source open and yields one consistent file. Never
open the run's database read-write, and never point a server at the copy.

```bash
cd ~/repos/t3code-extensible
rm -rf /tmp/acceptance && mkdir -p /tmp/acceptance   # VACUUM INTO refuses to overwrite
eval "$(fnm env)"

cat > /tmp/acceptance/snapshot.mjs <<'JS'
import { DatabaseSync } from "node:sqlite";
new DatabaseSync(process.argv[2], { readOnly: true })
  .exec("VACUUM INTO '/tmp/acceptance/state.sqlite'");
JS

node /tmp/acceptance/snapshot.mjs .t3-acceptance/userdata/state.sqlite
```

Work only against `/tmp/acceptance/state.sqlite` from here.

## 2. What is in it

| Table                          | What you want from it                                                                                          |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `projection_threads`           | `thread_id`, `title`, `project_id`, `created_at` — find the builder's thread and every agent thread it spawned |
| `projection_thread_messages`   | `role`, `text`, `created_at` — the prose half of the conversation                                              |
| `projection_thread_activities` | `kind`, `summary`, `payload_json`, `created_at` — every tool call. This is where the answer lives              |

`payload_json` carries `itemType` (`command_execution`, `dynamic_tool_call`, `mcp_tool_call`,
`file_change`, `web_search`), a one-line `detail`, and `data.toolName` / `data.input`. Rows
with `kind = 'tool.completed'` are one per finished call; `tool.started` and `tool.updated` are
the same call mid-flight, so count only `tool.completed` or you will triple everything.

## 3. Find the builder's thread

```bash
cat > /tmp/acceptance/threads.mjs <<'JS'
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.argv[2], { readOnly: true });
for (const r of db.prepare(`
  SELECT t.thread_id, t.title, t.created_at, COUNT(a.activity_id) AS calls
  FROM projection_threads t
  LEFT JOIN projection_thread_activities a
    ON a.thread_id = t.thread_id AND a.kind = 'tool.completed'
  WHERE t.deleted_at IS NULL
  GROUP BY t.thread_id
  ORDER BY t.created_at
`).all()) {
  console.log(r.created_at, String(r.calls).padStart(5), r.thread_id, r.title);
}
JS

node /tmp/acceptance/threads.mjs /tmp/acceptance/state.sqlite
```

The builder is the earliest thread with by far the most calls; the rest are the agents it
spawned. Then:

```bash
export BUILDER=<thread_id>
```

## 4. The number that matters: host source read instead of the guide

Each hit is a guide gap (diagnostic §2). The two generated guides and the reference extension
are excluded — reading those is the guide working.

```bash
cat > /tmp/acceptance/gaps.mjs <<'JS'
import { DatabaseSync } from "node:sqlite";
const [dbPath, threadId] = process.argv.slice(2);
const db = new DatabaseSync(dbPath, { readOnly: true });
const calls = db.prepare(`
  SELECT created_at, json_extract(payload_json, '$.detail') AS detail
  FROM projection_thread_activities
  WHERE thread_id = ? AND kind = 'tool.completed'
  ORDER BY created_at
`).all(threadId);
const host = /(^|[^\w/])(apps\/(server|web|desktop|mobile)|packages\/(contracts|shared|client-runtime))\//;
const guide = /(extensions\/reference|docs\/internals\/extensions\/(reference|scaffold)\.md|generated\/extensions)/;
const hits = calls.filter((r) => r.detail && host.test(r.detail) && !guide.test(r.detail));
console.log(`host-source reads: ${hits.length} of ${calls.length} completed tool calls`);
for (const h of hits) {
  console.log("  ", h.created_at, String(h.detail).replace(/\s+/g, " ").slice(0, 160));
}
JS

node /tmp/acceptance/gaps.mjs /tmp/acceptance/state.sqlite "$BUILDER"
```

Read every hit and put it in the diagnostic's table — the raw count is the headline, but _what
it was looking for_ is the finding. A cluster of reads around one host file usually means one
missing paragraph in the guide, not several.

## 5. Turns, and what it spent them on

```bash
cat > /tmp/acceptance/effort.mjs <<'JS'
import { DatabaseSync } from "node:sqlite";
const [dbPath, threadId] = process.argv.slice(2);
const db = new DatabaseSync(dbPath, { readOnly: true });
const one = (sql) => db.prepare(sql).get(threadId).n;
console.log("turns:", one("SELECT COUNT(*) n FROM projection_turns WHERE thread_id = ?"));
console.log(
  "user messages:",
  one("SELECT COUNT(*) n FROM projection_thread_messages WHERE thread_id = ? AND role = 'user'"),
);
for (const r of db.prepare(`
  SELECT json_extract(payload_json, '$.itemType') AS kind, COUNT(*) AS n
  FROM projection_thread_activities
  WHERE thread_id = ? AND kind = 'tool.completed'
  GROUP BY kind ORDER BY n DESC
`).all(threadId)) console.log("  ", r.kind, r.n);
JS

node /tmp/acceptance/effort.mjs /tmp/acceptance/state.sqlite "$BUILDER"
```

`user messages` above one counts the times Anton had to intervene. Cross-check it against his
notes and read each one:

```bash
cat > /tmp/acceptance/asks.mjs <<'JS'
import { DatabaseSync } from "node:sqlite";
const [dbPath, threadId] = process.argv.slice(2);
const db = new DatabaseSync(dbPath, { readOnly: true });
for (const r of db.prepare(`
  SELECT created_at, text FROM projection_thread_messages
  WHERE thread_id = ? AND role = 'user'
  ORDER BY created_at
`).all(threadId)) console.log("---", r.created_at, "\n", r.text.slice(0, 600));
JS

node /tmp/acceptance/asks.mjs /tmp/acceptance/state.sqlite "$BUILDER"
```

The first is the spec prompt; every later one is a question the guide failed to answer.

## 6. Then clean up

Once the diagnostic is written, `rm -rf /tmp/acceptance` and tell Anton the `.t3-acceptance`
home is free to remove. Nothing from the run belongs in the repository — the diagnostic report
is the artifact.
