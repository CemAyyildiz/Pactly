/**
 * Pactly's own dispute-resolution decisions (Design Notes: "Why the
 * resolution decision is recorded with its txHash"). Written by
 * `services/booking.ts`'s `resolveBookingDispute`, the moment the unsigned
 * resolve-dispute XDR is built -- never by the reconciler, which only ever
 * *reads* this table to learn which of `refunded`/`released` a chain-shown
 * resolved dispute actually means (the read-model shows that a dispute
 * resolved, never to whom the money went).
 */
import { eq, inArray } from "drizzle-orm";

import type { Db } from "./client.js";
import { escrowDisputeResolutions, type DisputeOutcome } from "./schema.js";

export interface NewEscrowDisputeResolution {
  bookingId: string;
  contractId: string;
  outcome: DisputeOutcome;
  txHash: string;
  decidedAt: number;
}

/** Records one booking's dispute-resolution decision, replacing whichever
 * one (if any) was recorded before it -- a single atomic upsert, never a
 * check-then-insert: an unsigned or expired XDR from an earlier
 * `resolveBookingDispute` call must not permanently lock the booking to a
 * decision nobody ever actually signed, and a concurrent call racing this
 * one must never surface a raw SQLite constraint-violation error. The
 * booking-level precondition (locked, with chain-confirmed `disputed`
 * evidence for this same `contractId`) is `resolveBookingDispute`'s own
 * job, checked before this is ever called -- this function only ever
 * touches its own table. */
export async function recordEscrowDisputeResolution(db: Db, values: NewEscrowDisputeResolution): Promise<void> {
  await db
    .insert(escrowDisputeResolutions)
    .values(values)
    .onConflictDoUpdate({
      target: escrowDisputeResolutions.bookingId,
      set: { contractId: values.contractId, outcome: values.outcome, txHash: values.txHash, decidedAt: values.decidedAt },
    });
}

export type EscrowDisputeResolutionRow = typeof escrowDisputeResolutions.$inferSelect;

export async function getEscrowDisputeResolution(db: Db, bookingId: string): Promise<EscrowDisputeResolutionRow | undefined> {
  const rows = await db.select().from(escrowDisputeResolutions).where(eq(escrowDisputeResolutions.bookingId, bookingId)).limit(1);
  return rows[0];
}

/** Story 3.5: every recorded decision for the ids in `bookingIds`, keyed by
 * `bookingId` -- one query for a whole list
 * (`getEscrowLifecycleForBookings`'s own N+1 avoidance), never one query per
 * row. Empty input short-circuits to an empty map. */
export async function getEscrowDisputeResolutionsForBookings(
  db: Db,
  bookingIds: string[],
): Promise<Map<string, EscrowDisputeResolutionRow>> {
  if (bookingIds.length === 0) return new Map();
  const rows = await db.select().from(escrowDisputeResolutions).where(inArray(escrowDisputeResolutions.bookingId, bookingIds));
  return new Map(rows.map((row) => [row.bookingId, row]));
}
