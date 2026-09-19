/**
 * Story 3.6: records that a dispute was opened -- who opened it, which role
 * they opened it as, the reason, and the policy's own suggested outcome.
 * Written by `services/booking.ts`'s `submitSignedTransaction` only once a
 * signed transaction matching the booking's own pending dispute hash is
 * actually relayed (review round: not at build time any more -- see
 * `db/bookings.ts`'s `setPendingDispute`'s own doc comment for why). Read by
 * `listOpenDisputes` for the admin "Resolutions" list. Distinct from
 * `db/escrowDisputeResolutions.ts`, which records the *admin's* later
 * decision, never the dispute's own opening.
 */
import { eq, inArray } from "drizzle-orm";

import type { Db } from "./client.js";
import { escrowDisputeOpenings, type DisputeOpenerRole, type DisputeOutcome, type DisputeReason } from "./schema.js";

export interface NewEscrowDisputeOpening {
  bookingId: string;
  contractId: string;
  openedByWallet: string;
  openedByRole: DisputeOpenerRole;
  reason: DisputeReason;
  /** `undefined` only for `reason: "disagreement"` -- the cancellation
   * policy names no automatic outcome for a plain disagreement. */
  suggestedOutcome?: DisputeOutcome;
  txHash: string;
  /** UTC epoch seconds. */
  openedAt: number;
}

/** Records one booking's dispute opening, replacing whichever one (if any)
 * was recorded before it -- an atomic upsert: a booking's deposit can only
 * ever be disputed once before it is resolved, but a resolved dispute could
 * in principle be followed by a fresh one on the same booking id in a later
 * story, so this stays an upsert rather than an insert-only write. The
 * booking-level precondition is `submitSignedTransaction`'s own job, checked
 * before this is ever called. */
export async function recordEscrowDisputeOpening(db: Db, values: NewEscrowDisputeOpening): Promise<void> {
  await db
    .insert(escrowDisputeOpenings)
    .values({ ...values, suggestedOutcome: values.suggestedOutcome ?? null })
    .onConflictDoUpdate({
      target: escrowDisputeOpenings.bookingId,
      set: {
        contractId: values.contractId,
        openedByWallet: values.openedByWallet,
        openedByRole: values.openedByRole,
        reason: values.reason,
        suggestedOutcome: values.suggestedOutcome ?? null,
        txHash: values.txHash,
        openedAt: values.openedAt,
      },
    });
}

export type EscrowDisputeOpeningRow = typeof escrowDisputeOpenings.$inferSelect;

export async function getEscrowDisputeOpening(db: Db, bookingId: string): Promise<EscrowDisputeOpeningRow | undefined> {
  const rows = await db.select().from(escrowDisputeOpenings).where(eq(escrowDisputeOpenings.bookingId, bookingId)).limit(1);
  return rows[0];
}

/** Story 3.6 (review round): every recorded opening for the ids in
 * `bookingIds`, keyed by `bookingId` -- one query for a whole list
 * (`listOpenDisputes`'s own N+1 avoidance, same discipline as
 * `getEscrowDisputeResolutionsForBookings`), never one query per row. Empty
 * input short-circuits to an empty map. A booking with no recorded opening
 * (a dispute raised outside Pactly's own `/bookings/:id/dispute` route, or
 * one recorded against a contract this booking has since moved past) is
 * simply absent from the map -- the caller's own "reason unknown" fallback. */
export async function getEscrowDisputeOpeningsForBookings(db: Db, bookingIds: string[]): Promise<Map<string, EscrowDisputeOpeningRow>> {
  if (bookingIds.length === 0) return new Map();
  const rows = await db.select().from(escrowDisputeOpenings).where(inArray(escrowDisputeOpenings.bookingId, bookingIds));
  return new Map(rows.map((row) => [row.bookingId, row]));
}
