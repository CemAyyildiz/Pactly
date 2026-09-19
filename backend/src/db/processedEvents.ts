/**
 * The dedupe ledger AD-9 requires. `../chain/event-worker.ts` is the only
 * caller: every event it sees, known booking or not, gets a row here
 * exactly once, keyed by `(booking_id, event_type)`.
 */
import { and, eq } from "drizzle-orm";

import type { Db, DbOrTx } from "./client.js";
import { processedEvents, type EscrowState } from "./schema.js";

export interface NewProcessedEvent {
  bookingId: string;
  /** One of the five chain event names -- kept as free text here (not the
   * narrower `EscrowState`) because `released`/`forfeited` and
   * `refunded`/`cancelled` share a state but must stay distinct rows. */
  eventType: string;
  amount: string;
  ledger: number;
  eventId: string;
  isAnomaly: boolean;
  processedAt: number;
}

/** Synchronous form -- callable either directly or (its reason for
 * existing) from inside a `db.transaction()` callback, which on
 * better-sqlite3 must never `await` (see `bookings.ts`'s
 * `updateEscrowStateSync` for why). Same dedupe behavior as
 * {@link insertProcessedEventIfNew}. */
export function insertProcessedEventIfNewSync(db: DbOrTx, event: NewProcessedEvent): boolean {
  const result = db.insert(processedEvents).values(event).onConflictDoNothing().run();
  return result.changes > 0;
}

/** Inserts a processed-event row unless `(bookingId, eventType)` already
 * has one, in which case this is a no-op. Returns `true` when the row was
 * newly inserted (a fresh event to act on), `false` for a replay -- the
 * I/O matrix's "same event twice" row: nothing changes, no duplicate row. */
export async function insertProcessedEventIfNew(db: Db, event: NewProcessedEvent): Promise<boolean> {
  return insertProcessedEventIfNewSync(db, event);
}

export type ProcessedEventRow = typeof processedEvents.$inferSelect;

export async function getProcessedEvent(
  db: Db,
  bookingId: string,
  eventType: EscrowState | string,
): Promise<ProcessedEventRow | undefined> {
  const rows = await db
    .select()
    .from(processedEvents)
    .where(and(eq(processedEvents.bookingId, bookingId), eq(processedEvents.eventType, eventType)))
    .limit(1);
  return rows[0];
}
