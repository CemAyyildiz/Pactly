/**
 * Story 3.6: records that a dispute was opened -- who opened it, the reason,
 * and the policy's own suggested outcome. Written by `services/booking.ts`'s
 * `openDispute` the moment the unsigned start-dispute XDR is built; read by
 * `listOpenDisputes` for the admin "Resolutions" list. Distinct from
 * `db/escrowDisputeResolutions.ts`, which records the *admin's* later
 * decision, never the dispute's own opening.
 */
import { eq } from "drizzle-orm";

import type { Db } from "./client.js";
import { escrowDisputeOpenings, type DisputeOutcome, type DisputeReason } from "./schema.js";

export interface NewEscrowDisputeOpening {
  bookingId: string;
  contractId: string;
  openedByWallet: string;
  reason: DisputeReason;
  /** `undefined` only for `reason: "disagreement"` -- the cancellation
   * policy names no automatic outcome for a plain disagreement. */
  suggestedOutcome?: DisputeOutcome;
  txHash: string;
  openedAt: number;
}

/** Records one booking's dispute opening, replacing whichever one (if any)
 * was recorded before it -- an atomic upsert, same discipline as
 * `recordEscrowDisputeResolution`: an unsigned or expired start-dispute XDR
 * from an earlier attempt must not permanently block a corrected retry. The
 * booking-level precondition (locked, not already disputed) is
 * `openDispute`'s own job, checked before this is ever called. */
export async function recordEscrowDisputeOpening(db: Db, values: NewEscrowDisputeOpening): Promise<void> {
  await db
    .insert(escrowDisputeOpenings)
    .values({ ...values, suggestedOutcome: values.suggestedOutcome ?? null })
    .onConflictDoUpdate({
      target: escrowDisputeOpenings.bookingId,
      set: {
        contractId: values.contractId,
        openedByWallet: values.openedByWallet,
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

/** Every recorded dispute opening, across every booking -- the admin
 * disputes list's own starting point (Story 3.6, demo scale: a handful of
 * open disputes at most, so one unfiltered read plus an in-memory filter
 * against each booking's current chain-derived lifecycle is simpler, and no
 * slower in practice, than a joined SQL query). `listOpenDisputes`
 * (`services/booking.ts`) is what actually narrows this down to *currently
 * open* disputes. */
export async function listAllEscrowDisputeOpenings(db: Db): Promise<EscrowDisputeOpeningRow[]> {
  return db.select().from(escrowDisputeOpenings);
}
