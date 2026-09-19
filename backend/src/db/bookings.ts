/**
 * The only place SQL touches the `bookings` table. `updateEscrowState` is
 * called from exactly one place in the whole codebase --
 * `../chain/event-worker.ts` -- which is what AD-1/AD-3 mean in practice:
 * nothing else may write `escrow_state`.
 */
import { eq } from "drizzle-orm";

import type { Db, DbOrTx } from "./client.js";
import { bookings, type BalanceState, type EscrowState } from "./schema.js";

export interface NewBooking {
  id: string;
  providerProfileId: string;
  clientWalletAddress: string;
  tokenAddress: string;
  depositAmount: string;
  balanceAmount?: string;
  cancelDeadline: number;
  balanceState?: BalanceState;
  createdAt: number;
}

export type BookingRow = typeof bookings.$inferSelect;

/** Writes a booking's initial row -- before any chain call, per AD-13: the
 * backend's hold generates the id and this row exists so the event worker
 * has something to mirror state onto once the chain confirms it. Never
 * sets `escrowState`; it starts `null` and stays that way until the event
 * worker processes this booking's first event. */
export async function insertBooking(db: Db, values: NewBooking): Promise<void> {
  await db.insert(bookings).values({
    id: values.id,
    providerProfileId: values.providerProfileId,
    clientWalletAddress: values.clientWalletAddress,
    tokenAddress: values.tokenAddress,
    depositAmount: values.depositAmount,
    balanceAmount: values.balanceAmount ?? "0",
    cancelDeadline: values.cancelDeadline,
    balanceState: values.balanceState ?? "unpaid",
    createdAt: values.createdAt,
  });
}

export async function getBookingById(db: Db, id: string): Promise<BookingRow | undefined> {
  const rows = await db.select().from(bookings).where(eq(bookings.id, id)).limit(1);
  return rows[0];
}

/** The event worker's own write path, as a synchronous call -- callable
 * either directly or (its reason for existing) from inside a
 * `db.transaction()` callback, which on better-sqlite3 must never `await`
 * (a transaction there is a real synchronous BEGIN/COMMIT wrapped around a
 * plain function call; an `await` inside would let the driver COMMIT
 * before the awaited write actually runs). Touches `escrowState` alone --
 * never `balanceState`, which is a different owner's column (AD-3).
 * Throws if `id` matches no row, rather than silently writing nothing. */
export function updateEscrowStateSync(db: DbOrTx, id: string, escrowState: EscrowState): void {
  const result = db.update(bookings).set({ escrowState }).where(eq(bookings.id, id)).run();
  if (result.changes === 0) {
    throw new TypeError(`No booking exists with id "${id}"`);
  }
}

/** The event worker's own write path. Touches `escrowState` alone -- never
 * `balanceState`, which is a different owner's column (AD-3). */
export async function updateEscrowState(db: Db, id: string, escrowState: EscrowState): Promise<void> {
  updateEscrowStateSync(db, id, escrowState);
}

/** The backend's own write path for the balance side of AD-3. Touches
 * `balanceState` alone -- never `escrowState`. Throws if `id` matches no
 * row, rather than silently writing nothing. */
export async function updateBalanceState(db: Db, id: string, balanceState: BalanceState): Promise<void> {
  const result = await db.update(bookings).set({ balanceState }).where(eq(bookings.id, id));
  if (result.changes === 0) {
    throw new TypeError(`No booking exists with id "${id}"`);
  }
}
