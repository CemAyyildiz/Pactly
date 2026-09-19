/**
 * The only place SQL touches the `bookings` table. `updateEscrowState` is
 * called from exactly one place in the whole codebase --
 * `../chain/event-worker.ts` -- which is what AD-1/AD-3 mean in practice:
 * nothing else may write `escrow_state`.
 */
import { and, eq, isNotNull, isNull, notInArray, or } from "drizzle-orm";

import type { Db, DbOrTx } from "./client.js";
import { bookings, providerProfiles, type BalanceState, type EscrowState } from "./schema.js";

/** `escrow_state` values the reconciler must never move a booking past --
 * once here, a booking is excluded from every future reconciliation poll
 * (AC4's "for bookings whose escrow_state is not terminal"). */
export const TERMINAL_ESCROW_STATES: readonly EscrowState[] = ["released", "refunded"];

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

/** Same as {@link updateEscrowStateSync}, except the write itself is
 * conditioned in SQL on the row not already being terminal -- `WHERE id = ?
 * AND (escrow_state IS NULL OR escrow_state NOT IN ('released',
 * 'refunded'))`. The reconciler's own in-memory terminal check
 * (`processEscrowRow`) reads a booking snapshot fetched once per batch, so
 * a second row for the same escrow processed later in that same batch
 * could otherwise regress an already-terminal booking (e.g.
 * `released` -> `locked`) before the first row's own write is even
 * visible to that stale snapshot. Returns `true` only when a row was
 * actually written -- `false` when the booking was already terminal (by
 * this point, not necessarily by the caller's own possibly-stale check) or
 * does not exist. */
export function updateEscrowStateIfNotTerminalSync(db: DbOrTx, id: string, escrowState: EscrowState): boolean {
  const result = db
    .update(bookings)
    .set({ escrowState })
    .where(
      and(
        eq(bookings.id, id),
        or(isNull(bookings.escrowState), notInArray(bookings.escrowState, [...TERMINAL_ESCROW_STATES])),
      ),
    )
    .run();
  return result.changes > 0;
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

/** `services/booking.ts`'s `lockDeposit` write path: persists the escrow's
 * predicted `contractId` the moment the deploy XDR is built -- once, ever,
 * per booking. The write itself is conditioned in SQL (`WHERE id = ? AND
 * escrow_state IS NULL AND escrow_contract_id IS NULL`) so a second
 * `lockDeposit` can never silently overwrite a `contractId` whose deploy
 * (and possibly `fundDeposit`) may already have landed on chain -- doing so
 * would orphan whatever was actually funded, since every later call
 * (`fundDeposit`, the reconciler) only ever looks at the *current* column
 * value. Throws when the write did not happen, whether because `id` does
 * not exist, an `escrowState` is already recorded, or a `contractId` is
 * already persisted -- `services/booking.ts`'s own pre-check is expected to
 * have already ruled out the first two cases with a more specific error;
 * this is the defense against the same race in the small window between
 * that check and this write. */
export async function updateEscrowContractId(db: Db, id: string, contractId: string): Promise<void> {
  const result = await db
    .update(bookings)
    .set({ escrowContractId: contractId })
    .where(and(eq(bookings.id, id), isNull(bookings.escrowState), isNull(bookings.escrowContractId)));
  if (result.changes === 0) {
    throw new TypeError(
      `Could not persist escrowContractId for booking "${id}": it does not exist, or already has an escrow_state or a contractId`,
    );
  }
}

/** One booking the reconciler is allowed to poll, plus the provider wallet
 * its escrow's `receiver`/`serviceProviders`/`releaseSigners` roles must
 * name (Story 1.8's role map) -- resolved once here so
 * `reconciler.ts` never re-joins `provider_profiles` itself. */
export interface ReconcilableBooking {
  booking: BookingRow;
  providerAddress: string;
}

/**
 * Every booking the reconciler may poll this run (AC4, amended
 * 2026-09-19): a persisted `escrowContractId` and an `escrowState` that is
 * not yet terminal (`released`/`refunded`) -- once a booking reaches a
 * terminal state it is never polled again, which is what keeps a stale or
 * out-of-order read-model row from ever regressing it (the I/O matrix's
 * "stale or out-of-order row" guard starts here, at the query itself, not
 * only in the reconciler's own per-row logic).
 */
export async function getReconcilableBookings(db: Db): Promise<ReconcilableBooking[]> {
  const rows = await db
    .select({ booking: bookings, providerAddress: providerProfiles.walletAddress })
    .from(bookings)
    .innerJoin(providerProfiles, eq(bookings.providerProfileId, providerProfiles.id))
    .where(
      and(
        isNotNull(bookings.escrowContractId),
        // `escrowState` starts `null` (before the reconciler's first
        // confirmed transition) and must stay pollable then -- SQL's
        // three-valued logic means a plain `NOT IN` silently excludes NULL
        // rows, which would make the very first "funded" transition
        // unreachable for every booking.
        or(isNull(bookings.escrowState), notInArray(bookings.escrowState, [...TERMINAL_ESCROW_STATES])),
      ),
    );
  return rows.map((row) => ({ booking: row.booking, providerAddress: row.providerAddress }));
}
