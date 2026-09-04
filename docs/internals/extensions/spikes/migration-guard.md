# Spike: does upstream guard against a newer-migrated database?

**Answer: no. It ignores the unknown migrations and runs anyway, silently.** When the
migration marker stored in a home exceeds the highest migration the running build knows,
the server logs nothing at the default level, boots normally, and serves traffic against a
schema it has never seen. Verified empirically on 2026-09-04 against `main` at `d7cf8aaa8`.

## How the migrator decides

`runMigrations` (`apps/server/src/persistence/Migrations.ts:154-163`) is called from the
SQLite layer's `setup` (`apps/server/src/persistence/Layers/Sqlite.ts:33-41`), right after
the `busy_timeout` / `foreign_keys` / `journal_mode` pragmas and before anything else opens
the database. It delegates to Effect's `Migrator.make({})`
(`apps/server/src/persistence/Migrations.ts:138`) with a loader built from the 47 statically
imported entries in `migrationEntries` (`Migrations.ts:73-121`).

The decision is in the vendored Effect source,
`.repos/effect-smol/packages/effect/src/unstable/sql/Migrator.ts`:

- `latestMigration` (`:161-174`) reads `SELECT ... FROM effect_sql_migrations ORDER BY
migration_id DESC` and takes the first row — the **maximum** recorded id.
- `run` (`:228-259`) folds that to `latestMigrationId`, then walks the known migrations and
  `continue`s on every one where `currentId <= latestMigrationId`.

That comparison is one-directional. There is no branch that asks whether
`latestMigrationId` exceeds `max(known ids)`. `MigrationError` even declares a `"BadState"`
kind (`:79-89`) but nothing in the file ever constructs one. With the marker ahead of the
known set, `required` is empty, the transaction commits, and `runMigrations` takes its
`Effect.logDebug("Database schema is current")` branch (`Migrations.ts:159-161`) — debug
level, so invisible at the server's default verbosity.

## Empirical proof

Scratch home seeded from the developer's real data per the AGENTS "Test data" rules
(`VACUUM INTO` from `~/.t3/userdata/state.sqlite` into `.t3-scratch/userdata/`). The live
install turned out to sit at migration **43**, while this checkout knows **47** — the
version skew this spike is about is already real on this machine.

**Baseline** — fork build (knows 47) opening a home at 43:

```
[dev-runner] mode=dev source=default ports serverPort=13773 webPort=5733 baseDir=.../.t3-scratch
INFO (#6): Migrations ran successfully
  migrations: [ '44_ClearAutomaticProjectModelDefaults', '45_ProjectionProjectsAutoPull',
                '46_RepairAutomaticSettlementTimestamps', '47_ProjectionProjectIcon' ]
INFO (#280): Listening on http://127.0.0.1:13773
```

Note what this baseline already shows: the fork **silently migrated the developer's real
database forward by four migrations**. That is the reverse hazard, and it is equally
unguarded — after this, an older upstream install opens a database it does not recognise.

**The hazard direction** — marker pushed past the known max, simulating an auto-updated
upstream that ran migrations 48 and 49:

```sql
INSERT INTO effect_sql_migrations (migration_id, name)
VALUES (48,'FutureUpstreamThing'), (49,'AnotherFutureUpstreamThing');
```

Restarting the server against that home produced **no migration line at all**, no warning,
and no error:

```
[dev-runner] mode=dev source=default ports serverPort=13773 webPort=5733 baseDir=.../.t3-scratch
INFO (#268): Listening on http://127.0.0.1:13773
INFO (#267): provider.session.reaper.started
INFO (#604): Authentication required. Open T3 Code using the pairing URL.
```

It then served traffic (`GET /` → HTTP 302, the auth redirect) and left the marker at 49.
An operator has no signal whatsoever that the build is running against a stranger's schema.

Why this is quiet rather than loud in practice: migrations that only _add_ columns, tables,
or indexes leave the old queries working, so the fork limps along until upstream renames,
drops, or changes the meaning of something the fork reads — and then it fails at an
arbitrary query, far from the cause.

## Where the guard belongs

**File:** `apps/server/src/persistence/Migrations.ts`, inside `runMigrations`
(`:154-163`), before `run({ loader: ... })`.

Put it here rather than in the vendored Effect `Migrator`: `.repos/` is read-only, and
`runMigrations` is the single choke point every on-disk open already passes through
(`Layers/Sqlite.ts:40`), so CLI commands, the desktop backend, and `npx t3` all inherit it
with one edit. It also already has `migrationEntries` in scope, so `max(known ids)` is free.

**Shape:** refuse to open. Read `max(migration_id)` from `effect_sql_migrations` (the table
may not exist yet on a fresh home — treat that as 0), compare against
`migrationEntries.at(-1)![0]`, and on `stored > known` fail with a tagged error that names
both numbers and the path, rather than logging and continuing. Failing the layer aborts
startup before any projection reads the schema.

Plain message, naming the numbers:

```
This T3 Code build cannot open /Users/x/.t3/userdata: the database has been migrated to
schema 49 by a newer version, and this build only knows up to 47. Update T3 Code, or point
this build at a different data directory with --home-dir.
```

Two notes for whoever implements it:

- `toMigrationInclusive` (`Migrations.ts:140-142,157`) deliberately runs a _subset_, so the
  guard must compare against the full `migrationEntries` max, not the truncated loader —
  otherwise partial-migration tests start failing.
- The reverse direction (fork ahead of the home, seen in the baseline above) is a real
  hazard too but is **not** something to refuse: migrating forward is the normal upgrade
  path. Design §8's "the fork adds no migrations to the host DB" is what keeps that safe,
  and the guard above is what catches the case where upstream did.

## Implication for the design

Design §11 lists "whether upstream already guards against opening a newer-migrated
database" as a thing to verify. It does not. Design §8's parenthetical "(add if upstream
lacks it)" is therefore live work, not a contingency. §8's premise otherwise holds: sharing
`~/.t3` is safe in the fork→upstream direction only as long as the fork adds no migrations
of its own, and the guard is what makes the upstream→fork direction survivable.

See also [home-lock.md](home-lock.md) — the same startup path is where a home lock belongs,
and the two guards want to land together.
