/**
 * Opens the SQLite database this backend mirrors chain and marketplace
 * state into. Every caller -- the real process and every test -- goes
 * through this so the schema is always migrated the same way (`client.ts`
 * never assumes `config.databasePath`; that wiring belongs to whatever
 * composes the process, not to this factory).
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

import { runMigrations } from "./migrations.js";
import * as schema from "./schema.js";

export type Db = ReturnType<typeof drizzle<typeof schema>>;

/** `Db` itself, or the transaction handle `Db["transaction"]` hands its
 * callback -- both expose the same query-builder surface, so a write
 * helper that needs to participate in a caller's transaction (see
 * `chain/event-worker.ts`'s atomic dedupe-insert-plus-escrow-write) can
 * accept either. better-sqlite3 transactions are synchronous end to end
 * (no `await` inside the callback -- see the `*Sync` helpers in
 * `bookings.ts`/`processedEvents.ts`), which is what this type exists to
 * make possible without duplicating each write path. */
export type DbOrTx = Db | (Parameters<Db["transaction"]>[0] extends (tx: infer TX) => unknown ? TX : never);

export interface OpenDatabaseResult {
  /** The raw better-sqlite3 handle -- closing it is the caller's job
   * (`closeDatabase`), since a long-lived process and a short-lived test
   * close it at different times. */
  sqlite: Database.Database;
  db: Db;
}

/** Opens (creating if needed) the database at `path` and migrates it.
 * `path` is whatever the caller resolved -- this module never reads
 * `config` itself, so a test can point it at a temporary file without
 * touching the real one. */
export function openDatabase(path: string): OpenDatabaseResult {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const sqlite = new Database(path);
  runMigrations(sqlite);
  const db = drizzle(sqlite, { schema });
  return { sqlite, db };
}

export function closeDatabase(result: OpenDatabaseResult): void {
  result.sqlite.close();
}
