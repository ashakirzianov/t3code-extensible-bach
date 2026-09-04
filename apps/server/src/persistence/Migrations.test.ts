import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { DatabaseMigratedAheadError, latestKnownMigrationId, runMigrations } from "./Migrations.ts";

/** A private in-memory database per test, so each starts from a fresh home. */
const freshDatabase = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.provide(effect, NodeSqliteClient.layerMemory());

/** Records a migration this build does not know about, as a newer build would. */
const recordFutureMigration = (id: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${id}, ${"FutureUpstreamThing"})`;
  });

describe("migration guard", () => {
  it.effect("refuses to open a database migrated past the known set", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* recordFutureMigration(latestKnownMigrationId + 2);

      const error = yield* runMigrations({ databasePath: "/tmp/home/state.sqlite" }).pipe(
        Effect.flip,
      );

      assert.instanceOf(error, DatabaseMigratedAheadError);
      assert.equal(error.storedMigrationId, latestKnownMigrationId + 2);
      assert.equal(error.knownMigrationId, latestKnownMigrationId);
      assert.include(error.message, "/tmp/home/state.sqlite");
      assert.include(error.message, String(latestKnownMigrationId + 2));
      assert.include(error.message, String(latestKnownMigrationId));
    }).pipe(freshDatabase),
  );

  it.effect("leaves the database untouched when it refuses", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* recordFutureMigration(latestKnownMigrationId + 1);

      yield* runMigrations().pipe(Effect.flip);

      const rows = yield* sql<{
        readonly migration_id: number;
      }>`SELECT migration_id FROM effect_sql_migrations ORDER BY migration_id DESC LIMIT 1`
        .withoutTransform;
      assert.equal(rows[0]?.migration_id, latestKnownMigrationId + 1);
    }).pipe(freshDatabase),
  );

  it.effect("opens a fresh database, where the migrations table does not exist yet", () =>
    Effect.gen(function* () {
      const executed = yield* runMigrations();
      assert.equal(executed.at(-1)?.[0], latestKnownMigrationId);
    }).pipe(freshDatabase),
  );

  it.effect("still runs a subset when toMigrationInclusive is below the known max", () =>
    Effect.gen(function* () {
      const first = yield* runMigrations({ toMigrationInclusive: 5 });
      assert.equal(first.at(-1)?.[0], 5);

      // The guard compares against the full set, not the truncated loader, so
      // stepping forward from a subset run must not look like a newer database.
      const second = yield* runMigrations({ toMigrationInclusive: 8 });
      assert.deepEqual(
        second.map(([id]) => id),
        [6, 7, 8],
      );
    }).pipe(freshDatabase),
  );
});
