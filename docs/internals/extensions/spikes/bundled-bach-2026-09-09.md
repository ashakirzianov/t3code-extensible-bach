# Spike: shipping Bach in the desktop build, and migrating a live home

Verification spike for the Bach migration, which is gated on this: stripping the
Bach repo is fleet-fatal while the live app runs from it, so **bundle and
migrate first, strip last**. Four questions, answered empirically on macOS 15
(darwin 25.5.0, arm64) against this repo at `cfcfa5af0` and the rebuilt Bach at
`b130133e7` (`bach-wt-core/extension`).

Everything below ran against **scratch homes and a `VACUUM INTO` snapshot**;
the live `~/.t3/userdata` was opened read-only and never served. Throwaway
harnesses lived under `/tmp` and are deleted; nothing here is committed outside
this file.

---

## 1. Does `extension/` build a folder the host will accept?

**Answer: yes, and it validates against the host's own contract rather than
against the extension's opinion of it.**

`node build.mjs` emits exactly the folder contract of design §6.1:

```
dist/extension.json     manifest the host reads before spawning
dist/server.mjs         250 KB, every dependency bundled
dist/web/entry.js       209 KB
dist/web/entry.css      2.9 KB   (+ .map siblings)
```

Decoding `dist/extension.json` with the host's own `ExtensionManifest` schema
(`@t3tools/contracts`, run from `apps/server`) succeeds, and every path it
declares — `server.mjs`, `web/entry.js`, `web/entry.css` — resolves inside the
folder.

Self-containment was checked the strict way: the folder copied to a `mktemp -d`
whose ancestry has **no `node_modules` at all**, where `node server.mjs` still
runs and exits 2 with its "started by the host" explanation. Repeating that with
the folder `chmod -R a-w` also exits 2, which is the read-only case that matters
because the shipped copy lives inside an app bundle.

## 2. Does the desktop build ship it?

**Answer: yes, byte-identical, beside `app.asar` rather than inside it.**

```bash
T3CODE_BUNDLED_EXTENSIONS="bach=/path/to/extension/dist" \
  node scripts/build-desktop-artifact.ts --platform mac --target dir --arch arm64 --keep-stage
```

`stageBundledExtensions` copies the folder to `<stage>/apps/desktop/resources/extensions/bach`,
and electron-builder's `extraResources` carries it to
`T3 Code (Alpha).app/Contents/Resources/extensions/bach`. `diff -r` against the
source `dist` reports no differences. It sits next to `app.asar`, not inside it,
which is what makes it usable as a process `cwd` (see `electron-runtime.md` §3).

**Two notes for whoever runs this next.** `--target dir` produces a working
unpacked app but the script's artifact collection finds nothing to copy, so the
output directory holds only `builder-debug.yml`; pass `--keep-stage` and take
the app from `<stage>/app/dist/mac-arm64/`. And a `dir` build is ad-hoc signed,
so `spctl` rejects it — expected, and irrelevant to everything below.

## 3. Does Bach spawn from the app's resources, on the app's own Node?

**Answer: yes.**

The packaged server was started the way the desktop starts it — the app's own
binary with `ELECTRON_RUN_AS_NODE=1`, the entry inside `app.asar`, and the same
`--extension name=path` flag `bundledExtensionArgs` produces:

```bash
ELECTRON_RUN_AS_NODE=1 "<app>/Contents/MacOS/T3 Code (Alpha)" \
  "<app>/Contents/Resources/app.asar/apps/server/dist/bin.mjs" \
  serve --base-dir /tmp/bach-desktop-home --port 15931 \
  --extension "bach=<app>/Contents/Resources/extensions/bach"
```

The extension process that appeared is Bach, run by the app:

| Fact              | Value                                             |
| ----------------- | ------------------------------------------------- |
| argv              | `<app>/Contents/MacOS/T3 Code (Alpha) server.mjs` |
| `cwd`             | `<app>/Contents/Resources/extensions/bach`        |
| `T3_EXT_NAME`     | `bach`                                            |
| `T3_EXT_WS_URL`   | `ws://127.0.0.1:15931/ws`                         |
| `T3_EXT_DATA_DIR` | `/tmp/bach-desktop-home/userdata/extensions/bach` |

**The GUI was deliberately not launched.** `/Applications/T3 Code (Alpha).app`
was running at the time, and a second copy of the same bundle id takes the
single-instance lock path — it exits 0 immediately and hands its arguments to
the _running_ instance, which on this machine is the live fleet's host. Two
attempts did exactly that and wrote nothing. Anyone repeating this should quit
the installed app first, or do what this spike did: exercise the desktop's real
contribution, which is `readBundledExtensions` + the launch flags, and drive the
packaged server directly.

## 4. Does a live home migrate?

**Answer: yes — import, dashboard and tools all work off the bundled build.**

The scratch home was seeded with a `VACUUM INTO` snapshot of the real fleet's
`state.sqlite` (758 `bach_messages`, 53 `bach_requests`, 69 `bach_notifications`),
with `projection_thread_sessions` and `provider_session_runtime` cleared **in the
copy** so 59 real threads could not look like live provider sessions to reattach.
No `settings.json`, so nothing overrode the bundled extension.

- **Import ran from the derived path**, unprompted: `imports` records
  `status: done`, `source_path: /tmp/bach-desktop-home/userdata/state.sqlite`,
  counts `{messages: 758, requests: 53, notifications: 69, notificationReplies: 0}`.
  Bach's own file holds its seven live tables and no `bach_*`.
- **The dashboard rendered the real fleet** from the bundle in
  `Contents/Resources/extensions/bach/web/entry.js`: 17 cards, `Show hidden (37)`,
  five cards carrying imported notes with their original text and acknowledged
  state, and no diagnostics card — a healthy fleet.
- **The tools reached a fresh agent.** A new thread on Claude Haiku 4.5 listed
  all twelve: `archive_agents`, `cancel_scheduled`, `inbox`, `list_agents`,
  `list_user_messages`, `notify_user`, `request_capability`,
  `request_from_user`, `send_message`, `settle_agents`, `spawn_agent`,
  `withdraw_user_message`.

## What this does and does not license

It licenses the **bundle-and-migrate** half: a desktop build can ship Bach, and a
real home migrates into it without hand-holding. It does not license the strip —
that is a separate step, and the ordering exists because the live app runs from
the repo being stripped.

Not covered here, and worth its own pass before a real cutover: a signed build,
the GUI path (see §3), and a home that is in use at the moment of migration
rather than a snapshot of one.
