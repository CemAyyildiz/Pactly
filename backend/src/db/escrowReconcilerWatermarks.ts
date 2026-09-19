/**
 * The reconciler's per-escrow restart watermark (Story 2.6, amended
 * 2026-09-19; AC4). One row per `contractId` this backend has ever polled,
 * holding the highest `EscrowSummary.lastLedgerSeq` observed for it -- so a
 * restart (or a later poll that sees the exact same read-model snapshot)
 * skips a row it has already looked at, per the I/O matrix's "reconciler
 * restarted" row. Compared as `bigint`, never as a string or a JS `number`
 * (a ledger sequence can exceed `Number.MAX_SAFE_INTEGER` over a long
 * enough chain history) or floats.
 */
import { eq } from "drizzle-orm";

import type { Db } from "./client.js";
import { escrowReconcilerWatermarks } from "./schema.js";

/** `undefined` when this `contractId` has never been polled before. */
export async function getEscrowWatermark(db: Db, contractId: string): Promise<string | undefined> {
  const rows = await db
    .select()
    .from(escrowReconcilerWatermarks)
    .where(eq(escrowReconcilerWatermarks.contractId, contractId))
    .limit(1);
  return rows[0]?.lastLedgerSeq;
}

export async function setEscrowWatermark(
  db: Db,
  contractId: string,
  lastLedgerSeq: string,
  now: number = Date.now(),
): Promise<void> {
  await db
    .insert(escrowReconcilerWatermarks)
    .values({ contractId, lastLedgerSeq, updatedAt: now })
    .onConflictDoUpdate({
      target: escrowReconcilerWatermarks.contractId,
      set: { lastLedgerSeq, updatedAt: now },
    });
}
