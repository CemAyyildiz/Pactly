/**
 * The cursored, idempotent event worker (AD-9) -- the only writer of
 * `bookings.escrow_state` in the whole codebase (AD-1/AD-3). Every other
 * module that touches a booking row leaves that column alone.
 *
 * `runEventWorkerOnce` is one batch: read the stored cursor, fetch events
 * since it through the injected `FetchEvents` seam (`events.ts`), apply
 * each one at most once (`processed_events` dedupes by
 * `(booking_id, event_type)`), then advance the cursor -- so a restart
 * resumes from where it left off rather than from the first ledger.
 */
import { getCursor, setCursor } from "../db/cursor.js";
import { getBookingById, updateEscrowStateSync } from "../db/bookings.js";
import { insertProcessedEventIfNewSync } from "../db/processedEvents.js";
import type { Db, DbOrTx } from "../db/client.js";
import type { EscrowState } from "../db/schema.js";
import type { ChainEvent, EventName, FetchEvents } from "./events.js";

/**
 * `released` and `forfeited` both end with the professional paid, so both
 * map to `released` -- but the event *type* is still what
 * `processed_events.event_type` stores, which is how Epic 4's
 * verified-session counter (on `released` alone) and provider-cancellation
 * counter (on `cancelled` alone) can later tell them apart (AD-4).
 */
export function escrowStateForEvent(eventType: EventName): EscrowState {
  switch (eventType) {
    case "locked":
      return "locked";
    case "released":
    case "forfeited":
      return "released";
    case "refunded":
    case "cancelled":
      return "refunded";
  }
}

export type ProcessEventOutcome = "applied" | "duplicate" | "anomaly";

export interface ProcessEventDeps {
  /** Overridable only so a test can simulate a failure between the dedupe
   * insert and the escrow-state write (see event-worker.test.ts's atomic
   * transaction test); the real writer is always {@link updateEscrowStateSync}. */
  updateEscrowState?: (tx: DbOrTx, bookingId: string, escrowState: EscrowState) => void;
}

/** Applies one event, at most once. Returns which of the three I/O-matrix
 * outcomes happened, so a caller (here, or a test) can count them without
 * re-deriving it from the database.
 *
 * The dedupe insert and the escrow-state write commit together, in one
 * `db.transaction()`: if the write throws (a real crash, or -- in a test --
 * the injected `deps.updateEscrowState` above), better-sqlite3 rolls the
 * whole transaction back, so no `processed_events` row is left behind
 * without its escrow-state write having happened. Without this, a failure
 * between the two statements would leave a dedupe row committed and the
 * escrow state never written -- and since nothing ever revisits a
 * "duplicate", that would be permanent. */
export async function processEvent(
  db: Db,
  event: ChainEvent,
  log: (message: string) => void = defaultLog,
  deps: ProcessEventDeps = {},
): Promise<ProcessEventOutcome> {
  const updateEscrowState = deps.updateEscrowState ?? updateEscrowStateSync;
  const booking = await getBookingById(db, event.bookingId);

  // Synchronous throughout, per better-sqlite3's transaction contract: an
  // `await` inside this callback would let the driver COMMIT before the
  // awaited write actually ran.
  const isNew = db.transaction((tx) => {
    const inserted = insertProcessedEventIfNewSync(tx, {
      bookingId: event.bookingId,
      eventType: event.eventType,
      amount: event.amount,
      ledger: event.ledger,
      eventId: event.id,
      isAnomaly: booking === undefined,
      processedAt: Date.now(),
    });
    if (inserted && booking) {
      updateEscrowState(tx, event.bookingId, escrowStateForEvent(event.eventType));
    }
    return inserted;
  });

  if (!isNew) {
    // Replay of an already-processed (booking_id, event_type) pair:
    // nothing changes, including the booking row untouched below.
    return "duplicate";
  }
  if (!booking) {
    // Recorded above (so a later reconciliation can find it), but no
    // booking row is invented -- the I/O matrix's "unknown booking id" row.
    log(
      `[event-worker] anomaly: "${event.eventType}" event for unknown booking ${event.bookingId} ` +
        `at ledger ${event.ledger} (event id ${event.id})`,
    );
    return "anomaly";
  }
  return "applied";
}

function defaultLog(message: string): void {
  console.error(message);
}

export interface EventWorkerDeps {
  db: Db;
  fetchEvents: FetchEvents;
  log?: (message: string) => void;
}

export interface RunEventWorkerResult {
  applied: number;
  duplicates: number;
  anomalies: number;
  cursor: string;
}

/** Runs exactly one fetch-and-apply batch. A long-running process calls
 * this in a loop (that loop is not this story's job -- see `index.ts`'s
 * code map note); a test calls it directly, once or several times, against
 * a real temporary database. */
export async function runEventWorkerOnce(deps: EventWorkerDeps): Promise<RunEventWorkerResult> {
  const { db, fetchEvents, log = defaultLog } = deps;
  const cursor = await getCursor(db);
  const { events, cursor: nextCursor } = await fetchEvents(cursor);

  let applied = 0;
  let duplicates = 0;
  let anomalies = 0;
  for (const event of events) {
    const outcome = await processEvent(db, event, log);
    if (outcome === "applied") applied += 1;
    else if (outcome === "duplicate") duplicates += 1;
    else anomalies += 1;
  }

  await setCursor(db, nextCursor);
  return { applied, duplicates, anomalies, cursor: nextCursor };
}
