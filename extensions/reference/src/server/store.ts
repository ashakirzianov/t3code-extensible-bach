/**
 * The extension's own database.
 *
 * `node:sqlite` is built into Node 24 and into the Node that Electron 43 ships,
 * so an extension needs no native dependency to persist anything (verified in
 * spikes/electron-runtime.md). The file lives in the host-assigned data
 * directory: the extension folder itself is read-only when shipped inside an
 * app bundle.
 *
 * The extension owns this schema outright. The host adds no tables and runs no
 * migrations here — which is what lets the fork share a T3 home with upstream.
 */
import * as NodeSqlite from "node:sqlite";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export interface EchoRecord {
  readonly id: number;
  readonly at: string;
  readonly threadId: string;
  readonly message: string;
}

export class EchoStore {
  #db: NodeSqlite.DatabaseSync;

  constructor(dataDirectory: string) {
    NodeFS.mkdirSync(dataDirectory, { recursive: true });
    this.#db = new NodeSqlite.DatabaseSync(
      NodePath.join(dataDirectory, "reference-extension.sqlite"),
    );
    // Migrations are the extension's job, run at its own cadence on startup.
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS echoes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        message TEXT NOT NULL
      )
    `);
  }

  record(threadId: string, message: string): EchoRecord {
    const at = new Date().toISOString();
    const { lastInsertRowid } = this.#db
      .prepare("INSERT INTO echoes (at, thread_id, message) VALUES (?, ?, ?)")
      .run(at, threadId, message);
    return { id: Number(lastInsertRowid), at, threadId, message };
  }

  count(): number {
    const row = this.#db.prepare("SELECT COUNT(*) AS n FROM echoes").get() as { n: number };
    return row.n;
  }

  latest(): EchoRecord | undefined {
    const row = this.#db
      .prepare("SELECT id, at, thread_id AS threadId, message FROM echoes ORDER BY id DESC LIMIT 1")
      .get() as EchoRecord | undefined;
    return row;
  }

  close(): void {
    this.#db.close();
  }
}
