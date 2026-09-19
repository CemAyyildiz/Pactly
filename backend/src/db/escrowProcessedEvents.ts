/**
 * The reconciler's own dedupe ledger (Story 2.6, amended 2026-09-19,
 * retargeting AD-9 from `db/processedEvents.ts`). `../escrow/trustless-work/
 * reconciler.ts` is the only caller: every lifecycle transition it derives
 * gets a row here exactly once, keyed by `(contractId, lifecycleAction)` --
 * not `(bookingId, eventType)` (Story 2.5's shape) or `(transactionHash,
 * lifecycleAction)` (this story's own first, pre-amendment attempt): the
 * read-model row this reconciler derives a transition from carries no
 * per-transaction identity to key on.
 */
import { and, eq } from "drizzle-orm";

import type { Db, DbOrTx } from "./client.js";
import { escrowProcessedEvents } from "./schema.js";

export interface NewEscrowProcessedEvent {
  bookingId: string;
  contractId: string;
  lifecycleAction: string;
  amount: string;
  ledgerSeq: string;
  isAnomaly: boolean;
  processedAt: number;
}

/** Synchronous form -- callable either directly or (its reason for
 * existing) from inside a `db.transaction()` callback, which on
 * better-sqlite3 must never `await` (see `db/bookings.ts`'s
 * `updateEscrowStateSync` for why). Same dedupe behavior as
 * {@link insertEscrowProcessedEventIfNew}. */
export function insertEscrowProcessedEventIfNewSync(db: DbOrTx, event: NewEscrowProcessedEvent): boolean {
  const result = db.insert(escrowProcessedEvents).values(event).onConflictDoNothing().run();
  return result.changes > 0;
}

/** Inserts a processed-transition row unless `(contractId, lifecycleAction)`
 * already has one, in which case this is a no-op. Returns `true` when the
 * row was newly inserted (a fresh transition to act on), `false` for a
 * replay -- the I/O matrix's "same row replayed" row: nothing changes, no
 * duplicate row. */
export async function insertEscrowProcessedEventIfNew(db: Db, event: NewEscrowProcessedEvent): Promise<boolean> {
  return insertEscrowProcessedEventIfNewSync(db, event);
}

export type EscrowProcessedEventRow = typeof escrowProcessedEvents.$inferSelect;

export async function getEscrowProcessedEvent(
  db: Db,
  contractId: string,
  lifecycleAction: string,
): Promise<EscrowProcessedEventRow | undefined> {
  const rows = await db
    .select()
    .from(escrowProcessedEvents)
    .where(and(eq(escrowProcessedEvents.contractId, contractId), eq(escrowProcessedEvents.lifecycleAction, lifecycleAction)))
    .limit(1);
  return rows[0];
}

/** Every transition row recorded for one booking, in no particular order --
 * `getEscrowLifecycle` picks the most recently processed one itself. */
export async function listEscrowProcessedEventsForBooking(db: Db, bookingId: string): Promise<EscrowProcessedEventRow[]> {
  return db.select().from(escrowProcessedEvents).where(eq(escrowProcessedEvents.bookingId, bookingId));
}
