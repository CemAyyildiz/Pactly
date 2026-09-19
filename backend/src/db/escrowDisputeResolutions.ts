/**
 * Pactly's own dispute-resolution decisions (Story 2.6, Design Notes: "Why
 * the resolution decision is recorded with its txHash"). Written once by
 * `services/booking.ts`'s `resolveBookingDispute`, the moment the unsigned
 * resolve-dispute XDR is built -- never by the reconciler, which only ever
 * *reads* this table to learn which of `refunded`/`released` a chain-shown
 * resolved dispute actually means (the read-model shows that a dispute
 * resolved, never to whom the money went).
 */
import { eq } from "drizzle-orm";

import type { Db } from "./client.js";
import { escrowDisputeResolutions, type DisputeOutcome } from "./schema.js";

export interface NewEscrowDisputeResolution {
  bookingId: string;
  contractId: string;
  outcome: DisputeOutcome;
  txHash: string;
  decidedAt: number;
}

/** At most one resolution per booking, ever -- a booking's deposit can only
 * be allocated once. Throws on a second attempt rather than silently
 * overwriting an earlier decision with a different one. */
export async function recordEscrowDisputeResolution(db: Db, values: NewEscrowDisputeResolution): Promise<void> {
  const existing = await getEscrowDisputeResolution(db, values.bookingId);
  if (existing) {
    throw new TypeError(`A dispute resolution is already recorded for booking "${values.bookingId}"`);
  }
  await db.insert(escrowDisputeResolutions).values(values);
}

export type EscrowDisputeResolutionRow = typeof escrowDisputeResolutions.$inferSelect;

export async function getEscrowDisputeResolution(db: Db, bookingId: string): Promise<EscrowDisputeResolutionRow | undefined> {
  const rows = await db.select().from(escrowDisputeResolutions).where(eq(escrowDisputeResolutions.bookingId, bookingId)).limit(1);
  return rows[0];
}
